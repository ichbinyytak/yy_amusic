/**
 * ========================================================
 * js/right.js - 右侧实体详情栏、响应式曲目表与批量操作控制器 (遵照 SITE_ARCHITECTURE.md)
 * 核心规范：
 * 1. 实体总览纯图标：▶ 播放全部 / ★ 收藏 / ✕ 删除 / ↓ 下载整单
 * 2. 曲目表格自适应排版：歌手名默认在歌曲名后 (· 歌手)，宽度受限时自动折行沉降至下方
 * 3. 极简复选框交互：默认仅显示纯净序号，悬停或多选时平滑变为复选框；已选>0时浮现批量操作栏
 * 4. 全局搜索结果直接在右侧详情区域展示
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
    const btnFavCurrent = document.getElementById("btnFavCurrent");
    const floatingBatchBar = document.getElementById("floatingBatchBar");
    const batchCountText = document.getElementById("batchCountText");

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
        const cacheKey = `playlist_${sf}_${id}`;
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
                data = await window.apiRequest(`${targetType}/${id}`);
            } catch (firstErr) {
                if (targetType === "playlists") {
                    data = await window.apiRequest(`albums/${id}`);
                } else if (targetType === "albums") {
                    data = await window.apiRequest(`playlists/${id}`);
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
                    url: attr?.url || ""
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

        detailActions.innerHTML = `
            <button class="btn-action-icon btn-play-all" onclick="window.RightPanel.playCurrentAll()" title="播放全部">
                ▶
            </button>
            ${isViewingCustomPlaylist ? `
                <button class="btn-action-icon" onclick="window.RightPanel.deleteCurrentCustomPlaylist()" title="删除此自建歌单">
                    ✕
                </button>
            ` : (currentPlaylistData?.id ? `
                <button class="btn-action-icon" id="btnFavCurrent" onclick="window.RightPanel.toggleFavCurrentPlaylist()" title="${isFav ? '取消收藏' : '收藏到分类'}">
                    ${isFav ? '★' : '☆'}
                </button>
            ` : '')}
            ${selCount > 0 ? `
                <button class="btn-action-icon" onclick="window.RightPanel.downloadSelectedTracks()" title="下载所选歌曲 (${selCount} 首)">
                    ↓
                </button>
            ` : ''}
        `;
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
                        <th class="track-action-col">操作</th>
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
                <tr class="${rowClass}" id="track-row-${idx}">
                    <td class="track-index-col">
                        <span class="track-index-num">${isPlayingThis ? '🔊' : displayNum}</span>
                        <input type="checkbox" class="track-checkbox" data-idx="${idx}" ${isSelected ? 'checked' : ''} onchange="window.RightPanel.handleCheckboxChange(event, ${idx})">
                    </td>
                    <td class="track-info-cell">
                        <div class="track-title-wrapper">
                            <span class="track-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
                            <span class="track-artist" title="${escapeHtml(t.artist)}">· ${escapeHtml(t.artist)}</span>
                        </div>
                    </td>
                    <td class="track-album-col" title="${escapeHtml(t.album || '')}">
                        ${escapeHtml(t.album || '')}
                    </td>
                    <td class="track-duration-col">
                        ${formatTime(t.durationMillis)}
                    </td>
                    <td class="track-action-col">
                        <button class="btn-track-action play-song" onclick="window.RightPanel.playSong(${idx})" title="单曲播放">▶</button>
                        <button class="btn-track-action" onclick="window.RightPanel.openAddToPlaylistModal(${idx})" title="加入自建歌单">＋</button>
                        ${isViewingCustomPlaylist ? `
                            <button class="btn-track-action del-song" onclick="window.RightPanel.removeSongFromCustom(${idx})" title="从歌单移除">✕</button>
                        ` : ''}
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        detailBody.innerHTML = html;
        updateFloatingBatchBar();
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
        if (table) {
            if (selectedTrackIndices.size > 0) {
                table.classList.add("multi-select-mode");
            } else {
                table.classList.remove("multi-select-mode");
            }

            table.querySelectorAll('.track-checkbox[data-idx]').forEach(box => {
                const idx = parseInt(box.getAttribute("data-idx"), 10);
                box.checked = selectedTrackIndices.has(idx);
            });

            const checkAllBox = document.getElementById("checkAllBox");
            if (checkAllBox) {
                checkAllBox.checked = currentTracks.length > 0 && selectedTrackIndices.size === currentTracks.length;
            }
        }
        renderHeaderActions();
        updateFloatingBatchBar();
    }

    function updateFloatingBatchBar() {
        if (!floatingBatchBar) return;
        const count = selectedTrackIndices.size;
        if (count > 0) {
            floatingBatchBar.classList.add("show");
            if (batchCountText) batchCountText.innerText = `已选 ${count} 首`;
        } else {
            floatingBatchBar.classList.remove("show");
        }
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
    function toggleFavCurrentPlaylist() {
        if (isViewingCustomPlaylist || !currentPlaylistData?.id) return;
        const isFaved = window.StorageManager.isPlaylistFaved(currentPlaylistData.id);
        if (isFaved) {
            window.StorageManager.unfavPlaylist(currentPlaylistData.id);
            window.Shell?.showToast?.(`已取消收藏《${currentPlaylistData.name}》`);
            renderHeaderActions();
        } else {
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

    // 删除当前自建歌单
    function deleteCurrentCustomPlaylist() {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId) return;
        if (confirm(`确认删除自建歌单《${currentPlaylistData.name}》吗？`)) {
            window.StorageManager.deleteCustomPlaylist(currentCustomPlaylistId);
            window.Shell?.showToast?.(`已删除歌单《${currentPlaylistData.name}》`);
            if (detailTitle) detailTitle.innerText = "YY-Amusic";
            if (detailSubtitle) detailSubtitle.innerText = "请从左侧选择歌单或专辑";
            if (detailActions) detailActions.style.display = "none";
            if (detailBody) detailBody.innerHTML = '<div class="placeholder-box"><p>👈 请从左侧选择歌单或专辑浏览。</p></div>';
            currentTracks = [];
            currentPlaylistData = null;
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

    function removeSongFromCustom(idx) {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId || !currentTracks[idx]) return;
        const track = currentTracks[idx];
        window.StorageManager.removeTrackFromCustomPlaylist(currentCustomPlaylistId, track.name, track.artist);
        selectCustomPlaylist(currentCustomPlaylistId);
        window.Shell?.showToast?.(`已从歌单移除《${track.name}》`);
    }

    /**
     * 全局搜索结果直接在右侧详情区域展示 (遵照 SITE_ARCHITECTURE.md 规范)
     */
    async function handleSearch(term) {
        if (!term || !term.trim()) return;
        const query = term.trim();
        clearSelection();

        if (detailTitle) detailTitle.innerText = `搜索: "${query}"`;
        if (detailSubtitle) detailSubtitle.innerText = "正在检索 Apple 音乐库...";
        if (detailActions) detailActions.style.display = "none";
        if (detailBody) detailBody.innerHTML = '<div class="loading-state">🔍 正在检索匹配的歌曲与专辑...</div>';

        try {
            const encoded = encodeURIComponent(query);
            const sf = window.RegionPanel?.getStorefront?.() || "cn";
            const data = await window.apiRequest(`search?types=songs,albums,playlists&term=${encoded}&limit=30`);

            const songs = data?.results?.songs?.data || [];
            const albums = data?.results?.albums?.data || [];
            const playlists = data?.results?.playlists?.data || [];

            currentTracks = songs.map((t, idx) => {
                const attr = t.attributes;
                return {
                    index: idx + 1,
                    name: attr?.name || "未知曲目",
                    artist: attr?.artistName || "未知歌手",
                    album: attr?.albumName || "搜索结果",
                    durationMillis: attr?.durationInMillis || 0,
                    isrc: attr?.isrc || "",
                    url: attr?.url || ""
                };
            });

            const totalResults = songs.length + albums.length + playlists.length;
            if (totalResults === 0) {
                if (detailSubtitle) detailSubtitle.innerText = "未找到匹配结果";
                if (detailBody) detailBody.innerHTML = `<div class="loading-state">未找到与 "${escapeHtml(query)}" 相关的歌曲或专辑。</div>`;
                return;
            }

            if (detailSubtitle) {
                detailSubtitle.innerText = `检索到 ${songs.length} 首单曲 / ${albums.length} 张专辑 / ${playlists.length} 个歌单`;
            }

            renderHeaderActions();
            renderTracklist(currentTracks);

            if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                window.player.setPlaylist(currentTracks, -1);
            }
        } catch (err) {
            if (detailSubtitle) detailSubtitle.innerText = "检索失败";
            if (detailBody) detailBody.innerHTML = `<div class="loading-state">❌ 检索失败: ${escapeHtml(err.message)}</div>`;
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
        toggleFavCurrentPlaylist,
        deleteCurrentCustomPlaylist,
        openAddToPlaylistModal,
        confirmAddPendingToPlaylist,
        removeSongFromCustom,
        handleCheckboxChange,
        handleCheckAll,
        clearSelection,
        handleSearch,
        isViewingCustom: (id) => isViewingCustomPlaylist && currentCustomPlaylistId === id,
        updateCurrentCustomTitle: (newTitle) => {
            if (isViewingCustomPlaylist && detailTitle) {
                detailTitle.innerText = newTitle;
            }
        }
    };
})();
