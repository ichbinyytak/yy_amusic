/**
 * ========================================================
 * 模块：js/region.js - 区域板块与官方分类控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.RegionPanel
 * 依赖协同：window.currentStorefront, window.swrFetch, window.RightPanel
 * --------------------------------------------------------
 * 职责定位：
 *   1. 6大地区切换 (中国大陆|香港|台湾|美国|日本|英国) - 紧凑微型下拉
 *   2. 最新发布 (/new 13个音乐板块手风琴展开)
 *   3. 类别探索 (/search 48+ 官方音乐专区与排行榜多层就地展开)
 *   4. 严格执行按需懒加载 (Lazy Loading) 与 SWR 缓存
 * --------------------------------------------------------
 * 功能目录：
 *   1. 初始化与地区切换 (init / getStorefront)
 *   2. 区域骨架手风琴渲染 (renderRegion - 最新发布与类别探索双抽屉)
 *   3. 最新发布 13 音乐板块加载 (loadNewPage / renderNewSections)
 *   4. 类别探索 48+ 专区与二级嵌套展开 (loadCategories / renderAllPartitions / loadPartitionSections)
 * ========================================================
 */

window.RegionPanel = (function () {
    'use strict';

    let regionContainerEl = null;
    let storefrontSelectEl = null;

    // 展开状态记录 (默认展开最新发布)
    const expandedSections = new Set(["region_new_tab"]);
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

    function cleanZoneTitle(str) {
        if (!str) return "";
        return String(str).replace(/(?:专区|板块)/g, "").trim();
    }

    function getStorefront() {
        return window.currentStorefront || (storefrontSelectEl ? storefrontSelectEl.value : "cn") || "cn";
    }

    /* ========================================================
     * 区块 1: 初始化与地区切换事件绑定
     * ======================================================== */
    function init(containerEl, selectEl) {
        regionContainerEl = containerEl;
        storefrontSelectEl = selectEl;

        if (storefrontSelectEl) {
            storefrontSelectEl.value = getStorefront();
            storefrontSelectEl.addEventListener("change", (e) => {
                const sf = e.target.value;
                window.currentStorefront = sf;
                try { localStorage.setItem("amusic_storefront", sf); } catch (err) {}
                renderRegion();
            });
        }

        renderRegion();
    }

    /* ========================================================
     * 区块 2: 区域手风琴骨架渲染 (最新发布与类别探索双抽屉)
     * ======================================================== */
    function renderRegion() {
        if (!regionContainerEl) return;
        regionContainerEl.innerHTML = "";

        // 1. 最新发布子板块手风琴
        const newSecBlock = document.createElement("div");
        newSecBlock.className = "sub-accordion-block";

        const isNewOpen = expandedSections.has("region_new_tab");
        const newHdr = document.createElement("div");
        newHdr.className = `sub-accordion-hdr ${isNewOpen ? 'open' : ''}`;
        newHdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow ${isNewOpen ? 'open' : ''}">${isNewOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>最新发布</span>
            </div>
            <span class="count-badge" id="badgeNewSections">13</span>
        `;

        const newBody = document.createElement("div");
        newBody.className = `sub-accordion-body ${isNewOpen ? 'open' : ''}`;

        let newLoaded = false;
        newHdr.onclick = () => {
            if (expandedSections.has("region_new_tab")) {
                expandedSections.delete("region_new_tab");
                newBody.classList.remove("open");
                newHdr.classList.remove("open");
                const arrow = newHdr.querySelector(".sub-accordion-arrow");
                arrow.classList.remove("open");
                arrow.innerHTML = iconArrowCollapsed;
            } else {
                expandedSections.add("region_new_tab");
                newBody.classList.add("open");
                newHdr.classList.add("open");
                const arrow = newHdr.querySelector(".sub-accordion-arrow");
                arrow.classList.add("open");
                arrow.innerHTML = iconArrowExpanded;
                if (!newLoaded) {
                    loadNewPage(newBody);
                    newLoaded = true;
                }
            }
        };

        if (isNewOpen) {
            loadNewPage(newBody);
            newLoaded = true;
        }

        newSecBlock.appendChild(newHdr);
        newSecBlock.appendChild(newBody);
        regionContainerEl.appendChild(newSecBlock);

        // 2. 类别探索子板块手风琴 (48+ 专区与排行榜)
        const exploreSecBlock = document.createElement("div");
        exploreSecBlock.className = "sub-accordion-block";

        const isExploreOpen = expandedSections.has("region_explore_tab");
        const exploreHdr = document.createElement("div");
        exploreHdr.className = `sub-accordion-hdr ${isExploreOpen ? 'open' : ''}`;
        exploreHdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow ${isExploreOpen ? 'open' : ''}">${isExploreOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>类别探索</span>
            </div>
            <span class="count-badge" id="badgeExploreCategories">48+</span>
        `;

        const exploreBody = document.createElement("div");
        exploreBody.className = `sub-accordion-body ${isExploreOpen ? 'open' : ''}`;

        let exploreLoaded = false;
        exploreHdr.onclick = () => {
            if (expandedSections.has("region_explore_tab")) {
                expandedSections.delete("region_explore_tab");
                exploreBody.classList.remove("open");
                exploreHdr.classList.remove("open");
                const arrow = exploreHdr.querySelector(".sub-accordion-arrow");
                arrow.classList.remove("open");
                arrow.innerHTML = iconArrowCollapsed;
            } else {
                expandedSections.add("region_explore_tab");
                exploreBody.classList.add("open");
                exploreHdr.classList.add("open");
                const arrow = exploreHdr.querySelector(".sub-accordion-arrow");
                arrow.classList.add("open");
                arrow.innerHTML = iconArrowExpanded;
                if (!exploreLoaded) {
                    loadCategories(exploreBody);
                    exploreLoaded = true;
                }
            }
        };

        if (isExploreOpen) {
            loadCategories(exploreBody);
            exploreLoaded = true;
        }

        exploreSecBlock.appendChild(exploreHdr);
        exploreSecBlock.appendChild(exploreBody);
        regionContainerEl.appendChild(exploreSecBlock);
    }

    /* ========================================================
     * 区块 3: 最新发布 13 音乐板块按需懒加载 (SWR 缓存)
     * ======================================================== */
    function loadNewPage(bodyEl) {
        const sf = getStorefront();
        const cacheKey = `new_page_${sf}`;

        window.swrFetch(`/api/apple_new?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                bodyEl.innerHTML = '<div class="loading-state">正在获取最新发布板块...</div>';
            },
            onCached: (data) => {
                renderNewSections(data?.sections || [], bodyEl);
            },
            onUpdated: (data) => {
                renderNewSections(data?.sections || [], bodyEl);
            },
            onError: (err) => {
                bodyEl.innerHTML = `<div class="loading-state">获取最新发布失败: ${escapeHtml(err.message)}</div>`;
            }
        });
    }

    function renderNewSections(sections, containerEl) {
        containerEl.innerHTML = "";
        if (!sections || sections.length === 0) {
            containerEl.innerHTML = '<div class="loading-state">暂无最新发布数据。</div>';
            return;
        }

        const badgeEl = document.getElementById("badgeNewSections");
        if (badgeEl) badgeEl.innerText = `${sections.length}`;

        sections.forEach((sec, idx) => {
            const secTitle = cleanZoneTitle(sec.title || "推荐");
            const secItems = sec.items || [];
            if (secItems.length === 0) return;

            const secKey = `new_sec_${idx}_${secTitle}`;
            if (idx === 0 && !expandedSections.has("__has_init_first_sec__")) {
                expandedSections.add(secKey);
                expandedSections.add("__has_init_first_sec__");
            }
            const isExpanded = expandedSections.has(secKey);

            const block = document.createElement("div");
            block.className = "sub-accordion-block";

            const hdr = document.createElement("div");
            hdr.className = `sub-accordion-hdr level-3 ${isExpanded ? 'open' : ''}`;
            hdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isExpanded ? 'open' : ''}">${isExpanded ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span>${escapeHtml(secTitle)}</span>
                </div>
                <span class="count-badge">${secItems.length}</span>
            `;

            const body = document.createElement("div");
            body.className = `sub-accordion-body ${isExpanded ? 'open' : ''}`;

            hdr.onclick = () => {
                if (expandedSections.has(secKey)) {
                    expandedSections.delete(secKey);
                    body.classList.remove("open");
                    hdr.classList.remove("open");
                    const arrow = hdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.remove("open");
                    arrow.innerHTML = iconArrowCollapsed;
                } else {
                    expandedSections.add(secKey);
                    body.classList.add("open");
                    hdr.classList.add("open");
                    const arrow = hdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.add("open");
                    arrow.innerHTML = iconArrowExpanded;
                }
            };

            secItems.forEach(item => {
                const card = window.LeftPanel.createPlaylistCard(item);
                body.appendChild(card);
            });

            block.appendChild(hdr);
            block.appendChild(body);
            containerEl.appendChild(block);
        });
    }

    /* ========================================================
     * 区块 4: 类别探索 48+ 专区与二级多层折叠展开
     * ======================================================== */
    function loadCategories(bodyEl) {
        const sf = getStorefront();
        const cacheKey = `search_categories_${sf}`;

        window.swrFetch(`/api/apple_search_page?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                bodyEl.innerHTML = '<div class="loading-state">正在获取全部分类...</div>';
            },
            onCached: (data) => {
                renderAllPartitions(data?.categories || [], bodyEl);
            },
            onUpdated: (data) => {
                renderAllPartitions(data?.categories || [], bodyEl);
            },
            onError: (err) => {
                bodyEl.innerHTML = `<div class="loading-state">获取分类失败: ${escapeHtml(err.message)}</div>`;
            }
        });
    }

    function renderAllPartitions(categories, containerEl) {
        containerEl.innerHTML = "";
        if (!categories || categories.length === 0) {
            containerEl.innerHTML = '<div class="loading-state">暂无分类数据。</div>';
            return;
        }

        const badgeEl = document.getElementById("badgeExploreCategories");
        if (badgeEl) badgeEl.innerText = `${categories.length}`;

        categories.forEach((cat, catIdx) => {
            const catKey = `part_${cat.id || cat.title}_${catIdx}`;
            const isCatOpen = expandedPartitions.has(catKey);

            const partBlock = document.createElement("div");
            partBlock.className = "sub-accordion-block";

            const cleanCatTitle = cleanZoneTitle(cat.title);

            const partHdr = document.createElement("div");
            partHdr.className = `sub-accordion-hdr level-3 ${isCatOpen ? 'open' : ''}`;
            partHdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isCatOpen ? 'open' : ''}">${isCatOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span>${escapeHtml(cleanCatTitle)}</span>
                </div>
                <span class="count-badge" id="badge_cat_${catIdx}">${cat.count || ''}</span>
            `;

            const partBody = document.createElement("div");
            partBody.className = `sub-accordion-body ${isCatOpen ? 'open' : ''}`;

            let isDataLoaded = false;

            const togglePartition = () => {
                if (expandedPartitions.has(catKey)) {
                    expandedPartitions.delete(catKey);
                    partBody.classList.remove("open");
                    partHdr.classList.remove("open");
                    const arrow = partHdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.remove("open");
                    arrow.innerHTML = iconArrowCollapsed;
                } else {
                    expandedPartitions.add(catKey);
                    partBody.classList.add("open");
                    partHdr.classList.add("open");
                    const arrow = partHdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.add("open");
                    arrow.innerHTML = iconArrowExpanded;

                    if (!isDataLoaded) {
                        loadPartitionSections(cat, partBody, (data) => {
                            isDataLoaded = true;
                            const totalItems = (data?.sections || []).reduce((acc, s) => acc + (s.items?.length || 0), 0);
                            const badge = document.getElementById(`badge_cat_${catIdx}`);
                            if (badge && totalItems > 0) {
                                badge.innerText = totalItems;
                            }
                        });
                    }
                }
            };

            partHdr.onclick = togglePartition;

            partBlock.appendChild(partHdr);
            partBlock.appendChild(partBody);
            containerEl.appendChild(partBlock);

            if (isCatOpen) {
                loadPartitionSections(cat, partBody, (data) => {
                    isDataLoaded = true;
                    const totalItems = (data?.sections || []).reduce((acc, s) => acc + (s.items?.length || 0), 0);
                    const badge = document.getElementById(`badge_cat_${catIdx}`);
                    if (badge && totalItems > 0) {
                        badge.innerText = totalItems;
                    }
                });
            }
        });
    }

    /**
     * 动态拉取某一分类下的二级子分区
     */
    function loadPartitionSections(cat, partBodyEl, onComplete) {
        const sf = getStorefront();
        const isChart = cat.title === "排行榜" || cat.id === "1514706977" || (cat.url && (cat.url.includes("viewTop") || cat.url.includes("top-charts")));
        const curatorUrl = isChart
            ? `https://music.apple.com/${sf}/new/top-charts`
            : (cat.url || `https://music.apple.com/${sf}/curator/${encodeURIComponent(cat.title)}/${cat.id}`);
        const cacheKey = isChart ? `chart_page_${sf}` : `curator_${sf}_${cat.id || cat.title}`;

        window.swrFetch(`/api/apple_curator_page?url=${encodeURIComponent(curatorUrl)}`, cacheKey, {
            showLoading: () => {
                partBodyEl.innerHTML = '<div class="loading-state" style="padding:10px;">正在加载内容...</div>';
            },
            onCached: (data) => {
                renderSubSections(data?.sections || [], partBodyEl, cat.title);
                if (onComplete) onComplete(data);
            },
            onUpdated: (data) => {
                renderSubSections(data?.sections || [], partBodyEl, cat.title);
                if (onComplete) onComplete(data);
            },
            onError: (err) => {
                partBodyEl.innerHTML = `<div class="loading-state" style="padding:10px;">❌ 加载失败: ${escapeHtml(err.message)}</div>`;
                if (onComplete) onComplete(null);
            }
        });
    }

    function renderSubSections(sections, partBodyEl, parentTitle) {
        partBodyEl.innerHTML = "";
        if (!sections || sections.length === 0) {
            partBodyEl.innerHTML = '<div class="loading-state" style="padding:10px;">暂未收录更多子内容。</div>';
            return;
        }

        sections.forEach((sec, sIdx) => {
            const secItems = sec.items || [];
            if (secItems.length === 0) return;

            const secTitle = cleanZoneTitle(sec.title || `推荐 ${sIdx + 1}`);
            const subKey = `sub_${parentTitle}_${secTitle}_${sIdx}`;
            const isSubOpen = expandedSubSections.has(subKey);

            const subBlock = document.createElement("div");
            subBlock.className = "sub-accordion-block";

            const subHdr = document.createElement("div");
            subHdr.className = `sub-accordion-hdr level-4 ${isSubOpen ? 'open' : ''}`;
            subHdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isSubOpen ? 'open' : ''}">${isSubOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span style="color:var(--text-secondary); font-size:var(--fs-t3);">${escapeHtml(secTitle)}</span>
                </div>
                <span class="count-badge">${secItems.length}</span>
            `;

            const subBody = document.createElement("div");
            subBody.className = `sub-accordion-body ${isSubOpen ? 'open' : ''}`;

            subHdr.onclick = () => {
                if (expandedSubSections.has(subKey)) {
                    expandedSubSections.delete(subKey);
                    subBody.classList.remove("open");
                    subHdr.classList.remove("open");
                    const arrow = subHdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.remove("open");
                    arrow.innerHTML = iconArrowCollapsed;
                } else {
                    expandedSubSections.add(subKey);
                    subBody.classList.add("open");
                    subHdr.classList.add("open");
                    const arrow = subHdr.querySelector(".sub-accordion-arrow");
                    arrow.classList.add("open");
                    arrow.innerHTML = iconArrowExpanded;
                }
            };

            secItems.forEach(item => {
                const card = window.LeftPanel.createPlaylistCard(item);
                subBody.appendChild(card);
            });

            subBlock.appendChild(subHdr);
            subBlock.appendChild(subBody);
            partBodyEl.appendChild(subBlock);
        });
    }

    return {
        init,
        renderRegion,
        getStorefront
    };
})();
