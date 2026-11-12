/**
 * ========================================================
 * 模块：js/charts.js - 国内五大音乐平台榜单专区控制器 (遵照 architecture-charts.md)
 * 命名空间：window.ChartsPanel
 * 依赖协同：window.LeftPanel, window.RightPanel, window.AmusicUtils, window.swrFetch
 * --------------------------------------------------------
 * 职责定位：
 *   1. 企鹅 / 网易 / 酷我 / 酷狗 / 咪咕 5 大平台榜单懒加载拉取与渲染
 *   2. 二级互斥子手风琴（官方核心榜 / 地区与全球榜 / 风格与特色潮流榜）状态调度
 *   3. 点击榜单直达右侧详情（window.RightPanel.selectChartsPlaylist）
 * ========================================================
 */

window.ChartsPanel = (function () {
    'use strict';

    const iconArrowCollapsed = window.AmusicUtils?.ICON_ARROW_COLLAPSED || "▶";
    const iconArrowExpanded = window.AmusicUtils?.ICON_ARROW_EXPANDED || "▼";
    const escapeHtml = (str) => window.AmusicUtils?.escapeHtml ? window.AmusicUtils.escapeHtml(str) : String(str || "");

    // 内存缓存各平台已拉取的榜单分类树
    const catalogCache = new Map();

    // 记录各平台当前展开的二级子分类 (默认展开 core 官方核心榜)
    const activeSubCategories = new Map();

    /**
     * 针对指定平台初始化并渲染榜单专区
     * @param {HTMLElement} containerEl 挂载容器
     * @param {string} platform 平台代码 (qq / wy / kw / kg / mg)
     */
    function initPlatform(containerEl, platform) {
        if (!containerEl) return;
        const plat = (platform || "qq").toLowerCase().trim();

        // 默认该平台展开官方核心榜
        if (!activeSubCategories.has(plat)) {
            activeSubCategories.set(plat, "core");
        }

        // 若已有缓存，直接同步渲染
        if (catalogCache.has(plat)) {
            renderCategories(containerEl, plat, catalogCache.get(plat));
            return;
        }

        // 骨架 / Loading 态
        containerEl.innerHTML = `
            <div style="padding: 16px 12px; font-size: 12px; color: var(--text-muted); text-align: center; display: flex; align-items: center; justify-content: center; gap: 8px;">
                <span class="loading-spinner" style="display:inline-block; width:12px; height:12px; border:2px solid var(--border-subtle); border-top-color:var(--accent); border-radius:50%; animation: spin 0.8s linear infinite;"></span>
                <span>正在获取官方榜单数据...</span>
            </div>
        `;

        const apiUrl = `/api/charts/list?platform=${encodeURIComponent(plat)}`;
        const cacheKey = `charts_list_${plat}`;

        const handleData = (data) => {
            if (data && data.ok && Array.isArray(data.categories)) {
                catalogCache.set(plat, data);
                renderCategories(containerEl, plat, data);
            } else {
                renderError(containerEl, plat, data?.error || "获取榜单列表失败");
            }
        };

        if (window.swrFetch) {
            window.swrFetch(apiUrl, cacheKey, {
                onCached: (data) => handleData(data),
                onUpdated: (data) => handleData(data),
                onError: (err) => {
                    if (!catalogCache.has(plat)) {
                        renderError(containerEl, plat, err.message || "网络请求异常");
                    }
                }
            });
        } else {
            fetch(apiUrl)
                .then(r => r.json())
                .then(handleData)
                .catch(err => {
                    renderError(containerEl, plat, err.message || "网络请求异常");
                });
        }
    }

    /**
     * 渲染三级互斥子分类手风琴
     */
    function renderCategories(containerEl, platform, catalogData) {
        containerEl.innerHTML = "";
        const categories = catalogData.categories || [];
        if (categories.length === 0) {
            containerEl.innerHTML = `<div style="padding: 12px; font-size: 12px; color: var(--text-muted); text-align: center;">暂无榜单数据</div>`;
            return;
        }

        const platformName = catalogData.platformName || platform;
        const currentActiveKey = activeSubCategories.get(platform) || "core";

        // 用于保存该平台下所有子分类的 bodyEl 与 hdrEl，实现平滑互斥折叠
        const subAccElements = [];

        categories.forEach(cat => {
            const catKey = cat.key || "core";
            const catName = cat.name || "官方榜单";
            const lists = cat.lists || [];
            const isOpen = currentActiveKey === catKey;

            const block = document.createElement("div");
            block.className = "sub-accordion-block";

            const hdr = document.createElement("div");
            hdr.className = `sub-accordion-hdr level-3 ${isOpen ? 'open' : ''}`;
            hdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isOpen ? 'open' : ''}">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span>${escapeHtml(catName)}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">${lists.length} 榜</div>
            `;

            const body = document.createElement("div");
            body.className = `sub-accordion-body ${isOpen ? 'open' : ''}`;

            // 渲染该分类下的卡片网格
            const cardsContainer = document.createElement("div");
            cardsContainer.className = "charts-cards-container";
            cardsContainer.style.cssText = "padding: 6px 0;";

            lists.forEach(item => {
                const cardData = {
                    id: `chart_${platform}_${item.id}`,
                    title: item.title,
                    name: item.title,
                    curator: item.updateFrequency || (platformName + "官方榜"),
                    platform: "charts",
                    chartPlatform: platform,
                    chartId: item.id,
                    coverUrl: item.cover || "",
                    url: "",
                    trackCount: 0
                };

                let cardEl;
                if (window.LeftPanel?.createPlaylistCard) {
                    cardEl = window.LeftPanel.createPlaylistCard(cardData, {
                        isFav: window.StorageManager?.isPlaylistFaved?.(cardData.id)
                    });
                } else {
                    cardEl = document.createElement("div");
                    cardEl.className = "playlist-card";
                    cardEl.innerText = item.title;
                    cardEl.onclick = () => {
                        window.RightPanel?.selectChartsPlaylist?.(platform, item.id, item.title, cardData.curator, item.cover);
                    };
                }
                cardsContainer.appendChild(cardEl);
            });

            body.appendChild(cardsContainer);

            // 注册到互斥元素表
            subAccElements.push({
                key: catKey,
                hdrEl: hdr,
                bodyEl: body,
                arrowEl: hdr.querySelector(".sub-accordion-arrow")
            });

            // 点击二级手风琴实现平台内全局互斥折叠
            hdr.onclick = () => {
                const isCurrentlyOpen = activeSubCategories.get(platform) === catKey;
                if (isCurrentlyOpen) {
                    // 允许收起当前分类
                    activeSubCategories.delete(platform);
                    body.classList.remove("open");
                    hdr.classList.remove("open");
                    const arr = hdr.querySelector(".sub-accordion-arrow");
                    if (arr) {
                        arr.classList.remove("open");
                        arr.innerHTML = iconArrowCollapsed;
                    }
                } else {
                    // 展开当前分类，并自动收缩同平台内其他已展开的子手风琴 (互斥)
                    activeSubCategories.set(platform, catKey);
                    subAccElements.forEach(acc => {
                        if (acc.key === catKey) {
                            acc.bodyEl.classList.add("open");
                            acc.hdrEl.classList.add("open");
                            if (acc.arrowEl) {
                                acc.arrowEl.classList.add("open");
                                acc.arrowEl.innerHTML = iconArrowExpanded;
                            }
                        } else {
                            acc.bodyEl.classList.remove("open");
                            acc.hdrEl.classList.remove("open");
                            if (acc.arrowEl) {
                                acc.arrowEl.classList.remove("open");
                                acc.arrowEl.innerHTML = iconArrowCollapsed;
                            }
                        }
                    });
                }
            };

            block.appendChild(hdr);
            block.appendChild(body);
            containerEl.appendChild(block);
        });
    }

    function renderError(containerEl, platform, errMsg) {
        containerEl.innerHTML = `
            <div style="padding: 16px 12px; font-size: 12px; color: var(--text-muted); text-align: center;">
                <p style="margin: 0 0 8px 0; color: #ff6b6b;">⚠️ 加载榜单失败: ${escapeHtml(errMsg)}</p>
                <button type="button" class="btn-refresh-charts" style="background: var(--bg-surface); border: 1px solid var(--border-subtle); color: var(--text-primary); border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer;">重试</button>
            </div>
        `;
        containerEl.querySelector(".btn-refresh-charts")?.addEventListener("click", () => {
            initPlatform(containerEl, platform);
        });
    }

    return {
        initPlatform
    };
})();
