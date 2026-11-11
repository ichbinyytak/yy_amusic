/**
 * ========================================================
 * 模块：js/streetvoice.js - 街声 StreetVoice 专区控制器 (遵照 architecture-sv.md)
 * 命名空间：window.StreetVoicePanel
 * 依赖协同：window.LeftPanel, window.RightPanel, window.swrFetch
 * --------------------------------------------------------
 * 职责定位：
 *   1. 官方排行榜 (15 榜 × Top 50: 即时排行 8 榜 + 每周排行 7 榜)
 *   2. 精选歌单广场 (精选推荐 63 部 + 7 大主题分区懒加载与分页)
 * ========================================================
 */

window.StreetVoicePanel = (function () {
    'use strict';

    let svContainerEl = null;

    const expandedSections = new Set(["sv_charts_tab"]);
    const expandedChartGroups = new Set(["sv_group_realtime"]);
    const expandedPlaylistSections = new Set();

    const iconArrowCollapsed = window.AmusicUtils.ICON_ARROW_COLLAPSED;
    const iconArrowExpanded = window.AmusicUtils.ICON_ARROW_EXPANDED;

    const FALLBACK_CHARTS = [
        { id: "sv_chart_realtime_all", kind: "realtime", category: "all", group: "即时排行", title: "即时榜 · 总榜" },
        { id: "sv_chart_realtime_rock", kind: "realtime", category: "rock", group: "即时排行", title: "即时榜 · 摇滚" },
        { id: "sv_chart_realtime_folk", kind: "realtime", category: "folk", group: "即时排行", title: "即时榜 · 民谣" },
        { id: "sv_chart_realtime_hip_hop", kind: "realtime", category: "hip_hop", group: "即时排行", title: "即时榜 · 嘻哈" },
        { id: "sv_chart_realtime_urban", kind: "realtime", category: "urban", group: "即时排行", title: "即时榜 · 都会" },
        { id: "sv_chart_realtime_electronic", kind: "realtime", category: "electronic", group: "即时排行", title: "即时榜 · 电子" },
        { id: "sv_chart_realtime_explore", kind: "realtime", category: "explore", group: "即时排行", title: "即时榜 · 探索" },
        { id: "sv_chart_realtime_ai_generated", kind: "realtime", category: "ai_generated", group: "即时排行", title: "即时榜 · AI 生成" },
        { id: "sv_chart_weekly_all", kind: "weekly", category: "all", group: "每周排行", title: "每周榜 · 总榜" },
        { id: "sv_chart_weekly_rock", kind: "weekly", category: "rock", group: "每周排行", title: "每周榜 · 摇滚" },
        { id: "sv_chart_weekly_folk", kind: "weekly", category: "folk", group: "每周排行", title: "每周榜 · 民谣" },
        { id: "sv_chart_weekly_hip_hop", kind: "weekly", category: "hip_hop", group: "每周排行", title: "每周榜 · 嘻哈" },
        { id: "sv_chart_weekly_urban", kind: "weekly", category: "urban", group: "每周排行", title: "每周榜 · 都会" },
        { id: "sv_chart_weekly_electronic", kind: "weekly", category: "electronic", group: "每周排行", title: "每周榜 · 电子" },
        { id: "sv_chart_weekly_explore", kind: "weekly", category: "explore", group: "每周排行", title: "每周榜 · 探索" }
    ];

    const FALLBACK_SECTIONS = [
        { id: "all", title: "精选推荐", count_hint: 63 },
        { id: "1", title: "特别企划", count_hint: 338 },
        { id: "chillouttree", title: "小树精选", count_hint: 132 },
        { id: "DJ", title: "驻站 DJ", count_hint: 41 },
        { id: "campus", title: "校园推广", count_hint: 41 },
        { id: "2style", title: "热推", count_hint: 20 },
        { id: "situation", title: "情境", count_hint: 11 },
        { id: "7", title: "街头自选集", count_hint: 20 }
    ];

    let catalogData = {
        charts: FALLBACK_CHARTS,
        sections: FALLBACK_SECTIONS
    };

    const escapeHtml = (str) => window.AmusicUtils.escapeHtml(str);

    function init(containerEl) {
        svContainerEl = containerEl;
        renderStreetVoice();

        window.swrFetch("/api/sv_charts", "sv_chart_catalog_v1", {
            onCached: (data) => {
                if (data && Array.isArray(data.charts) && Array.isArray(data.sections)) {
                    catalogData = data;
                    renderStreetVoice();
                }
            },
            onUpdated: (data, hadCache) => {
                if (data && Array.isArray(data.charts) && Array.isArray(data.sections)) {
                    catalogData = data;
                    if (!hadCache) renderStreetVoice();
                }
            }
        });
    }

    function renderStreetVoice() {
        if (!svContainerEl) return;
        svContainerEl.innerHTML = "";

        // 1. 官方排行榜（默认展开）
        const chartsBlock = document.createElement("div");
        chartsBlock.className = "sub-accordion-block";
        const isChartsOpen = expandedSections.has("sv_charts_tab");

        const chartsHdr = document.createElement("div");
        chartsHdr.className = `sub-accordion-hdr ${isChartsOpen ? 'open' : ''}`;
        chartsHdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow ${isChartsOpen ? 'open' : ''}">${isChartsOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>官方排行榜</span>
            </div>
            <span class="count-badge">${(catalogData.charts || FALLBACK_CHARTS).length}</span>
        `;

        const chartsBody = document.createElement("div");
        chartsBody.className = `sub-accordion-body ${isChartsOpen ? 'open' : ''}`;

        chartsHdr.onclick = () => {
            const openNow = !expandedSections.has("sv_charts_tab");
            if (openNow) expandedSections.add("sv_charts_tab");
            else expandedSections.delete("sv_charts_tab");
            chartsBody.classList.toggle("open", openNow);
            chartsHdr.classList.toggle("open", openNow);
            const arrow = chartsHdr.querySelector(".sub-accordion-arrow");
            if (arrow) {
                arrow.classList.toggle("open", openNow);
                arrow.innerHTML = openNow ? iconArrowExpanded : iconArrowCollapsed;
            }
        };

        renderChartGroups(catalogData.charts || FALLBACK_CHARTS, chartsBody);
        chartsBlock.appendChild(chartsHdr);
        chartsBlock.appendChild(chartsBody);
        svContainerEl.appendChild(chartsBlock);

        // 2. 精选歌单（折叠按需加载）
        const playlistsBlock = document.createElement("div");
        playlistsBlock.className = "sub-accordion-block";
        const isPlOpen = expandedSections.has("sv_playlists_tab");

        const plHdr = document.createElement("div");
        plHdr.className = `sub-accordion-hdr ${isPlOpen ? 'open' : ''}`;
        plHdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow ${isPlOpen ? 'open' : ''}">${isPlOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>精选歌单</span>
            </div>
            <span class="count-badge">600+</span>
        `;

        const plBody = document.createElement("div");
        plBody.className = `sub-accordion-body ${isPlOpen ? 'open' : ''}`;

        let plRendered = false;
        plHdr.onclick = () => {
            const openNow = !expandedSections.has("sv_playlists_tab");
            if (openNow) expandedSections.add("sv_playlists_tab");
            else expandedSections.delete("sv_playlists_tab");
            plBody.classList.toggle("open", openNow);
            plHdr.classList.toggle("open", openNow);
            const arrow = plHdr.querySelector(".sub-accordion-arrow");
            if (arrow) {
                arrow.classList.toggle("open", openNow);
                arrow.innerHTML = openNow ? iconArrowExpanded : iconArrowCollapsed;
            }
            if (openNow && !plRendered) {
                renderPlaylistSections(catalogData.sections || FALLBACK_SECTIONS, plBody);
                plRendered = true;
            }
        };

        if (isPlOpen) {
            renderPlaylistSections(catalogData.sections || FALLBACK_SECTIONS, plBody);
            plRendered = true;
        }

        playlistsBlock.appendChild(plHdr);
        playlistsBlock.appendChild(plBody);
        svContainerEl.appendChild(playlistsBlock);
    }

    function renderChartGroups(charts, containerEl) {
        containerEl.innerHTML = "";
        const groups = [
            { key: "sv_group_realtime", kind: "realtime", label: "即时排行" },
            { key: "sv_group_weekly", kind: "weekly", label: "每周排行" }
        ];

        groups.forEach(grp => {
            const list = charts.filter(c => c.kind === grp.kind);
            if (list.length === 0) return;

            const isOpen = expandedChartGroups.has(grp.key);
            const block = document.createElement("div");
            block.className = "sub-accordion-block";

            const hdr = document.createElement("div");
            hdr.className = `sub-accordion-hdr level-3 ${isOpen ? 'open' : ''}`;
            hdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isOpen ? 'open' : ''}">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span>${escapeHtml(grp.label)}</span>
                </div>
                <span class="count-badge">${list.length}</span>
            `;

            const body = document.createElement("div");
            body.className = `sub-accordion-body ${isOpen ? 'open' : ''}`;

            hdr.onclick = () => {
                const openNow = !expandedChartGroups.has(grp.key);
                if (openNow) expandedChartGroups.add(grp.key);
                else expandedChartGroups.delete(grp.key);
                body.classList.toggle("open", openNow);
                hdr.classList.toggle("open", openNow);
                const arrow = hdr.querySelector(".sub-accordion-arrow");
                if (arrow) {
                    arrow.classList.toggle("open", openNow);
                    arrow.innerHTML = openNow ? iconArrowExpanded : iconArrowCollapsed;
                }
            };

            list.forEach(c => {
                const card = window.LeftPanel.createPlaylistCard({
                    id: c.id,
                    platform: "streetvoice",
                    svType: "chart",
                    svKind: c.kind,
                    svCategory: c.category,
                    title: c.title,
                    name: c.title,
                    curator: `StreetVoice ${grp.label}`,
                    trackCount: 50,
                    url: `https://streetvoice.com/music/charts/${c.kind}/${c.category}/`
                });
                body.appendChild(card);
            });

            block.appendChild(hdr);
            block.appendChild(body);
            containerEl.appendChild(block);
        });
    }

    function renderPlaylistSections(sections, containerEl) {
        containerEl.innerHTML = "";
        sections.forEach(sec => {
            const secKey = `sv_pl_sec_${sec.id}`;
            const isOpen = expandedPlaylistSections.has(secKey);

            const block = document.createElement("div");
            block.className = "sub-accordion-block";

            const hdr = document.createElement("div");
            hdr.className = `sub-accordion-hdr level-3 ${isOpen ? 'open' : ''}`;
            hdr.innerHTML = `
                <div class="sub-accordion-left">
                    <span class="sub-accordion-arrow ${isOpen ? 'open' : ''}">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span>${escapeHtml(sec.title)}</span>
                </div>
                <span class="count-badge">${sec.count_hint || ''}</span>
            `;

            const body = document.createElement("div");
            body.className = `sub-accordion-body ${isOpen ? 'open' : ''}`;

            let loaded = false;
            hdr.onclick = () => {
                const openNow = !expandedPlaylistSections.has(secKey);
                if (openNow) expandedPlaylistSections.add(secKey);
                else expandedPlaylistSections.delete(secKey);
                body.classList.toggle("open", openNow);
                hdr.classList.toggle("open", openNow);
                const arrow = hdr.querySelector(".sub-accordion-arrow");
                if (arrow) {
                    arrow.classList.toggle("open", openNow);
                    arrow.innerHTML = openNow ? iconArrowExpanded : iconArrowCollapsed;
                }
                if (openNow && !loaded) {
                    loadSectionPlaylists(sec.id, 1, body, false);
                    loaded = true;
                }
            };

            if (isOpen) {
                loadSectionPlaylists(sec.id, 1, body, false);
                loaded = true;
            }

            block.appendChild(hdr);
            block.appendChild(body);
            containerEl.appendChild(block);
        });
    }

    function loadSectionPlaylists(sectionId, page, bodyEl, appendMode) {
        const cacheKey = `sv_playlists_${sectionId}_p${page}`;
        const url = `/api/sv_playlists?section=${encodeURIComponent(sectionId)}&page=${page}`;

        window.swrFetch(url, cacheKey, {
            showLoading: () => {
                if (!appendMode) {
                    bodyEl.innerHTML = '<div class="loading-state">正在获取街声歌单...</div>';
                }
            },
            onCached: (data) => {
                renderSectionPlaylistCards(sectionId, data, bodyEl, appendMode);
            },
            onUpdated: (data) => {
                renderSectionPlaylistCards(sectionId, data, bodyEl, appendMode);
            },
            onError: (err) => {
                if (!appendMode) {
                    bodyEl.innerHTML = `<div class="loading-state">获取街声歌单失败: ${escapeHtml(err.message)}</div>`;
                } else {
                    window.Shell?.showToast?.(`加载更多歌单失败: ${err.message}`);
                }
            }
        });
    }

    function renderSectionPlaylistCards(sectionId, data, bodyEl, appendMode) {
        if (!appendMode) {
            bodyEl.innerHTML = "";
        } else {
            bodyEl.querySelectorAll(".sv-load-more-btn").forEach(el => el.remove());
        }

        const list = (data && Array.isArray(data.playlists)) ? data.playlists : [];
        if (!appendMode && list.length === 0) {
            bodyEl.innerHTML = '<div class="loading-state">暂无歌单数据</div>';
            return;
        }

        const existingIds = new Set();
        bodyEl.querySelectorAll(".playlist-card[id]").forEach(el => existingIds.add(el.id));

        list.forEach(item => {
            const storageId = `sv_pl_${item.id}`;
            if (existingIds.has(`card-${storageId}`)) return;
            existingIds.add(`card-${storageId}`);
            const card = window.LeftPanel.createPlaylistCard({
                id: storageId,
                svId: String(item.id),
                platform: "streetvoice",
                svType: "playlist",
                type: "playlist",
                kind: "playlist",
                title: item.title || item.name,
                name: item.title || item.name,
                curator: item.curator || "StreetVoice",
                cover: item.cover || "",
                url: item.url || ""
            });
            bodyEl.appendChild(card);
        });

        if (data && data.has_more && data.next_page) {
            const moreBtn = document.createElement("button");
            moreBtn.type = "button";
            moreBtn.className = "sv-load-more-btn";
            moreBtn.innerText = "加载更多歌单...";
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                moreBtn.disabled = true;
                moreBtn.innerText = "正在加载...";
                loadSectionPlaylists(sectionId, data.next_page, bodyEl, true);
            };
            bodyEl.appendChild(moreBtn);
        }
    }

    return {
        init
    };
})();
