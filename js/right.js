/**
 * ========================================================
 * js/right.js - 右侧框架控制器 (歌单曲目明细、点播与收藏管理)
 * ========================================================
 */

window.RightPanel = (function () {
    let currentPlaylistData = null;
    let currentTracks = [];
    let isViewingCustomPlaylist = false;
    let currentCustomPlaylistId = null;
    let pendingTrackToAdd = null;

    // DOM 元素引用
    const detailTitle = document.getElementById("detailTitle");
    const detailSubtitle = document.getElementById("detailSubtitle");
    const detailActions = document.getElementById("detailActions");
    const detailBody = document.getElementById("detailBody");
    const btnFavCurrent = document.getElementById("btnFavCurrent");

    // 点击官方合集歌单 (如“新歌精选”、“正在流行中”)
    async function selectCuratedCollection(title, curator, url, roomUrl, fallbackTracks) {
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

        // 记忆上一次选中的歌单
        window.StorageManager.setLastPlaylist({
            kind: 'curated',
            name: title,
            curator: curator,
            url: url,
            roomUrl: roomUrl,
            tracks: currentTracks
        });

        if (detailTitle) detailTitle.innerText = title;
        if (detailSubtitle) detailSubtitle.innerText = `${curator} • 官方精选 (共 ${currentTracks.length} 首)`;
        if (detailActions) detailActions.style.display = currentTracks.length > 0 ? "flex" : "none";
        renderTracklist(currentTracks);
        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
            window.player.setPlaylist(currentTracks, -1);
        }

        // 如果包含官方 Room 专题页，自动在后台拉取完整的 100 首曲目
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
                        if (detailSubtitle) detailSubtitle.innerText = `${curator} • 官方完整专题 (共 ${currentTracks.length} 首)`;
                        if (detailActions) detailActions.style.display = "flex";
                        renderTracklist(currentTracks);
                        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                            window.player.setPlaylist(currentTracks, -1);
                        }
                    }
                }
            } catch (e) {
                console.warn("加载 room 详情失败，保持精选列表", e);
            }
        }
    }

    // 点击 Apple 官方歌单/专辑
    async function selectPlaylist(id, type, name, curator, url) {
        isViewingCustomPlaylist = false;
        currentCustomPlaylistId = null;
        currentPlaylistData = { id, type, name, curator, url };
        currentTracks = [];

        // 记忆上一次选中的歌单
        window.StorageManager.setLastPlaylist({
            kind: 'apple',
            id,
            type,
            name,
            curator,
            url
        });

        if (detailTitle) detailTitle.innerText = name;
        updateFavButtonStatus();

        const cacheKey = `playlist_${type}_${id}`;
        const cached = ClientCache.get(cacheKey);

        if (cached && cached.data && cached.data.length > 0) {
            currentTracks = cached.data;
            if (detailSubtitle) detailSubtitle.innerText = `${curator} • 共 ${currentTracks.length} 首歌曲`;
            if (detailActions) detailActions.style.display = "flex";
            renderTracklist(currentTracks);
            if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                window.player.setPlaylist(currentTracks, -1);
            }
        } else {
            if (detailSubtitle) detailSubtitle.innerText = `${curator} • 正在获取曲目清单...`;
            if (detailActions) detailActions.style.display = "none";
            if (detailBody) detailBody.innerHTML = '<div class="loading-state">正在向 Apple 数据库解析曲目列表...</div>';
        }

        try {
            const normalizedType = type.endsWith('s') ? type : `${type}s`;
            const endpoint = `${normalizedType}/${id}`;
            const data = await apiRequest(endpoint, cached?.etag);
            if (data === 304) return;

            const item = data?.data?.[0];
            const tracks = item?.relationships?.tracks?.data || [];

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

            ClientCache.set(cacheKey, currentTracks);
            if (detailSubtitle) detailSubtitle.innerText = `${curator} • 共 ${currentTracks.length} 首歌曲`;
            if (detailActions) detailActions.style.display = "flex";
            renderTracklist(currentTracks);
            if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
                window.player.setPlaylist(currentTracks, -1);
            }
        } catch (err) {
            if (!currentTracks || currentTracks.length === 0) {
                if (detailBody) detailBody.innerHTML = `<div class="loading-state">❌ 获取歌曲详情失败: ${err.message}</div>`;
                if (detailSubtitle) detailSubtitle.innerText = "获取曲目清单失败";
            }
        }
    }

    // 点击自建歌单
    function selectCustomPlaylist(playlistId) {
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
        if (detailSubtitle) detailSubtitle.innerText = `我的自建歌单 • 共 ${currentTracks.length} 首歌曲`;
        updateFavButtonStatus();
        if (detailActions) detailActions.style.display = "flex";

        renderTracklist(currentTracks);
        if (window.player && (!window.player.isPlaying || window.player.playlist.length === 0)) {
            window.player.setPlaylist(currentTracks, -1);
        }
    }

    // 渲染曲目表格 (高密度 3 列)
    function renderTracklist(tracks) {
        if (!detailBody) return;
        if (!tracks || tracks.length === 0) {
            detailBody.innerHTML = '<div class="loading-state">该歌单暂无曲目。</div>';
            return;
        }

        const curPlayingSong = window.player && window.player.playlist[window.player.currentIndex];

        let html = `
            <table class="track-table">
                <thead>
                    <tr>
                        <th class="track-index">#</th>
                        <th class="track-info-th">歌曲 / 歌手</th>
                        <th class="track-action">操作</th>
                    </tr>
                </thead>
                <tbody>
        `;

        tracks.forEach((t, idx) => {
            const isPlayingThis = curPlayingSong &&
                (curPlayingSong.title === t.name || curPlayingSong.name === t.name) &&
                (curPlayingSong.artist === t.artist);
            const rowClass = isPlayingThis ? 'track-row-playing' : '';

            html += `
                <tr class="${rowClass}" id="track-row-${idx}">
                    <td class="track-index">${isPlayingThis ? '🔊' : (t.index || idx + 1)}</td>
                    <td class="track-info-cell">
                        <div class="track-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
                        <div class="track-artist" title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</div>
                    </td>
                    <td class="track-action">
                        <button class="btn-play-song" onclick="window.RightPanel.playSong(${idx})" title="立即播放此歌曲">▶</button>
                        <button class="btn-add-to-pl" onclick="window.RightPanel.openAddToPlaylistModal(${idx})" title="加入我的自建歌单">➕</button>
                        ${isViewingCustomPlaylist ? `<button class="btn-remove-song" onclick="window.RightPanel.removeSongFromCustom(${idx})" title="从歌单移除">✕</button>` : ''}
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        detailBody.innerHTML = html;
    }

    // 播放全部
    function playCurrentAll() {
        if (!currentTracks || currentTracks.length === 0) {
            showToast("当前歌单暂无可播放曲目");
            return;
        }
        if (window.player) {
            window.player.playTracklist(currentTracks, 0);
            showToast(`已开始播放当前歌单全部 ${currentTracks.length} 首歌曲`);
        }
    }

    // 点击单曲播放
    function playSong(idx) {
        if (!currentTracks || !currentTracks[idx]) return;
        if (window.player) {
            window.player.playTracklist(currentTracks, idx);
        }
    }

    // 收藏 / 管理当前官方歌单 (弹出与“添加到我的歌单”完全一致的分类弹窗)
    function toggleFavCurrentPlaylist() {
        if (isViewingCustomPlaylist || !currentPlaylistData?.id) return;
        const plData = {
            id: currentPlaylistData.id,
            type: currentPlaylistData.type || "playlist",
            name: currentPlaylistData.name,
            title: currentPlaylistData.name,
            curator: currentPlaylistData.curator || "Apple Music",
            url: currentPlaylistData.url || "",
            trackCount: currentTracks ? currentTracks.length : 0
        };
        window.Shell.openAddToFavModal(plData);
    }

    function updateFavButtonStatus() {
        if (!btnFavCurrent) return;
        if (isViewingCustomPlaylist || !currentPlaylistData?.id) {
            btnFavCurrent.style.display = "none";
            return;
        }
        btnFavCurrent.style.display = "inline-flex";
        const isFav = window.StorageManager.isPlaylistFaved(currentPlaylistData.id);
        if (isFav) {
            btnFavCurrent.innerHTML = "★";
            btnFavCurrent.style.color = "#ff7588";
            btnFavCurrent.title = "已收藏 (点击更改分类或取消收藏)";
        } else {
            btnFavCurrent.innerHTML = "⭐";
            btnFavCurrent.style.color = "";
            btnFavCurrent.title = "收藏此歌单 (选择分类)";
        }
    }

    // 自建歌单添加单曲模态框
    function openAddToPlaylistModal(trackIdx) {
        const song = currentTracks[trackIdx];
        if (!song) return;
        pendingTrackToAdd = song;

        const modal = document.getElementById("addToPlaylistModal");
        const infoEl = document.getElementById("addToSongInfo");
        const choiceList = document.getElementById("playlistChoiceList");

        if (infoEl) infoEl.innerText = `${song.name} - ${song.artist}`;
        if (choiceList) {
            const customs = window.StorageManager.getCustomPlaylists();
            if (customs.length === 0) {
                choiceList.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:11px;">您还没有自建歌单，请在下方直接新建：</div>';
            } else {
                let html = '';
                customs.forEach(c => {
                    const count = (c.tracks || []).length;
                    html += `
                        <div class="playlist-choice-item" onclick="window.RightPanel.addTrackToExistingPlaylist('${c.id}')">
                            <strong>${escapeHtml(c.title)}</strong>
                            <span class="meta-tag">共 ${count} 首</span>
                        </div>
                    `;
                });
                choiceList.innerHTML = html;
            }
        }
        if (modal) modal.classList.add("open");
    }

    function closeAddToPlaylistModal() {
        const modal = document.getElementById("addToPlaylistModal");
        if (modal) modal.classList.remove("open");
        pendingTrackToAdd = null;
    }

    function addTrackToExistingPlaylist(playlistId) {
        if (!pendingTrackToAdd) return;
        const res = window.StorageManager.addTrackToCustomPlaylist(playlistId, pendingTrackToAdd);
        if (res.duplicate) {
            showToast(`《${pendingTrackToAdd.name}》已在该歌单中`);
            closeAddToPlaylistModal();
            return;
        }
        if (res.ok) {
            showToast(`已加入歌单《${res.playlist ? res.playlist.title : ''}》！`);
            closeAddToPlaylistModal();
            if (isViewingCustomPlaylist && currentCustomPlaylistId === playlistId) {
                selectCustomPlaylist(playlistId);
            }
        }
    }

    function removeSongFromCustom(idx) {
        if (!isViewingCustomPlaylist || !currentCustomPlaylistId) return;
        const success = window.StorageManager.removeTrackFromCustomPlaylist(currentCustomPlaylistId, idx);
        if (success) {
            selectCustomPlaylist(currentCustomPlaylistId);
            showToast(`已从自建歌单移除该曲目`);
        }
    }

    function confirmCreateAndAdd() {
        const input = document.getElementById("newPlaylistInput");
        const name = input ? input.value.trim() : "";
        if (!name) {
            showToast("歌单名称不能为空");
            return;
        }
        if (!pendingTrackToAdd) return;

        const newPl = window.StorageManager.createCustomPlaylist(name);
        if (newPl) {
            window.StorageManager.addTrackToCustomPlaylist(newPl.id, pendingTrackToAdd);
            showToast(`已新建歌单《${newPl.title}》并加入歌曲！`);
            if (input) input.value = "";
            closeAddToPlaylistModal();
        }
    }

    function highlightPlayingTrack() {
        if (!currentTracks || currentTracks.length === 0) return;
        renderTracklist(currentTracks);
    }

    return {
        selectPlaylist,
        selectCuratedCollection,
        selectCustomPlaylist,
        renderTracklist,
        highlightPlayingTrack,
        playCurrentAll,
        playSong,
        toggleFavCurrentPlaylist,
        openAddToPlaylistModal,
        closeAddToPlaylistModal,
        addTrackToExistingPlaylist,
        removeSongFromCustom,
        confirmCreateAndAdd
    };
})();
