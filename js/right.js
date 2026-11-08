/**
 * ========================================================
 * 模块：js/right.js - 右侧实体详情栏、响应式曲目表与批量操作控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.RightPanel
 * 依赖协同：window.player, window.StorageManager, window.Modals, window.ContextMenu, window.Downloader
 * --------------------------------------------------------
 * 功能目录：
 *   1. 歌单与专辑实体加载 (selectPlaylist / selectCuratedCollection / selectCustomPlaylist)
 *   2. 实体操作头渲染 (renderHeaderActions —— ▶ 播放全部 / ★ 收藏 / ✕ 删除 / ↓ 打包)
 *   3. 响应式自适应曲目表 (renderTracklist —— 序号/复选框无缝互斥切换、双击快速点播、单曲收藏)
 *   4. 浮动批量多选工具栏 (floatingBatchBar —— 批量播放、批量添加到歌单、批量ZIP下载、批量删除)
 *   5. 全局搜索结果与歌手联动路由 (renderSearchResults / searchArtistByName / openAlbumByTrack)
 * ========================================================
 */

window.RightPanel = (function () {
    'use strict';

    let currentPlaylistData = null;
    let currentTracks = [];
    let isViewingCustomPlaylist = false;
    let currentCustomPlaylistId = null;
    let pendingTrackToAdd = null;

    // 多选记录
    const selectedTrackIndices = new Set();

    // DOM 引用
    const detailTitle = document.getElementById("detailTitle");
    const detailSubtitle = document.getElementById("detailSubtitle");
    const detailActions = document.getElementById("detailActions");
    const detailBody = document.getElementById("detailBody");
    const detailPanel = document.getElementById("detailPanel");
    const btnFavCurrent = document.getElementById("btnFavCurrent");
    const floatingBatchBar = document.getElementById("floatingBatchBar");
    const batchCountText = document.getElementById("batchCountText");

    // 点击右侧区域时，若左侧抽屉正展开则自动缩回
    if (detailPanel) {
        detailPanel.addEventListener("click", (e) => {
            const listPanel = document.getElementById("listPanel");
            if (listPanel && listPanel.classList.contains("open")) {
                window.LeftPanel?.closeDrawer?.();
            }

            // 多选模式下：若点击了详情区域的空白处（非行元素、非顶部操作栏按钮等），立即退出多选
            if (selectedTrackIndices.size > 0) {
                if (!e.target.closest("tr[data-idx]") && !e.target.closest("#detailActions") && !e.target.closest("#checkAllBox")) {
                    clearSelection();
                }
            }
        });
    }

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatTime(ms) {
        if (!ms || isNaN(ms)) return "00:00";
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
    }

    // 点击官方精选合集 (如“新歌精选”、“正在流行中”)
    async function selectCuratedCollection(title, curator, url, roomUrl, fallbackTracks) {
        clearSelection();
        isViewingCustomPlaylist = false;
        currentCustomPlaylistId = null;
        currentPlaylistData = { id: "", type: "playlist", name: title, curator: curator, url: url };
        currentTracks = (fallbackTracks && fallbackTracks.length > 0) ? fallbackTracks.map((t, idx) => ({
            index: idx + 1,
            name: t.name || t.title || "未知曲目",
            artist: t.artist || "未知歌手",
            album: t.album || title,
            durationMillis: t.durationMillis || (t.duration ? t.duration * 1000 : 0),
            id: t.id || "",
            url: t.url || url
        })) : [];

        // 记忆最后访问
        window.StorageManager?.setLastPlaylist?.({
            kind: 'curated',
            name: title,
            curator: curator,
            url: url,
            roomUrl: roomUrl,
            tracks: currentTracks
        });

        if (detailTitle) detailTitle.innerText = title;
        if (detailSubtitle) detailSubtitle.innerText = `${curator || 'Apple Music'} • 精选 (共 ${currentTracks.length} 首)`;
        renderHeaderActions();
        renderTracklist(currentTracks);

        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
            window.player.setPlaylist(currentTracks, -1);
        }

        // 穿透 Room 获取 100 首完整曲目
        if (roomUrl) {
            try {
                const resp = await fetch(`/api/apple_room?url=${encodeURIComponent(roomUrl)}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.tracks && data.tracks.length > 0) {
                        currentTracks = data.tracks.map((t, idx) => ({
                            index: idx + 1,
                            name: t.name || t.title || "未知曲目",
                            artist: t.artist || "未知歌手",
                            album: t.album || title,
                            durationMillis: t.durationMillis || (t.duration ? t.duration * 1000 : 0),
                            id: t.id || "",
                            url: t.url || url
                        }));
                        if (detailSubtitle) detailSubtitle.innerText = `${curator || 'Apple Music'} • 完整专题 (共 ${currentTracks.length} 首)`;
                        renderHeaderActions();
                        renderTracklist(currentTracks);
                    }
                }
            } catch (e) {
                console.warn("加载 room 详情失败，保持精选列表", e);
            }
        }
    }

    // 点击 Apple 官方歌单 / 专辑
    async function selectPlaylist(id, type, name, curator, url) {
        clearSelection();
        isViewingCustomPlaylist = false;
        currentCustomPlaylistId = null;
        currentPlaylistData = { id, type, name, curator, url };
        currentTracks = [];

        window.StorageManager?.setLastPlaylist?.({
            kind: 'apple',
            id,
            type,
            name,
            curator,
            url
        });

        if (detailTitle) detailTitle.innerText = name;
        if (detailSubtitle) detailSubtitle.innerText = `${curator || 'Apple Music'} • 正在获取曲目...`;
        renderHeaderActions();

        if (detailBody) {
            detailBody.innerHTML = '<div class="loading-state">正在加载曲目清单...</div>';
        }

        const sf = window.RegionPanel?.getStorefront?.() || "cn";
        // 智能母语透视：当歌单属于日本排行榜/J-Pop专区时，优先以日本本土 storefront (jp) 拉取母语地道曲目名，彻底根除罗马音化痛点
        const isJapanEntity = Boolean(
            (name && (name.includes('日本') || name.includes('Japan') || name.includes('J-Pop') || name.includes('トップ100'))) ||
            (curator && (curator.includes('日本') || curator.includes('J-Pop'))) ||
            (id === 'pl.043a2c9876114d95a4659988497567be')
        );
        const querySf = (isJapanEntity && sf !== 'jp') ? 'jp' : sf;
        const cacheKey = `playlist_${querySf}_${id}`;
        const cached = window.ClientCache?.get?.(cacheKey);

        if (cached && Array.isArray(cached.data)) {
            currentTracks = cached.data;
            if (detailSubtitle) detailSubtitle.innerText = `${curator || 'Apple Music'} • 共 ${currentTracks.length} 首歌曲`;
            renderTracklist(currentTracks);
            if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                window.player.setPlaylist(currentTracks, -1);
            }
        }

        try {
            const isSingleSong = String(id).startsWith("song.") || (type === "songs");
            const targetType = isSingleSong ? "songs" : (type === "albums" || type === "album" ? "albums" : "playlists");

            let data;
            try {
                data = await window.apiRequest(`${targetType}/${id}`, '', querySf);
            } catch (firstErr) {
                if (querySf !== sf) {
                    data = await window.apiRequest(`${targetType}/${id}`, '', sf);
                } else if (targetType === "playlists") {
                    data = await window.apiRequest(`albums/${id}`, '', sf);
                } else if (targetType === "albums") {
                    data = await window.apiRequest(`playlists/${id}`, '', sf);
                } else {
                    throw firstErr;
                }
            }

            if (data === 304) return;

            const item = data?.data?.[0];
            const tracks = (targetType === "songs" && item) ? [item] : (item?.relationships?.tracks?.data || []);

            currentTracks = tracks.map((t, idx) => {
                const attr = t.attributes;
                return {
                    index: idx + 1,
                    name: attr?.name || "未知曲目",
                    artist: attr?.artistName || "未知歌手",
                    album: attr?.albumName || name,
                    durationMillis: attr?.durationInMillis || 0,
                    isrc: attr?.isrc || "",
                    url: attr?.url || "",
                    id: t.id || ""
                };
            });

            window.ClientCache?.set?.(cacheKey, currentTracks);
            if (detailSubtitle) detailSubtitle.innerText = `${curator || 'Apple Music'} • 共 ${currentTracks.length} 首歌曲`;
            renderHeaderActions();
            renderTracklist(currentTracks);

            if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                window.player.setPlaylist(currentTracks, -1);
            }
        } catch (err) {
            if (!currentTracks || currentTracks.length === 0) {
                if (detailBody) detailBody.innerHTML = `<div class="loading-state">❌ 获取曲目详情失败: ${escapeHtml(err.message)}</div>`;
                if (detailSubtitle) detailSubtitle.innerText = "获取曲目清单失败";
            }
        }
    }

    // 点击自建歌单
    function selectCustomPlaylist(playlistId) {
        clearSelection();
        const customs = window.StorageManager.getCustomPlaylists();
        const pl = customs.find(c => c.id === playlistId);
        if (!pl) return;

        isViewingCustomPlaylist = true;
        currentCustomPlaylistId = playlistId;
        currentPlaylistData = { id: pl.id, name: pl.title, title: pl.title, curator: "我的自建歌单" };
        currentTracks = pl.tracks || [];

        window.StorageManager.setLastPlaylist({
            kind: 'custom',
            id: pl.id,
            name: pl.title
        });

        if (detailTitle) detailTitle.innerText = pl.title;
        if (detailSubtitle) detailSubtitle.innerText = `自建歌单 • 共 ${currentTracks.length} 首歌曲`;
        renderHeaderActions();
        renderTracklist(currentTracks);

        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
            window.player.setPlaylist(currentTracks, -1);
        }
    }

    /**
     * 实体总览顶部纯图标操作栏渲染
     */
    function renderHeaderActions() {
        if (!detailActions) return;
        const hasTracks = currentTracks && currentTracks.length > 0;
        if (!hasTracks && !currentPlaylistData) {
            detailActions.style.display = "none";
            return;
        }

        detailActions.style.display = "flex";

        const isFav = currentPlaylistData?.id && window.StorageManager.isPlaylistFaved(currentPlaylistData.id);
        const selCount = selectedTrackIndices.size;

        if (selCount > 0) {
            // 多选激活状态：歌单头部右侧集中承载批量操作，彻底无需底部悬浮弹窗
            const removeCustomBtn = isViewingCustomPlaylist ? `
                <button class="btn-action-icon" onclick="window.RightPanel.removeBatchSelectedFromCustom()" title="从当前自建歌单移出 (${selCount} 首)">
                    －
                </button>
            ` : '';

            detailActions.innerHTML = `
                <button class="btn-action-icon btn-play-all" onclick="window.RightPanel.playBatchSelected()" title="播放所选 (${selCount} 首)">
                    ▶
                </button>
                <button class="btn-action-icon" onclick="window.RightPanel.openBatchAddToPlaylistModal()" title="加入自建歌单 (${selCount} 首)">
                    ＋
                </button>
                ${removeCustomBtn}
                <button class="btn-action-icon" onclick="window.RightPanel.downloadSelectedTracks()" title="下载所选 (${selCount} 首)">
                    ↓
                </button>
                <button class="btn-action-icon" onclick="window.RightPanel.clearSelection()" title="取消多选">
                    ✕
                </button>
            `;
        } else {
            // 默认未勾选状态：
            // 自建歌单显示 ✕ 删除歌单；其它歌单显示 ＋ 分组管理/收藏
            if (isViewingCustomPlaylist) {
                detailActions.innerHTML = `
                    <button class="btn-action-icon btn-play-all" onclick="window.RightPanel.playCurrentAll()" title="播放全部">
                        ▶
                    </button>
                    <button class="btn-action-icon" id="btnDeleteCustomCurrent" onclick="window.RightPanel.deleteCurrentCustomPlaylist()" title="删除当前自建歌单">
                        ✕
                    </button>
                `;
            } else {
                detailActions.innerHTML = `
                    <button class="btn-action-icon btn-play-all" onclick="window.RightPanel.playCurrentAll()" title="播放全部">
                        ▶
                    </button>
                    <button class="btn-action-icon ${isFav ? 'active' : ''}" id="btnFavCurrent" onclick="window.RightPanel.openPlaylistGroupingModal()" title="分组管理 / 收藏">
                        ＋
                    </button>
                `;
            }
        }
    }

    /**
     * 渲染曲目表格 (遵照 SITE_ARCHITECTURE.md 自适应规范与复选框交互)
     */
    function renderTracklist(tracks) {
        if (!detailBody) return;
        if (!tracks || tracks.length === 0) {
            detailBody.innerHTML = '<div class="loading-state">当前暂无可播放曲目。</div>';
            return;
        }

        const curPlayingSong = window.player && window.player.playlist[window.player.currentIndex];
        const hasSelection = selectedTrackIndices.size > 0;

        // 多歌手拆解与独立链接生成辅助函数（支持 a & b, a / b, a、b, a, b, feat. 等）
        function renderArtistLinksHtml(artistStr) {
            if (!artistStr) return '未知歌手';
            const delimRegex = /(\s*(?:&|\/|、|,|feat\.|ft\.|with)\s*)/i;
            const parts = artistStr.split(delimRegex);
            return parts.map(part => {
                const trimmed = part.trim();
                if (!trimmed) return '';
                if (/^(?:&|\/|、|,|feat\.|ft\.|with)$/i.test(trimmed)) {
                    return ` <span class="artist-delimiter">${escapeHtml(trimmed)}</span> `;
                }
                return `<span class="track-artist-link" data-artist="${escapeHtml(trimmed)}" onclick="event.stopPropagation(); window.RightPanel.searchArtistByName(this.dataset.artist)">${escapeHtml(trimmed)}</span>`;
            }).join('').replace(/\s+/g, ' ').trim();
        }

        let html = `
            <table class="track-table ${hasSelection ? 'multi-select-mode' : ''}" id="trackTableEl">
                <thead>
                    <tr>
                        <th class="track-index-col" style="text-align:center;">
                            <input type="checkbox" class="track-checkbox" id="checkAllBox" title="全选/全不选" onchange="window.RightPanel.handleCheckAll(event)" ${hasSelection && selectedTrackIndices.size === tracks.length ? 'checked' : ''}>
                            <span class="track-index-num">#</span>
                        </th>
                        <th class="track-info-th">歌曲 / 歌手</th>
                        <th class="track-album-col">专辑</th>
                        <th class="track-duration-col">时长</th>
                    </tr>
                </thead>
                <tbody>
        `;

        tracks.forEach((t, idx) => {
            const isPlayingThis = curPlayingSong &&
                (curPlayingSong.title === t.name || curPlayingSong.name === t.name) &&
                (curPlayingSong.artist === t.artist);
            const rowClass = isPlayingThis ? 'track-row-playing' : '';
            const isSelected = selectedTrackIndices.has(idx);

            const displayNum = idx + 1 < 10 ? `0${idx + 1}` : `${idx + 1}`;

            html += `
                <tr class="${rowClass} ${isSelected ? 'track-row-selected' : ''}" id="track-row-${idx}" data-idx="${idx}">
                    <td class="track-index-col">
                        <span class="track-index-num">${isPlayingThis ? '🔊' : displayNum}</span>
                        <input type="checkbox" class="track-checkbox" data-idx="${idx}" ${isSelected ? 'checked' : ''} onchange="window.RightPanel.handleCheckboxChange(event, ${idx})">
                    </td>
                    <td class="track-info-cell">
                        <div class="track-title-wrapper">
                            <span class="track-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
                            <span class="track-artist" title="${escapeHtml(t.artist)}">· ${renderArtistLinksHtml(t.artist)}</span>
                        </div>
                    </td>
                    <td class="track-album-col" title="${escapeHtml(t.album || '')}">
                        <span class="track-album-link" onclick="event.stopPropagation(); window.RightPanel.openAlbumByTrack(${idx})">${escapeHtml(t.album || '')}</span>
                    </td>
                    <td class="track-duration-col">
                        ${formatTime(t.durationMillis)}
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        detailBody.innerHTML = html;

        // 绑定行交互：方案B（平时单击无反应防误触）+ 组合1（长按 500ms / 右键激活多选模式）
        bindTrackRowsInteraction();
    }

    /**
     * 行交互绑定：
     * 1. 方案B：非多选模式下单击彻底无反应 (防误触/防滑动误切歌)
     * 2. 组合1：触屏长按 500ms 或鼠标右键，激活多选模式并勾选该行
     * 3. 多选模式下：轻触单击任意行即可快速连选/反选
     */
    /**
     * 行交互绑定：
     * 1. 方案B：非多选模式下单击彻底无反应 (防误触/防滑动误切歌)；双击 (dblclick) 极速直接开播
     * 2. 组合1：触屏长按 500ms 或鼠标右键，激活多选模式并勾选该行
     * 3. 多选模式下：仅点击首列复选框区域为增减勾选；点击歌曲行其他任何区域或空白处，立即取消多选恢复正常状态！
     */
    let lastLongPressTime = 0;

    function bindTrackRowsInteraction() {
        const rows = detailBody.querySelectorAll("tr[data-idx]");
        rows.forEach(row => {
            const idx = parseInt(row.getAttribute("data-idx"), 10);

            // 单击行事件处理（使用捕获模式优先拦截非复选框区域的点击并清空多选，防止触发内部歌手/专辑跳转）
            row.addEventListener("click", (e) => {
                // 防触屏长按释放后的合成点击误杀
                if (Date.now() - lastLongPressTime < 350) return;

                // 若点击的是首列复选框列：
                if (e.target.closest(".track-index-col")) {
                    // 若点击的是单元格或序号而非原生 input，同步翻转复选框状态
                    if (e.target.tagName !== "INPUT") {
                        const box = row.querySelector(".track-checkbox");
                        if (box) {
                            box.checked = !box.checked;
                            toggleTrackSelection(idx);
                        }
                    }
                    return;
                }

                // 核心交互：多选模式下，点击任何非复选框区域（歌名、歌手、时长或空白处），直接清空多选恢复正常！
                if (selectedTrackIndices.size > 0) {
                    e.stopPropagation();
                    e.preventDefault();
                    clearSelection();
                    return;
                }

                // 非多选模式：彻底无反应 (方案B，防误触)
            }, true);

            // 4.2 桌面端双击 (dblclick) 极速直接开播
            row.addEventListener("dblclick", (e) => {
                if (e.target.closest(".track-index-col")) return;
                if (selectedTrackIndices.size === 0) {
                    playSong(idx);
                }
            });

            // 长按与右键处理 (组合1)
            let touchTimer = null;
            let startX = 0;
            let startY = 0;
            let isLongPress = false;

            row.addEventListener("touchstart", (e) => {
                if (e.touches.length !== 1) return;
                const touch = e.touches[0];
                startX = touch.clientX;
                startY = touch.clientY;
                isLongPress = false;

                touchTimer = setTimeout(() => {
                    isLongPress = true;
                    lastLongPressTime = Date.now();
                    if (navigator.vibrate) {
                        try { navigator.vibrate(30); } catch (err) {}
                    }
                    enterMultiSelectWithTrack(idx);
                }, 500);
            }, { passive: true });

            row.addEventListener("touchmove", (e) => {
                if (!touchTimer) return;
                const touch = e.touches[0];
                const dist = Math.hypot(touch.clientX - startX, touch.clientY - startY);
                if (dist > 10) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
            }, { passive: true });

            row.addEventListener("touchend", (e) => {
                if (touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
                if (isLongPress) {
                    lastLongPressTime = Date.now();
                    try { e.preventDefault(); } catch (err) {}
                    try { e.stopPropagation(); } catch (err) {}
                }
            });

            row.addEventListener("touchcancel", () => {
                if (touchTimer) {
                    clearTimeout(touchTimer);
                    touchTimer = null;
                }
            });

            row.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                enterMultiSelectWithTrack(idx);
            });
        });
    }

    function enterMultiSelectWithTrack(idx) {
        if (!selectedTrackIndices.has(idx)) {
            selectedTrackIndices.add(idx);
        }
        syncMultiSelectUI();
        window.Shell?.showToast?.("已激活多选模式：点击复选框多选，点击其他区域取消");
    }

    function toggleTrackSelection(idx) {
        if (selectedTrackIndices.has(idx)) {
            selectedTrackIndices.delete(idx);
        } else {
            selectedTrackIndices.add(idx);
        }
        syncMultiSelectUI();
    }

    /**
     * 复选框勾选联动处理
     */
    function handleCheckboxChange(e, idx) {
        if (e.target.checked) {
            selectedTrackIndices.add(idx);
        } else {
            selectedTrackIndices.delete(idx);
        }
        syncMultiSelectUI();
    }

    function handleCheckAll(e) {
        const isChecked = e.target.checked;
        if (isChecked) {
            currentTracks.forEach((_, idx) => selectedTrackIndices.add(idx));
        } else {
            selectedTrackIndices.clear();
        }
        syncMultiSelectUI();
    }

    function clearSelection() {
        selectedTrackIndices.clear();
        syncMultiSelectUI();
    }

    function syncMultiSelectUI() {
        const table = document.getElementById("trackTableEl");
        const hasSelection = selectedTrackIndices.size > 0;

        if (table) {
            if (hasSelection) {
                table.classList.add("multi-select-mode");
            } else {
                table.classList.remove("multi-select-mode");
            }

            table.querySelectorAll('.track-checkbox[data-idx]').forEach(box => {
                const idx = parseInt(box.getAttribute("data-idx"), 10);
                const isChecked = selectedTrackIndices.has(idx);
                box.checked = isChecked;
                const row = document.getElementById(`track-row-${idx}`);
                if (row) {
                    if (isChecked) {
                        row.classList.add("track-row-selected");
                    } else {
                        row.classList.remove("track-row-selected");
                    }
                }
            });

            const checkAllBox = document.getElementById("checkAllBox");
            if (checkAllBox) {
                checkAllBox.checked = currentTracks.length > 0 && selectedTrackIndices.size === currentTracks.length;
            }
        }
        renderHeaderActions();
    }

    // 播放全部
    function playCurrentAll() {
        if (!currentTracks || currentTracks.length === 0) {
            window.Shell?.showToast?.("当前歌单暂无可播放曲目");
            return;
        }
        if (window.player) {
            window.player.playTracklist(currentTracks, 0);
            window.Shell?.showToast?.(`已播放全部 ${currentTracks.length} 首歌曲`);
        }
    }

    // 单曲播放
    function playSong(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        if (window.player) {
            window.player.playTracklist(currentTracks, idx);
        }
    }

    // 统一下载已勾选歌曲 (单首直下，多首出清单弹窗打包 ZIP)
    function downloadSelectedTracks() {
        if (selectedTrackIndices.size === 0) {
            window.Shell?.showToast?.("请先勾选需要下载的歌曲");
            return;
        }
        const selected = Array.from(selectedTrackIndices).sort((a, b) => a - b).map(idx => currentTracks[idx]);
        window.Downloader?.promptBatchDownload?.(selected);
    }

    // 单曲下载
    function downloadSingleSong(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        window.Downloader?.downloadSingleTrack?.(currentTracks[idx]);
    }

    // 整单下载 (兼容接口，统一交由 Downloader 处理)
    function downloadCurrentPlaylist() {
        if (!currentTracks || currentTracks.length === 0) {
            window.Shell?.showToast?.("无可用曲目下载");
            return;
        }
        if (selectedTrackIndices.size > 0) {
            downloadSelectedTracks();
        } else {
            window.Downloader?.promptBatchDownload?.(currentTracks);
        }
    }

    // 批量播放已选
    function playBatchSelected() {
        if (selectedTrackIndices.size === 0) return;
        const selected = Array.from(selectedTrackIndices).sort((a,b)=>a-b).map(idx => currentTracks[idx]);
        if (window.player) {
            window.player.playTracklist(selected, 0);
            window.Shell?.showToast?.(`已播放选中的 ${selected.length} 首歌曲`);
        }
    }

    // 批量下载已选
    function downloadBatchSelected() {
        downloadSelectedTracks();
    }

    // 批量加入歌单
    function openBatchAddToPlaylistModal() {
        if (selectedTrackIndices.size === 0) return;
        const selected = Array.from(selectedTrackIndices).sort((a,b)=>a-b).map(idx => currentTracks[idx]);
        pendingTrackToAdd = selected; // 数组代表批量
        window.Shell?.openAddToCustomModal?.(`已选择 ${selected.length} 首歌曲`);
    }

    // 收藏当前官方歌单
    // 右侧头部【＋】统一打开分组弹窗 (遵照用户指令3：可选择加入分组或新建分组)
    function openPlaylistGroupingModal() {
        if (!currentPlaylistData) return;
        if (isViewingCustomPlaylist && currentCustomPlaylistId) {
            window.Shell?.openMoveCategoryModal?.('custom', currentCustomPlaylistId, currentPlaylistData.category || '未分组');
        } else if (currentPlaylistData.id) {
            const plData = {
                id: currentPlaylistData.id,
                type: currentPlaylistData.type || "playlist",
                name: currentPlaylistData.name,
                title: currentPlaylistData.name,
                curator: currentPlaylistData.curator || "Apple Music",
                url: currentPlaylistData.url || "",
                trackCount: currentTracks ? currentTracks.length : 0
            };
            window.Shell?.openAddToFavModal?.(plData);
        }
    }

    function toggleFavCurrentPlaylist() {
        openPlaylistGroupingModal();
    }

    // 删除当前自建歌单
    function deleteCurrentCustomPlaylist() {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId) return;
        const plName = currentPlaylistData?.name || "当前歌单";
        const doDelete = () => {
            window.StorageManager.deleteCustomPlaylist(currentCustomPlaylistId);
            window.Shell?.showToast?.(`已删除歌单《${plName}》`);
            if (detailTitle) detailTitle.innerText = "YY-Amusic";
            if (detailSubtitle) detailSubtitle.innerText = "请从左侧选择歌单或专辑";
            if (detailActions) detailActions.style.display = "none";
            if (detailBody) detailBody.innerHTML = '<div class="placeholder-box"><p>👈 请从左侧选择歌单或专辑浏览。</p></div>';
            currentTracks = [];
            currentPlaylistData = null;
            isViewingCustomPlaylist = false;
            currentCustomPlaylistId = null;
            // 联动刷新左侧面板
            window.LibraryPanel?.renderLibrary?.();
        };

        if (window.Shell?.openConfirmModal) {
            window.Shell.openConfirmModal({
                title: '✕ 删除歌单确认',
                message: `确定彻底删除自建歌单《${plName}》吗？此操作无法撤销。`,
                confirmText: '确认删除',
                onConfirm: doDelete
            });
        } else {
            if (confirm(`确认删除自建歌单《${plName}》吗？`)) {
                doDelete();
            }
        }
    }

    // 单曲加入自建歌单弹窗
    function openAddToPlaylistModal(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        pendingTrackToAdd = currentTracks[idx];
        const trackTitle = `${pendingTrackToAdd.name} - ${pendingTrackToAdd.artist}`;
        window.Shell?.openAddToCustomModal?.(trackTitle);
    }

    // 确认加入歌单
    function confirmAddPendingToPlaylist(targetPlaylistId) {
        if (!pendingTrackToAdd) return;
        if (Array.isArray(pendingTrackToAdd)) {
            pendingTrackToAdd.forEach(track => {
                window.StorageManager.addTrackToCustomPlaylist(targetPlaylistId, track);
            });
            window.Shell?.showToast?.(`已将 ${pendingTrackToAdd.length} 首歌曲加入歌单`);
            clearSelection();
        } else {
            window.StorageManager.addTrackToCustomPlaylist(targetPlaylistId, pendingTrackToAdd);
            window.Shell?.showToast?.(`已将《${pendingTrackToAdd.name}》加入歌单`);
        }
        pendingTrackToAdd = null;
        window.Shell?.closeAddToCustomModal?.();

        if (isViewingCustomPlaylist && currentCustomPlaylistId === targetPlaylistId) {
            selectCustomPlaylist(targetPlaylistId);
        }
    }

    // 单曲从自建歌单移除
    function removeSongFromCustom(idx) {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId || !currentTracks[idx]) return;
        const track = currentTracks[idx];
        const doRemove = () => {
            window.StorageManager.removeTrackFromCustomPlaylist(currentCustomPlaylistId, idx);
            selectCustomPlaylist(currentCustomPlaylistId);
            window.Shell?.showToast?.(`已从歌单移除《${track.name}》`);
        };

        if (window.Shell?.openConfirmModal) {
            window.Shell.openConfirmModal({
                title: '✕ 移出歌曲确认',
                message: `确定将《${track.name}》从当前歌单移出吗？`,
                confirmText: '确认移出',
                onConfirm: doRemove
            });
        } else {
            doRemove();
        }
    }

    // 批量从自建歌单移出所选歌曲
    function removeBatchSelectedFromCustom() {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId) return;
        const selIndices = Array.from(selectedTrackIndices);
        if (selIndices.length === 0) return;

        const count = selIndices.length;
        const confirmMsg = count === 1
            ? `确定从当前自建歌单移除《${currentTracks[selIndices[0]]?.name || '所选歌曲'}》吗？`
            : `确定从当前自建歌单移除所选的 ${count} 首歌曲吗？`;

        const doBatchRemove = () => {
            window.StorageManager.removeTrackFromCustomPlaylist(currentCustomPlaylistId, selIndices);
            clearSelection();
            selectCustomPlaylist(currentCustomPlaylistId);
            window.Shell?.showToast?.(`已从歌单移除 ${count} 首歌曲`);
        };

        if (window.Shell?.openConfirmModal) {
            window.Shell.openConfirmModal({
                title: '✕ 批量移出确认',
                message: confirmMsg,
                confirmText: '确认移出',
                onConfirm: doBatchRemove
            });
        } else {
            if (confirm(confirmMsg)) {
                doBatchRemove();
            }
        }
    }

    /**
     * 右侧搜索加载与渲染中枢 (与 js/search.js 左右联动)
     */
    function prepareSearchLoading(query) {
        clearSelection();
        isViewingCustomPlaylist = false;
        currentCustomPlaylistId = null;
        currentPlaylistData = { name: `搜索: "${query}"`, title: `搜索: "${query}"`, id: "" };

        if (detailTitle) detailTitle.innerText = `搜索: "${query}"`;
        if (detailSubtitle) detailSubtitle.innerText = "正在检索 Apple 音乐库...";
        if (detailActions) detailActions.style.display = "none";
        if (detailBody) detailBody.innerHTML = '<div class="loading-state">🔍 正在检索匹配的歌曲与专辑...</div>';
    }

    function renderSearchResults(query, songs = [], plCount = 0, albCount = 0) {
        currentTracks = songs.map((t, idx) => {
            const attr = t.attributes;
            return {
                index: idx + 1,
                name: attr?.name || "未知曲目",
                artist: attr?.artistName || "未知歌手",
                album: attr?.albumName || "未知专辑",
                durationMillis: attr?.durationInMillis || 0,
                isrc: attr?.isrc || "",
                url: attr?.url || "",
                id: t.id || ""
            };
        });

        const totalResults = songs.length + plCount + albCount;
        if (totalResults === 0) {
            if (detailSubtitle) detailSubtitle.innerText = "未找到匹配结果";
            if (detailBody) detailBody.innerHTML = `<div class="loading-state">未找到与 "${escapeHtml(query)}" 相关的单曲或专辑。</div>`;
            return;
        }

        if (detailSubtitle) {
            detailSubtitle.innerText = `找到 ${songs.length} 首单曲 • 左侧已列出 ${plCount} 个歌单 / ${albCount} 张专辑`;
        }

        renderHeaderActions();
        renderTracklist(currentTracks);

        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
            window.player.setPlaylist(currentTracks, -1);
        }
    }

    function renderSearchError(errMsg) {
        if (detailSubtitle) detailSubtitle.innerText = "检索失败";
        if (detailBody) detailBody.innerHTML = `<div class="loading-state">❌ 检索失败: ${escapeHtml(errMsg)}</div>`;
    }

    function searchArtistByName(artistName) {
        if (!artistName) return;
        window.SearchPanel?.search?.(artistName);
    }

    function searchArtistByTrack(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        const track = currentTracks[idx];
        if (track.artist) {
            const firstArtist = track.artist.split(/(?:\s*&\s*|\s*\/\s*|\s*、\s*|,\s*|\s+feat\.\s+|\s+ft\.\s+|\s+with\s+)/i)[0].trim();
            window.SearchPanel?.search?.(firstArtist || track.artist);
        }
    }

    function openAlbumByTrack(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        const track = currentTracks[idx];
        let albumId = track.albumId;
        if (!albumId && track.url) {
            const match = track.url.match(/\/album\/(?:[^/]+\/)?(\d+)/);
            if (match && match[1]) {
                albumId = match[1];
            }
        }
        if (albumId) {
            selectPlaylist(albumId, 'album', track.album || track.name, track.artist, track.url);
        } else if (track.album) {
            window.SearchPanel?.search?.(track.album);
        }
    }

    async function handleSearch(term) {
        if (window.SearchPanel) {
            window.SearchPanel.search(term);
        }
    }

    return {
        selectCuratedCollection,
        selectPlaylist,
        selectCustomPlaylist,
        renderTracklist,
        playCurrentAll,
        playSong,
        downloadSingleSong,
        downloadCurrentPlaylist,
        downloadSelectedTracks,
        playBatchSelected,
        downloadBatchSelected,
        openBatchAddToPlaylistModal,
        openPlaylistGroupingModal,
        toggleFavCurrentPlaylist,
        deleteCurrentCustomPlaylist,
        openAddToPlaylistModal,
        confirmAddPendingToPlaylist,
        removeSongFromCustom,
        removeBatchSelectedFromCustom,
        handleCheckboxChange,
        handleCheckAll,
        clearSelection,
        handleSearch,
        prepareSearchLoading,
        renderSearchResults,
        renderSearchError,
        searchArtistByTrack,
        searchArtistByName,
        openAlbumByTrack,
        isViewingCustom: (id) => isViewingCustomPlaylist && currentCustomPlaylistId === id,
        updateCurrentCustomTitle: (newTitle) => {
            if (isViewingCustomPlaylist && detailTitle) {
                detailTitle.innerText = newTitle;
            }
        }
    };
})();
