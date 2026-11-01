/**
 * ========================================================
 * js/explore.js - Apple Music 50+ 官方专区与排行榜探索模块
 * 负责：
 * 1. 抓取与展示 Apple 官方 50+ 音乐专区与排行榜入口
 * 2. 专区主页 / 排行榜官方歌单与合集下钻展示
 * ========================================================
 */

window.ExplorePanel = (function () {
    'use strict';

    let cachedCategories = [];

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * 加载官方 50+ 分类专区列表
     */
    function loadCategories(context) {
        const { containerEl, badgeEl, renderSections, getStorefront } = context;
        const sf = getStorefront ? getStorefront() : 'cn';
        const cacheKey = `search_categories_${sf}`;

        window.swrFetch(`/api/apple_search_page?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                containerEl.innerHTML = '<div class="loading-state">正在获取 Apple 官方全部分类专区...</div>';
                if (badgeEl) badgeEl.innerText = "...";
            },
            onCached: (data) => {
                const categories = data?.categories || [];
                renderCategories(categories, context);
            },
            onUpdated: (data) => {
                const categories = data?.categories || [];
                renderCategories(categories, context);
            },
            onError: (err) => {
                containerEl.innerHTML = `<div class="loading-state">❌ 获取分类失败: ${escapeHtml(err.message)}</div>`;
                if (badgeEl) badgeEl.innerText = "0";
            }
        });
    }

    /**
     * 渲染专区卡片列表
     */
    function renderCategories(categories, context) {
        const { containerEl, badgeEl } = context;
        cachedCategories = categories || [];
        containerEl.innerHTML = "";

        if (cachedCategories.length === 0) {
            containerEl.innerHTML = '<div class="loading-state">暂无可探索分类专区。</div>';
            if (badgeEl) badgeEl.innerText = "0";
            return;
        }

        if (badgeEl) badgeEl.innerText = `${cachedCategories.length} 个专区`;

        const divHeader = document.createElement("div");
        divHeader.className = "section-divider";
        divHeader.innerHTML = `<span>📂 Apple 官方 50 大音乐专区</span><span class="section-count">${cachedCategories.length} 个</span>`;
        containerEl.appendChild(divHeader);

        cachedCategories.forEach(cat => {
            const card = document.createElement("div");
            card.className = "playlist-card";
            card.innerHTML = `
                <div class="playlist-title-row">
                    <span class="playlist-name">🏷️ ${escapeHtml(cat.title)}</span>
                    <span class="playlist-curator">Apple 专区 ›</span>
                </div>
                <div class="playlist-meta-row">
                    <span>${cat.id ? '专区 ID: ' + escapeHtml(cat.id) : '官方精选收录'}</span>
                </div>
            `;
            card.addEventListener("click", () => openCategoryPlaylists(cat, context));
            containerEl.appendChild(card);
        });
    }

    /**
     * 打开具体专区 (如国语流行、排行榜、摇滚等) 的板块歌单
     */
    function openCategoryPlaylists(cat, context) {
        const { containerEl, badgeEl, titleEl, renderSections, getStorefront } = context;
        if (titleEl) titleEl.innerText = `专区: ${cat.title}`;
        containerEl.innerHTML = `<div class="loading-state">正在加载【${escapeHtml(cat.title)}】官方歌单...</div>`;
        if (badgeEl) badgeEl.innerText = "...";

        const sf = getStorefront ? getStorefront() : 'cn';
        const isChart = cat.title === "排行榜" || cat.id === "1514706977" || (cat.url && (cat.url.includes("viewTop") || cat.url.includes("top-charts")));
        const curatorUrl = isChart
            ? `https://music.apple.com/${sf}/new/top-charts`
            : (cat.url || `https://music.apple.com/${sf}/curator/${encodeURIComponent(cat.title)}/${cat.id}`);
        const cacheKey = isChart
            ? `cat_playlists_${sf}_top_charts_v2`
            : `cat_playlists_${sf}_${cat.id || encodeURIComponent(cat.title)}`;

        window.swrFetch(`/api/apple_curator_page?url=${encodeURIComponent(curatorUrl)}`, cacheKey, {
            showLoading: () => {
                containerEl.innerHTML = `<div class="loading-state">正在加载【${escapeHtml(cat.title)}】官方歌单...</div>`;
            },
            onCached: (data) => {
                const sections = data?.sections || [];
                if (renderSections) renderSections(sections, true);
            },
            onUpdated: (data) => {
                const sections = data?.sections || [];
                if (renderSections) renderSections(sections, true);
            },
            onError: (err) => {
                containerEl.innerHTML = `
                    <div class="placeholder-box" style="padding: 20px 10px;">
                        <p>❌ 加载专区失败: ${escapeHtml(err.message)}</p>
                        <button class="btn btn-sm btn-outline" id="btnBackToExplore" style="margin-top: 8px;">‹ 返回专区列表</button>
                    </div>
                `;
                const btn = document.getElementById("btnBackToExplore");
                if (btn && context.reloadExplore) {
                    btn.addEventListener("click", () => context.reloadExplore());
                }
            }
        });
    }

    return {
        loadCategories,
        renderCategories,
        openCategoryPlaylists
    };
})();
