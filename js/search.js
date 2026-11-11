/**
 * ========================================================
 * 模块：js/search.js - 搜索与艺人中枢控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.SearchPanel
 * 依赖协同：window.LeftPanel, window.RightPanel, window.apiRequest
 * --------------------------------------------------------
 * 职责定位：
 *   1. 统一管理全站搜索（顶栏搜索框、点击单曲歌手名触发联动搜索）
 *   2. 负责左侧搜索视图 (viewSearch) 的挂载与渲染（精选歌单、精选专辑）
 *   3. 管理 [← 返回] 机制，随时平滑恢复到搜索前的专区或音乐库视图
 * --------------------------------------------------------
 * 功能目录：
 *   1. 搜索统一调度主入口 (init / search - 联动左侧歌单专辑与右侧单曲)
 *   2. 结果与状态渲染 (renderLoadingState / renderResults / renderErrorState)
 *   3. 搜索折叠分类区块生成 (createSearchSection)
 *   4. 搜索退出与视图恢复 (exitSearch)
 * ========================================================
 */

window.SearchPanel = (function () {
    'use strict';

    let containerElement = null;
    let currentQuery = "";

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

    /* ========================================================
     * 区块 1: 搜索统一调度主入口与联动分发
     * ======================================================== */
    function init(container) {
        containerElement = container;
    }

    /**
     * 全局统一搜索入口：
     * 支持从顶栏搜索框调用，或从单曲歌手名点击调用
     */
    async function search(term) {
        if (!term || !String(term).trim()) return;
        const query = String(term).trim();
        currentQuery = query;

        // 同步顶部搜索框文字与清除按钮状态
        const searchInput = document.getElementById("searchInput");
        const clearBtn = document.getElementById("clearBtn");
        if (searchInput) searchInput.value = query;
        if (clearBtn) clearBtn.style.display = "inline-flex";

        // 切换左侧侧栏到搜索面板并呈现骨架加载态
        window.LeftPanel?.switchTab?.("search");
        renderLoadingState(query);

        // 驱动右侧详情面板进入搜索加载态
        window.RightPanel?.prepareSearchLoading?.(query);

        try {
            const encoded = encodeURIComponent(query);
            const data = await window.apiRequest(`search?types=songs,albums,playlists&term=${encoded}&limit=25`);

            const songs = data?.results?.songs?.data || [];
            const albums = data?.results?.albums?.data || [];
            const playlists = data?.results?.playlists?.data || [];

            // 1. 渲染左侧搜索结果 (歌单卡片与专辑卡片)
            renderResults(query, playlists, albums);

            // 规则1：当搜索的时候，如果左侧有显示（匹配到歌单或专辑），则左侧会自动弹出
            if (playlists.length > 0 || albums.length > 0) {
                window.LeftPanel?.openDrawer?.();
            } else {
                window.LeftPanel?.closeDrawer?.();
            }

            // 2. 渲染右侧单曲曲目列表
            window.RightPanel?.renderSearchResults?.(query, songs, playlists.length, albums.length);

        } catch (err) {
            console.error("[SearchPanel] 检索失败:", err);
            renderErrorState(err.message);
            window.RightPanel?.renderSearchError?.(err.message);
        }
    }

    /* ========================================================
     * 区块 2: 搜索视图加载/结果/异常状态渲染
     * ======================================================== */
    function renderLoadingState(query) {
        if (!containerElement) return;
        containerElement.innerHTML = `
            <div class="search-return-bar" id="searchReturnBar">
                <div style="display:flex; flex-direction:column; gap:2px; overflow:hidden;">
                    <span style="font-size:var(--fs-t2); font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🔍 搜索: "${escapeHtml(query)}"</span>
                    <span style="font-size:var(--fs-t4); color:var(--text-muted);">正在检索 Apple 音乐库...</span>
                </div>
                <button class="btn-search-return" onclick="window.SearchPanel.exitSearch()">← 返回</button>
            </div>
            <div class="loading-state" style="padding: 24px 16px; font-size: var(--fs-t3); color: var(--text-muted); text-align: center;">
                🔍 正在检索匹配的歌单与专辑...
            </div>
        `;
    }

    function renderResults(query, playlists = [], albums = []) {
        if (!containerElement) return;
        containerElement.innerHTML = "";

        const total = playlists.length + albums.length;

        // 顶部粘性返回导航条
        const returnBar = document.createElement("div");
        returnBar.className = "search-return-bar";
        returnBar.id = "searchReturnBar";
        returnBar.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:2px; overflow:hidden; flex:1;">
                <span style="font-size:var(--fs-t2); font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">🔍 "${escapeHtml(query)}"</span>
                <span style="font-size:var(--fs-t4); color:var(--text-muted);">${playlists.length} 个歌单 • ${albums.length} 张专辑</span>
            </div>
            <button class="btn-search-return" id="btnExitSearch" onclick="window.SearchPanel.exitSearch()">← 返回</button>
        `;
        containerElement.appendChild(returnBar);

        if (total === 0) {
            const emptyHint = document.createElement("div");
            emptyHint.style.cssText = "padding: 24px 16px; font-size: var(--fs-t3); color: var(--text-muted); text-align: center; line-height: 1.6;";
            emptyHint.innerHTML = `未找到与 "<strong>${escapeHtml(query)}</strong>" 相关的精选歌单或专辑。<br><span style="font-size:var(--fs-t4);">👉 您可直接在右侧查看检索到的单曲。</span>`;
            containerElement.appendChild(emptyHint);
            return;
        }

        // 1. 精选歌单板块
        if (playlists.length > 0) {
            const plBlock = createSearchSection("search_playlists", "精选歌单", playlists.length);
            playlists.forEach(pl => {
                const cardItem = {
                    id: pl.id,
                    type: "playlist",
                    kind: "playlist",
                    title: pl.attributes?.name || "未知歌单",
                    name: pl.attributes?.name || "未知歌单",
                    curator: pl.attributes?.curatorName || "Apple Music",
                    url: pl.attributes?.url || "",
                    trackCount: pl.attributes?.trackCount || 0,
                    _isSearch: true
                };
                const card = window.LeftPanel.createPlaylistCard(cardItem, { isCustom: false, isFav: false });
                plBlock.bodyEl.appendChild(card);
            });
            containerElement.appendChild(plBlock.blockEl);
        }

        // 2. 精选专辑板块
        if (albums.length > 0) {
            const albBlock = createSearchSection("search_albums", "精选专辑", albums.length);
            albums.forEach(alb => {
                const cardItem = {
                    id: alb.id,
                    type: "album",
                    kind: "album",
                    title: alb.attributes?.name || "未知专辑",
                    name: alb.attributes?.name || "未知专辑",
                    curator: alb.attributes?.artistName || "未知歌手",
                    url: alb.attributes?.url || "",
                    trackCount: alb.attributes?.trackCount || 0,
                    _isSearch: true
                };
                const card = window.LeftPanel.createPlaylistCard(cardItem, { isCustom: false, isFav: false });
                albBlock.bodyEl.appendChild(card);
            });
            containerElement.appendChild(albBlock.blockEl);
        }
    }

    function renderErrorState(errMsg) {
        if (!containerElement) return;
        containerElement.innerHTML = `
            <div class="search-return-bar" id="searchReturnBar">
                <span style="font-size:var(--fs-t2); font-weight:600; color:var(--text-primary);">🔍 搜索异常</span>
                <button class="btn-search-return" onclick="window.SearchPanel.exitSearch()">← 返回</button>
            </div>
            <div class="loading-state" style="padding: 24px 16px; font-size: var(--fs-t3); color: var(--danger-text); text-align: center;">
                ❌ 检索失败: ${escapeHtml(errMsg)}
            </div>
        `;
    }

    /* ========================================================
     * 区块 3: 搜索折叠分类区块生成 (歌单与专辑分组)
     * ======================================================== */
    function createSearchSection(secId, title, count) {
        const block = document.createElement("div");
        block.className = "library-group-container";
        block.id = secId;

        const hdr = document.createElement("div");
        hdr.className = "library-group-row open";
        hdr.innerHTML = `
            <div class="library-group-left">
                <span class="library-group-arrow open">${iconArrowExpanded}</span>
                <span>${escapeHtml(title)}</span>
                <span class="count-badge">${count}</span>
            </div>
        `;

        const body = document.createElement("div");
        body.className = "library-group-body open";

        hdr.onclick = () => {
            const isOpen = body.classList.toggle("open");
            hdr.classList.toggle("open", isOpen);
            const arrow = hdr.querySelector(".library-group-arrow");
            if (arrow) {
                arrow.classList.toggle("open", isOpen);
                arrow.innerHTML = isOpen ? iconArrowExpanded : iconArrowCollapsed;
            }
        };

        block.appendChild(hdr);
        block.appendChild(body);
        return { blockEl: block, bodyEl: body };
    }

    /* ========================================================
     * 区块 4: 退出搜索与平滑状态回退
     * ======================================================== */
    function exitSearch() {
        currentQuery = "";
        const searchInput = document.getElementById("searchInput");
        const clearBtn = document.getElementById("clearBtn");
        if (searchInput) searchInput.value = "";
        if (clearBtn) clearBtn.style.display = "none";
        window.LeftPanel?.exitSearch?.();
    }

    return {
        init,
        search,
        exitSearch
    };
})();
