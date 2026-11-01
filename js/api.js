/**
 * ========================================================
 * js/api.js - SWR 轻量缓存与 Apple Music API 网络底座
 * ========================================================
 */

const APPLE_MUSIC_API = "/api/apple/v1/catalog";
let currentStorefront = "cn";
try {
    const savedSf = localStorage.getItem("amusic_storefront");
    if (savedSf) currentStorefront = savedSf;
} catch (e) {}
window.currentStorefront = currentStorefront;

// 客户端轻量持久化缓存引擎 (SWR: Stale-While-Revalidate)
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
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(this.PREFIX)) {
                keys.push(k);
            }
        }
        keys.slice(0, 25).forEach(k => localStorage.removeItem(k));
    }
};

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

// 核心 Apple Music Catalog API 请求函数 (支持 304 快速协商)
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

// 通用工具函数
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
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.innerText = msg;
    toast.classList.add("show");
    setTimeout(() => {
        toast.classList.remove("show");
    }, 2200);
}
