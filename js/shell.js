/**
 * ========================================================
 * js/shell.js - 主页框架控制器 (播放器底栏、双态歌词与抽屉管理)
 * ========================================================
 */

window.Shell = (function () {
    // DOM 元素引用
    const playerTitle = document.getElementById("playerTitle");
    const playerArtist = document.getElementById("playerArtist");
    const btnPlayPause = document.getElementById("btnPlayPause");
    const btnMode = document.getElementById("btnMode");
    const playerCurTime = document.getElementById("playerCurTime");
    const playerTotalTime = document.getElementById("playerTotalTime");
    const progressBarFill = document.getElementById("progressBarFill");
    const queueCount = document.getElementById("queueCount");
    const lyricDock = document.getElementById("lyricDock");
    const lyricCurrentLine = document.getElementById("lyricCurrentLine");
    const lyricNextLine = document.getElementById("lyricNextLine");
    const lyricLinesWrapper = document.getElementById("lyricLinesWrapper");
    const queueDrawer = document.getElementById("queueDrawer");
    const sourceDrawer = document.getElementById("sourceDrawer");
    const drawerBackdrop = document.getElementById("drawerBackdrop");
    const queueListBody = document.getElementById("queueListBody");
    const sourcesListBody = document.getElementById("sourcesListBody");
    const volumeSlider = document.getElementById("volumeSlider");
    const volumeIcon = document.getElementById("volumeIcon");

    let isMuted = false;
    let prevVolume = 80;
    let isLyricExpanded = false;
    let lastLyricIdx = -1;
    let currentSongLyricLines = [];

    function init() {
        if (!window.player) {
            console.error("Player engine not loaded!");
            return;
        }

        // 监听播放器事件
        window.player.on("trackChange", ({ index, song }) => {
            const track = song || {};
            const title = track.title || track.name || "未知歌曲";
            const artist = track.artist || "未知歌手";
            const album = track.album || "";

            if (playerTitle) playerTitle.innerText = `${artist} - ${title}`;
            if (playerArtist) playerArtist.innerText = album ? `专辑: ${album}` : "Apple Music 精选曲目";
            if (playerCurTime) playerCurTime.innerText = "00:00";
            if (playerTotalTime) playerTotalTime.innerText = formatDuration(track.durationMillis || (track.duration ? track.duration * 1000 : 0));
            if (progressBarFill) progressBarFill.style.width = "0%";
            updatePlayPauseButton(true);
            updateQueueCount();

            // 重新高亮右侧当前正在播放的曲目
            if (window.RightPanel && window.RightPanel.highlightPlayingTrack) {
                window.RightPanel.highlightPlayingTrack();
            }
        });

        window.player.on("stateChange", ({ isPlaying, isResolving, error }) => {
            updatePlayPauseButton(isPlaying);
            if (error) {
                showToast(`播放提示: ${error}`);
            }
        });

        window.player.on("timeUpdate", ({ currentTime, duration, percent, formattedCurrent, formattedDuration }) => {
            if (playerCurTime) playerCurTime.innerText = formattedCurrent || formatDuration(currentTime * 1000);
            if (playerTotalTime && duration) playerTotalTime.innerText = formattedDuration || formatDuration(duration * 1000);
            if (progressBarFill && percent !== undefined) {
                progressBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
            }
        });

        window.player.on("lyricUpdate", ({ index, currentLine, nextLine, allLines }) => {
            lastLyricIdx = index;
            currentSongLyricLines = allLines || [];
            renderLyricsView(currentLine, nextLine);
        });

        window.player.on("modeChange", (mode) => {
            if (btnMode) btnMode.innerHTML = getModeSvg(mode);
        });

        window.player.on("playlistChange", () => {
            updateQueueCount();
            renderQueueList();
        });

        // 初始化音量与播放模式图标
        if (volumeSlider) {
            volumeSlider.value = (window.player.audio.volume * 100) || 80;
        }
        if (btnMode) {
            btnMode.innerHTML = getModeSvg(window.player.playMode || "loop");
        }
    }

    function updatePlayPauseButton(isPlaying) {
        if (!btnPlayPause) return;
        if (isPlaying) {
            btnPlayPause.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
            btnPlayPause.title = "暂停";
        } else {
            btnPlayPause.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
            btnPlayPause.title = "播放";
        }
    }

    function updateQueueCount() {
        if (queueCount && window.player) {
            queueCount.innerText = (window.player.playlist || []).length;
        }
    }

    // 进度条拖拽/点击跳转 (0 ~ 1 比例)
    function handleProgressBarClick(e) {
        if (!window.player) return;
        const bar = document.getElementById("progressBarBg");
        if (!bar) return;
        const rect = bar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        window.player.seek(pct);
    }

    // 播放模式切换
    function handleCycleMode() {
        if (!window.player) return;
        const mode = window.player.cycleMode();
        const info = window.player.getModeLabel();
        if (btnMode) {
            btnMode.innerHTML = getModeSvg(mode);
            btnMode.title = `播放模式: ${info.label}`;
        }
        showToast(`已切换为: ${info.label}`);
    }

    function getModeSvg(mode) {
        if (mode === "single" || mode === "single-loop") {
            return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="10" y="16" font-size="8" fill="currentColor" stroke="none" font-weight="bold">1</text></svg>`;
        }
        if (mode === "shuffle") {
            return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`;
        }
        return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
    }

    // 音量与静音
    function handleVolumeChange(val) {
        const v = Math.max(0, Math.min(100, val)) / 100;
        if (window.player) window.player.setVolume(v);
        isMuted = (v === 0);
        updateVolumeIcon(v);
    }

    function toggleMute() {
        if (!window.player) return;
        const isMutedNow = window.player.toggleMute();
        if (isMutedNow) {
            updateVolumeIcon(0);
            if (volumeSlider) volumeSlider.value = 0;
            showToast("已静音 🔇");
        } else {
            const v = (window.player.savedVolume !== undefined ? window.player.savedVolume : (window.player.audio.volume || 0.8));
            updateVolumeIcon(v);
            if (volumeSlider) volumeSlider.value = Math.round(v * 100);
            showToast(`恢复音量: ${Math.round(v * 100)}% 🔊`);
        }
    }

    function updateVolumeIcon(v) {
        if (!volumeIcon) return;
        if (v === 0) volumeIcon.innerText = "🔇";
        else if (v < 0.5) volumeIcon.innerText = "🔉";
        else volumeIcon.innerText = "🔊";
    }

    // 歌词渲染 (平时 2 行 ⇄ 点击拉伸为 6 行)
    function renderLyricsView(curText, nxtText) {
        if (!lyricLinesWrapper) return;
        if (!isLyricExpanded) {
            lyricLinesWrapper.innerHTML = `
                <div class="lyric-line lyric-line-current">${escapeHtml(curText || "♪ 纯文本底座已就绪")}</div>
                <div class="lyric-line lyric-line-next">${escapeHtml(nxtText || "点播歌曲，歌词毫秒级同步")}</div>
            `;
        } else {
            if (!currentSongLyricLines || currentSongLyricLines.length === 0) {
                lyricLinesWrapper.innerHTML = '<div class="lyric-line lyric-line-current">纯音乐或暂无歌词</div>';
                return;
            }
            const cur = lastLyricIdx >= 0 ? lastLyricIdx : 0;
            const start = Math.max(0, cur - 2);
            const end = Math.min(currentSongLyricLines.length, start + 6);
            const slice = currentSongLyricLines.slice(start, end);
            let html = '';
            slice.forEach((item, wIdx) => {
                const actualIdx = start + wIdx;
                let cls = 'lyric-line';
                if (actualIdx === cur) cls += ' lyric-line-current';
                else if (actualIdx < cur) cls += ' lyric-line-prev';
                else cls += ' lyric-line-next';
                html += `<div class="${cls}">${escapeHtml(item.text)}</div>`;
            });
            lyricLinesWrapper.innerHTML = html;
        }
    }

    function expandLyricDock(e) {
        if (e && e.target.closest("#lyricCloseBtn")) return;
        if (!lyricDock) return;
        isLyricExpanded = true;
        lyricDock.classList.add("expanded");
        const curLine = (lastLyricIdx >= 0 && currentSongLyricLines[lastLyricIdx]) ? currentSongLyricLines[lastLyricIdx].text : "";
        const nextLine = (lastLyricIdx + 1 < currentSongLyricLines.length) ? currentSongLyricLines[lastLyricIdx + 1].text : "";
        renderLyricsView(curLine, nextLine);
    }

    function collapseLyricDock(e) {
        if (e) e.stopPropagation();
        if (!lyricDock) return;
        isLyricExpanded = false;
        lyricDock.classList.remove("expanded");
        const curLine = (lastLyricIdx >= 0 && currentSongLyricLines[lastLyricIdx]) ? currentSongLyricLines[lastLyricIdx].text : "";
        const nextLine = (lastLyricIdx + 1 < currentSongLyricLines.length) ? currentSongLyricLines[lastLyricIdx + 1].text : "";
        renderLyricsView(curLine, nextLine);
    }

    // 抽屉管理：队列与音源
    function toggleQueueModal() {
        if (!queueDrawer) return;
        const isOpen = queueDrawer.classList.toggle("open");
        if (isOpen) {
            if (sourceDrawer) sourceDrawer.classList.remove("open");
            if (drawerBackdrop) drawerBackdrop.classList.add("open");
            renderQueueList();
        } else {
            if (drawerBackdrop) drawerBackdrop.classList.remove("open");
        }
    }

    function renderQueueList() {
        if (!queueListBody || !window.player) return;
        const list = window.player.playlist || [];
        const curIdx = window.player.currentIndex;

        if (list.length === 0) {
            queueListBody.innerHTML = '<div class="loading-state">当前播放队列为空</div>';
            return;
        }

        let html = '';
        list.forEach((item, idx) => {
            const isActive = idx === curIdx;
            const title = item.title || item.name || "未知歌曲";
            const artist = item.artist || "未知歌手";
            html += `
                <div class="queue-item ${isActive ? 'active' : ''}" onclick="window.player.playIndex(${idx}); window.Shell.toggleQueueModal();">
                    <div>
                        <span style="font-family: var(--font-mono); margin-right: 6px; opacity: 0.7;">${idx + 1}.</span>
                        <strong>${escapeHtml(title)}</strong>
                        <span style="opacity: 0.7; font-size: 10px; margin-left: 6px;">${escapeHtml(artist)}</span>
                    </div>
                    <span>${isActive ? '🔊 播放中' : ''}</span>
                </div>
            `;
        });
        queueListBody.innerHTML = html;
    }

    function toggleSourceModal() {
        if (!sourceDrawer) return;
        const isOpen = sourceDrawer.classList.toggle("open");
        if (isOpen) {
            if (queueDrawer) queueDrawer.classList.remove("open");
            if (drawerBackdrop) drawerBackdrop.classList.add("open");
            loadSources();
        } else {
            if (drawerBackdrop) drawerBackdrop.classList.remove("open");
        }
    }

    async function loadSources() {
        if (!sourcesListBody) return;
        sourcesListBody.innerHTML = '<div class="loading-state">正在获取底层音源状态...</div>';
        try {
            const res = await fetch("/api/sources");
            const list = await res.json();
            renderSourceList(list);
        } catch (err) {
            sourcesListBody.innerHTML = `<div class="loading-state">❌ 获取音源失败: ${err.message}</div>`;
        }
    }

    function renderSourceList(list) {
        if (!sourcesListBody) return;
        if (!list || list.length === 0) {
            sourcesListBody.innerHTML = '<div class="loading-state">暂无已注册音源。</div>';
            return;
        }

        // 优先展示就绪与可用音源
        const sorted = [...list].sort((a, b) => {
            const aOk = a.status === 'ok' ? 0 : (a.status === 'untested' ? 1 : 2);
            const bOk = b.status === 'ok' ? 0 : (b.status === 'untested' ? 1 : 2);
            return aOk - bOk;
        });

        const okCount = list.filter(s => s.status === 'ok').length;
        const untestedCount = list.filter(s => s.status === 'untested').length;
        const failedCount = list.filter(s => s.status !== 'ok' && s.status !== 'untested').length;

        let html = `
            <div style="padding: 8px 12px; margin-bottom: 8px; background: rgba(255,255,255,0.04); border-radius: 6px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); border: 1px solid rgba(255,255,255,0.06);">
                <span>共装载 <b style="color:#fff;">${list.length}</b> 个底层音源</span>
                <span>
                    <span style="color:#3fb950; font-weight:600;">● 就绪: ${okCount}</span> &nbsp;|&nbsp; 
                    <span style="color:#58a6ff;">○ 待命: ${untestedCount}</span> &nbsp;|&nbsp; 
                    <span style="color:#8b949e;">✕ 离线: ${failedCount}</span>
                </span>
            </div>
        `;
        sorted.forEach((s, idx) => {
            const isOk = s.status === 'ok';
            const isUntested = s.status === 'untested';
            const statusClass = isOk ? 'source-status-ok' : (isUntested ? 'source-status-untested' : 'source-status-failed');
            const statusLabel = isOk ? `● 就绪 (${s.latency_ms} ms)` : (isUntested ? '○ 待命备用' : '✕ 离线');

            html += `
                <div class="source-card">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-family: var(--font-mono); color: var(--text-muted); font-size: 10px; width: 22px;">#${idx + 1}</span>
                        <div>
                            <div style="font-weight: 600; font-size: 11.5px; color: #fff;">⚡ ${escapeHtml(s.name)}</div>
                            <div style="font-size: 9.5px; color: var(--text-muted);">
                                平台: ${(s.platform || 'KW').toUpperCase()} • 命中: ${s.success_count || 0} 次 • 连败: ${s.consecutive_fails || 0}
                            </div>
                        </div>
                    </div>
                    <span class="source-status-badge ${statusClass}">
                        ${statusLabel}
                    </span>
                </div>
            `;
        });
        sourcesListBody.innerHTML = html;
    }

    async function testSources() {
        const btn = document.getElementById("btnTestSources");
        if (btn) btn.innerText = "⏳ 测速中...";
        try {
            const res = await fetch("/api/sources/test", { method: "POST" });
            const data = await res.json();
            renderSourceList(data);
            showToast("音源测速完成！");
        } catch (err) {
            showToast(`测速失败: ${err.message}`);
        } finally {
            if (btn) btn.innerText = "⚡ 测速";
        }
    }

    async function syncSources() {
        const btn = document.getElementById("btnSyncSources");
        if (btn) btn.innerText = "⏳ 同步中...";
        try {
            const res = await fetch("/api/sources/sync", { method: "POST" });
            const data = await res.json();
            renderSourceList(data);
            showToast(`音源同步成功！当前生效: ${data.length || 0} 个`);
        } catch (err) {
            showToast(`同步失败: ${err.message}`);
        } finally {
            if (btn) btn.innerText = "🔄 同步";
        }
    }

    function closeAllDrawers() {
        if (queueDrawer) queueDrawer.classList.remove("open");
        if (sourceDrawer) sourceDrawer.classList.remove("open");
        if (drawerBackdrop) drawerBackdrop.classList.remove("open");
    }

    /* -------------------- 收藏到分类弹窗管理 -------------------- */
    let pendingFavPlaylist = null;

    function openAddToFavModal(playlistData) {
        if (!playlistData || !playlistData.id) return;
        pendingFavPlaylist = playlistData;

        const modal = document.getElementById("addToFavModal");
        const infoEl = document.getElementById("favModalPlaylistInfo");
        const choiceList = document.getElementById("favCategoryChoiceList");
        const input = document.getElementById("newFavCategoryInput");

        if (input) input.value = "";
        const name = playlistData.name || playlistData.title || "未知歌单";
        const curator = playlistData.curator || "Apple Music";
        const isFaved = window.StorageManager.isPlaylistFaved(playlistData.id);

        let curCat = "";
        if (isFaved) {
            const favs = window.StorageManager.getFavPlaylists();
            const curItem = favs.find(f => f.id === playlistData.id);
            curCat = curItem ? (curItem.category || "未分类") : "未分类";
        }

        if (infoEl) {
            infoEl.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${escapeHtml(name)} <span style="opacity:0.7; font-size:10px;">• ${escapeHtml(curator)}</span></span>
                    ${isFaved ? `
                        <button class="btn btn-sm btn-ghost" style="color:#ff7588; font-size:10px; padding:1px 5px; cursor:pointer;" onclick="window.Shell.unfavCurrentFromModal()" title="取消收藏">✕ 取消收藏</button>
                    ` : ''}
                </div>
            `;
        }

        if (choiceList) {
            const cats = window.StorageManager.getRegisteredCategories('fav');
            const favs = window.StorageManager.getFavPlaylists();
            let html = '';
            cats.forEach(c => {
                const count = favs.filter(f => (f.category || '未分类') === c).length;
                const isCurrent = isFaved && curCat === c;
                html += `
                    <div class="playlist-choice-item" onclick="window.Shell.selectFavCategory('${escapeHtml(c)}')" style="${isCurrent ? 'background:rgba(88,166,255,0.15); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>📁 ${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:9.5px; margin-left:6px;">(当前分类)</span>' : ''}
                        </div>
                        <span class="meta-tag">共 ${count} 个歌单</span>
                    </div>
                `;
            });
            choiceList.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeAddToFavModal() {
        const modal = document.getElementById("addToFavModal");
        if (modal) modal.classList.remove("open");
        pendingFavPlaylist = null;
    }

    function selectFavCategory(catName) {
        if (!pendingFavPlaylist) return;
        window.StorageManager.favPlaylistWithCategory(pendingFavPlaylist, catName);
        showToast(`⭐ 已将歌单收藏至【${catName}】！`);
        closeAddToFavModal();
        if (window.RightPanel && window.RightPanel.updateFavButtonStatus) {
            window.RightPanel.updateFavButtonStatus();
        }
        if (window.LeftPanel && window.LeftPanel.loadLibraryPage) {
            window.LeftPanel.loadLibraryPage();
        }
    }

    function confirmCreateCategoryAndFav() {
        if (!pendingFavPlaylist) return;
        const input = document.getElementById("newFavCategoryInput");
        const name = input ? input.value.trim() : "";
        if (!name) {
            showToast("请输入新分类名称");
            return;
        }
        window.StorageManager.addCategory('fav', name);
        window.StorageManager.favPlaylistWithCategory(pendingFavPlaylist, name);
        showToast(`⭐ 已创建分类【${name}】并成功收藏！`);
        closeAddToFavModal();
        if (window.RightPanel && window.RightPanel.updateFavButtonStatus) {
            window.RightPanel.updateFavButtonStatus();
        }
        if (window.LeftPanel && window.LeftPanel.loadLibraryPage) {
            window.LeftPanel.loadLibraryPage();
        }
    }

    function unfavCurrentFromModal() {
        if (!pendingFavPlaylist) return;
        window.StorageManager.unfavPlaylist(pendingFavPlaylist.id);
        showToast(`已从收藏夹中移除《${pendingFavPlaylist.name || pendingFavPlaylist.title}》`);
        closeAddToFavModal();
        if (window.RightPanel && window.RightPanel.updateFavButtonStatus) {
            window.RightPanel.updateFavButtonStatus();
        }
        if (window.LeftPanel && window.LeftPanel.loadLibraryPage) {
            window.LeftPanel.loadLibraryPage();
        }
    }

    return {
        init,
        handleProgressBarClick,
        handleCycleMode,
        handleVolumeChange,
        toggleMute,
        expandLyricDock,
        collapseLyricDock,
        toggleQueueModal,
        toggleSourceModal,
        closeAllDrawers,
        testSources,
        syncSources,
        openAddToFavModal,
        closeAddToFavModal,
        selectFavCategory,
        confirmCreateCategoryAndFav,
        unfavCurrentFromModal
    };
})();
