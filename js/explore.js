/**
 * ========================================================
 * js/explore.js - 类别探索（全部分区统一单窗口层级折叠手风琴）
 * 核心设计：
 * 1. 包含全部 48+ 官方音乐分区（国语流行、K-Pop、国际流行、粤语流行、嘻哈、排行榜、摇滚等）
 * 2. 彻底去除多余的“专区ID”与文件夹图标，无任何缩进，与“最新发布”统一视觉
 * 3. 都在同一个窗口里展示与就地展开，无任何页面跳转与返回按钮
 * 4. 逐层手风琴折叠：一级分区 -> 二级子分区板块 -> 专辑/歌单卡片（就像最新发布一样）
 * ========================================================
 */

window.ExplorePanel = (function () {
    'use strict';

    let cachedCategories = [];
    // 记录一级专区与二级板块展开状态 (默认全折叠)
    const expandedPartitions = new Set();
    const expandedSubSections = new Set();

    const iconArrowCollapsed = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>`;
    const iconArrowExpanded = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>`;

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
     * 加载全部分类专区列表
     */
    function loadCategories(context) {
        const { containerEl, badgeEl, getStorefront } = context;
        const sf = getStorefront ? getStorefront() : 'cn';
        const cacheKey = `search_categories_${sf}`;

        if (badgeEl) badgeEl.innerText = "正在获取专区...";

        window.swrFetch(`/api/apple_search_page?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                containerEl.innerHTML = '<div class="loading-state">正在获取 Apple 官方分类专区...</div>';
            },
            onCached: (data) => {
                const categories = data?.categories || [];
                renderAllPartitions(categories, context);
            },
            onUpdated: (data) => {
                const categories = data?.categories || [];
                renderAllPartitions(categories, context);
            },
            onError: (err) => {
                containerEl.innerHTML = `<div class="loading-state">❌ 获取分类失败: ${escapeHtml(err.message)}</div>`;
                if (badgeEl) badgeEl.innerText = "0";
            }
        });
    }

    /**
     * 渲染全部 48+ 音乐分区（单窗口内多级手风琴结构）
     * 一级：各专区名称（红色字体，最新发布手风琴风格，默认全折叠）
     * 二级：点击展开后在下方就地展现该专区的子分区（如 🌟 焦点推荐、歌单、明星曲目单、经典专辑等）
     * 三级：子分区再次点击展开具体歌单/专辑卡片（与最新发布 100% 一致的标准卡片形式）
     */
    function renderAllPartitions(categories, context) {
        const { containerEl, badgeEl } = context;
        cachedCategories = categories || [];
        containerEl.innerHTML = "";

        if (cachedCategories.length === 0) {
            containerEl.innerHTML = '<div class="loading-state">暂无可探索分类专区。</div>';
            if (badgeEl) badgeEl.innerText = "0";
            return;
        }

        if (badgeEl) badgeEl.innerText = `${cachedCategories.length} 个分类专区`;

        cachedCategories.forEach((cat, catIdx) => {
            const catKey = `part_${cat.id || cat.title}_${catIdx}`;
            const isCatOpen = expandedPartitions.has(catKey);

            const partBlock = document.createElement("div");
            partBlock.className = "section-accordion-block";

            // 一级分区标题栏：红色字体，最新发布风格
            const partHdr = document.createElement("div");
            partHdr.className = "section-divider section-accordion-hdr";
            partHdr.innerHTML = `
                <div class="section-hdr-left">
                    <span class="section-arrow">${isCatOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span class="section-title-text" style="color: #ff7588; font-size: 11px; font-weight: 700;">${escapeHtml(cat.title)}</span>
                </div>
                <span class="section-count">专区</span>
            `;

            // 一级分区内容体：就在下方就地展开，无任何页面跳转
            const partBody = document.createElement("div");
            partBody.className = `section-body ${isCatOpen ? 'open' : ''}`;

            let isDataLoaded = false;

            const togglePartition = () => {
                if (expandedPartitions.has(catKey)) {
                    expandedPartitions.delete(catKey);
                    partBody.classList.remove("open");
                    const arr = partHdr.querySelector(".section-arrow");
                    if (arr) arr.innerHTML = iconArrowCollapsed;
                } else {
                    expandedPartitions.add(catKey);
                    partBody.classList.add("open");
                    const arr = partHdr.querySelector(".section-arrow");
                    if (arr) arr.innerHTML = iconArrowExpanded;

                    if (!isDataLoaded) {
                        loadPartitionSections(cat, partBody, partHdr, context, () => {
                            isDataLoaded = true;
                        });
                    }
                }
            };

            partHdr.onclick = togglePartition;

            partBlock.appendChild(partHdr);
            partBlock.appendChild(partBody);
            containerEl.appendChild(partBlock);

            // 若之前处于展开状态，则触发数据读取
            if (isCatOpen) {
                loadPartitionSections(cat, partBody, partHdr, context, () => {
                    isDataLoaded = true;
                });
            }
        });
    }

    /**
     * 动态拉取某一专区下的二级子分区数据并就地渲染
     */
    function loadPartitionSections(cat, partBodyEl, partHdrEl, context, onComplete) {
        const { getStorefront } = context;
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
                partBodyEl.innerHTML = `<div class="loading-state" style="padding: 10px 12px; font-size: 10.5px;">正在加载【${escapeHtml(cat.title)}】各板块...</div>`;
            },
            onCached: (data) => {
                renderSubSections(cat, data?.sections || [], partBodyEl, partHdrEl, context);
                if (onComplete) onComplete();
            },
            onUpdated: (data) => {
                renderSubSections(cat, data?.sections || [], partBodyEl, partHdrEl, context);
                if (onComplete) onComplete();
            },
            onError: (err) => {
                partBodyEl.innerHTML = `<div class="loading-state" style="padding: 10px 12px; font-size: 10.5px; color:#ff7588;">❌ 获取板块失败: ${escapeHtml(err.message)}</div>`;
            }
        });
    }

    /**
     * 在分区下方就地渲染二级子分区及三级专辑/歌单卡片（都在一个窗口里，无缩进，无文件夹图标）
     */
    function renderSubSections(cat, sections, partBodyEl, partHdrEl, context) {
        const { createCard } = context;
        partBodyEl.innerHTML = "";

        if (!sections || sections.length === 0) {
            partBodyEl.innerHTML = '<div class="loading-state" style="padding: 8px 12px; font-size: 10px;">暂无板块内容</div>';
            return;
        }

        let totalItems = 0;
        sections.forEach(s => totalItems += (s.items?.length || 0));
        const countSpan = partHdrEl.querySelector(".section-count");
        if (countSpan) countSpan.innerText = `${sections.length} 板块 / ${totalItems} 歌单`;

        sections.forEach((sec, sIdx) => {
            const secTitle = sec.title || "子板块";
            const secItems = sec.items || [];
            if (secItems.length === 0) return;

            const secKey = `sec_${cat.title}_${secTitle}_${sIdx}`;
            const isSubOpen = expandedSubSections.has(secKey);

            const subBlock = document.createElement("div");
            subBlock.className = "section-accordion-block";

            // 二级子分区标题栏（统一最新发布手风琴风格）
            const subHdr = document.createElement("div");
            subHdr.className = "section-divider section-accordion-hdr sub-accordion-hdr";
            subHdr.innerHTML = `
                <div class="section-hdr-left">
                    <span class="section-arrow">${isSubOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span class="section-title-text">${escapeHtml(secTitle)}</span>
                </div>
                <span class="section-count">${secItems.length} 个</span>
            `;

            // 三级卡片容器：点击后展开卡片
            const subBody = document.createElement("div");
            subBody.className = `section-body ${isSubOpen ? 'open' : ''}`;

            subHdr.onclick = (e) => {
                e.stopPropagation();
                if (expandedSubSections.has(secKey)) {
                    expandedSubSections.delete(secKey);
                    subBody.classList.remove("open");
                    const arr = subHdr.querySelector(".section-arrow");
                    if (arr) arr.innerHTML = iconArrowCollapsed;
                } else {
                    expandedSubSections.add(secKey);
                    subBody.classList.add("open");
                    const arr = subHdr.querySelector(".section-arrow");
                    if (arr) arr.innerHTML = iconArrowExpanded;
                }
            };

            // 三级卡片列表（100% 统一为最新发布一样的标准 playlist-card）
            secItems.forEach(item => {
                if (createCard) {
                    const card = createCard(item);
                    subBody.appendChild(card);
                }
            });

            subBlock.appendChild(subHdr);
            subBlock.appendChild(subBody);
            partBodyEl.appendChild(subBlock);
        });
    }

    return {
        loadCategories
    };
})();
