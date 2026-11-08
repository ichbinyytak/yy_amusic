/**
 * ========================================================
 * 模块：js/api.js - SWR 缓存与 Apple Music API 网络底座 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.ClientCache, window.swrFetch, window.apiRequest, window.escapeHtml, window.formatDuration
 * 依赖协同：原生 fetch / localStorage，服务于全站所有网络交互模块
 * --------------------------------------------------------
 * 核心特性：
 *   1. 客户端 SWR (Stale-While-Revalidate) 缓存与严格 LRU 淘汰
 *   2. ETag / If-None-Match 304 快速协商，0 冗余带宽
 *   3. Apple Music Catalog API 直连调度
 * --------------------------------------------------------
 * 功能目录：
 *   1. 客户端 LRU 缓存引擎 (ClientCache)
 *   2. SWR 验鲜请求驱动 (swrFetch)
 *   3. Apple Catalog 请求器 (apiRequest)
 *   4. 通用基础工具函数 (escapeHtml / formatDuration / showToast)
 * ========================================================
 */

const APPLE_MUSIC_API = "/api/apple/v1/catalog";
let currentStorefront = "cn";
try {
    const savedSf = localStorage.getItem("amusic_storefront");
    if (savedSf) currentStorefront = savedSf;
} catch (e) {}
window.currentStorefront = currentStorefront;

/* ========================================================
 * 区块 1: 客户端轻量持久化缓存引擎 (SWR + LRU 淘汰)
 * ======================================================== */
const ClientCache = {
    PREFIX: 'amusic_swr_',

    get(key) {
        try {
            const raw = localStorage.getItem(this.PREFIX + key);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    },

    set(key, data, etag = '') {
        try {
            localStorage.setItem(this.PREFIX + key, JSON.stringify({
                data,
                etag: etag || '',
                time: Date.now()
            }));
        } catch (e) {
            this.cleanOldest();
            try {
                localStorage.setItem(this.PREFIX + key, JSON.stringify({ data, etag: etag || '', time: Date.now() }));
            } catch (err) {}
        }
    },

    cleanOldest() {
        const entries = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(this.PREFIX)) {
                try {
                    const raw = localStorage.getItem(k);
                    const parsed = JSON.parse(raw);
                    entries.push({ key: k, time: (parsed && parsed.time) ? parsed.time : 0 });
                } catch (e) {
                    entries.push({ key: k, time: 0 });
                }
            }
        }
        // 按 time 升序排序：最久远、最陈旧的数据排在最前面
        entries.sort((a, b) => a.time - b.time);
        // 严格 LRU 淘汰最老旧的前 25 个条目，坚决保护活跃缓存
        entries.slice(0, 25).forEach(item => localStorage.removeItem(item.key));
    }
};

/* ========================================================
 * 区块 2: SWR 验鲜网络请求驱动器 (ETag 协商)
 * ======================================================== */
/**
 * 通用 SWR 网络请求器：
 * 优先使用客户端本地缓存 0ms 秒开；后台携带 If-None-Match 向服务端验鲜 (304 / 200)
 */
async function swrFetch(url, cacheKey, { onCached, onUpdated, onError, showLoading }) {
    const cached = ClientCache.get(cacheKey);
    let hasRenderedCached = false;

    if (cached && cached.data) {
        hasRenderedCached = true;
        try {
            onCached(cached.data, cached.time);
        } catch (e) {
            console.warn("渲染本地缓存失败", e);
        }
    } else if (showLoading) {
        showLoading();
    }

    try {
        const headers = {};
        if (cached && cached.etag) {
            headers["If-None-Match"] = cached.etag;
        }

        const res = await fetch(url, { headers });
        if (res.status === 304) {
            return; // 304 未更改，本地缓存即最新
        }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const freshData = await res.json();
        const freshEtag = res.headers.get("ETag") || '';
        ClientCache.set(cacheKey, freshData, freshEtag);

        if (onUpdated) {
            onUpdated(freshData, hasRenderedCached);
        }
    } catch (err) {
        if (!hasRenderedCached && onError) {
            onError(err);
        }
    }
}

/* ========================================================
 * 区块 3: Apple Music Catalog 目录网络网关
 * ======================================================== */
async function apiRequest(endpoint, etag = '') {
    try {
        const headers = {};
        if (etag) headers["If-None-Match"] = etag;

        const sf = window.currentStorefront || currentStorefront || "cn";
        const response = await fetch(`${APPLE_MUSIC_API}/${sf}/${endpoint}`, { headers });
        if (response.status === 304) {
            return 304;
        }
        if (!response.ok) {
            throw new Error(`Apple Music API HTTP ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        console.error("Apple Music API Error:", err);
        throw err;
    }
}

/* ========================================================
 * 区块 4: 全局基础通用工具箱与命名空间挂载
 * ======================================================== */
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatDuration(millis) {
    if (!millis || isNaN(millis)) return "00:00";
    const totalSec = Math.floor(millis / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function showToast(msg) {
    if (window.Shell && window.Shell.showToast) {
        window.Shell.showToast(msg);
        return;
    }
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add("show");
    setTimeout(() => {
        toast.classList.remove("show");
    }, 2200);
}

// 统一前端轻量事件总线 (支持解耦模块间相互直接调用)
const EventBus = {
    _events: {},
    on(event, callback) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(callback);
    },
    off(event, callback) {
        if (!this._events[event]) return;
        this._events[event] = this._events[event].filter(cb => cb !== callback);
    },
    emit(event, data) {
        if (!this._events[event]) return;
        this._events[event].forEach(cb => {
            try { cb(data); } catch (e) { console.error(`[EventBus] ${event} error:`, e); }
        });
    }
};

EventBus.on("toast", (msg) => {
    showToast(msg);
});

// 明确暴露至全局 window 命名空间
window.ClientCache = ClientCache;
window.swrFetch = swrFetch;
window.apiRequest = apiRequest;
window.escapeHtml = escapeHtml;
window.formatDuration = formatDuration;
window.showToast = showToast;
window.EventBus = EventBus;
