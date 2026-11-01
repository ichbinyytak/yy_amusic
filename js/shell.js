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

    function init() {
        if (!window.player) {
            console.error("Player engine not loaded!");
            return;
        }

        // 监听播放器事件
        window.player.on("trackChange", (track) => {
            if (playerTitle) playerTitle.innerText = track?.title || track?.name || "未知歌曲";
            if (playerArtist) playerArtist.innerText = track?.artist || "未知歌手";
            if (playerCurTime) playerCurTime.innerText = "00:00";
            if (playerTotalTime) playerTotalTime.innerText = formatDuration(track?.durationMillis || 0);
            if (progressBarFill) progressBarFill.style.width = "0%";
            updatePlayPauseButton(true);
            updateQueueCount();
        });

        window.player.on("stateChange", ({ state }) => {
            updatePlayPauseButton(state === "playing");
        });

        window.player.on("timeUpdate", ({ currentTime, duration }) => {
            if (playerCurTime) playerCurTime.innerText = formatDuration(currentTime * 1000);
            if (duration && playerTotalTime) playerTotalTime.innerText = formatDuration(duration * 1000);
            if (progressBarFill && duration > 0) {
                const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
                progressBarFill.style.width = `${pct}%`;
            }
        });

        window.player.on("lyrics", ({ current, next, full, currentIndex }) => {
            renderLyrics(current, next, full, currentIndex);
        });

        window.player.on("modeChange", (mode) => {
            if (btnMode) btnMode.innerHTML = getModeSvg(mode);
        });

        window.player.on("playlistChange", () => {
            updateQueueCount();
        });

        // 初始化音量
        if (volumeSlider) {
            volumeSlider.value = (window.player.audio.volume * 100) || 80;
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

    // 进度条拖拽/点击跳转
    function handleProgressBarClick(e) {
        if (!window.player || !window.player.audio) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const duration = window.player.audio.duration;
        if (duration && !isNaN(duration)) {
            window.player.seek(duration * pct);
        }
    }

    // 播放模式切换
    function handleCycleMode() {
        if (!window.player) return;
        const modes = ["list-loop", "single-loop", "shuffle"];
        const cur = window.player.mode || "list-loop";
        const nxt = modes[(modes.indexOf(cur) + 1) % modes.length];
        window.player.setMode(nxt);
        const labels = { "list-loop": "列表循环", "single-loop": "单曲循环", "shuffle": "随机播放" };
        showToast(`已切换为: ${labels[nxt]}`);
    }

    function getModeSvg(mode) {
        if (mode === "single-loop") {
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
        if (isMuted) {
            handleVolumeChange(prevVolume || 80);
            if (volumeSlider) volumeSlider.value = prevVolume || 80;
        } else {
            prevVolume = volumeSlider ? volumeSlider.value : 80;
            handleVolumeChange(0);
            if (volumeSlider) volumeSlider.value = 0;
        }
    }

    function updateVolumeIcon(v) {
        if (!volumeIcon) return;
        if (v === 0) volumeIcon.innerText = "🔇";
        else if (v < 0.5) volumeIcon.innerText = "🔉";
        else volumeIcon.innerText = "🔊";
    }

    // 歌词渲染
    function renderLyrics(current, next, full, curIdx) {
        if (!lyricDock) return;
        const isExp = lyricDock.classList.contains("expanded");

        if (isExp && full && full.length > 0) {
            const start = Math.max(0, curIdx - 2);
            const slice = full.slice(start, start + 6);
            let html = '';
            slice.forEach((l, i) => {
                const realIdx = start + i;
                const cls = realIdx === curIdx ? 'lyric-line-current' : (realIdx < curIdx ? 'lyric-line-prev' : 'lyric-line-next');
                html += `<div class="lyric-line ${cls}">${escapeHtml(l.text)}</div>`;
            });
            if (lyricLinesWrapper) lyricLinesWrapper.innerHTML = html;
        } else {
            if (lyricLinesWrapper) {
                lyricLinesWrapper.innerHTML = `
                    <div class="lyric-line lyric-line-current">${escapeHtml(current || "♪ 纯文本底座已就绪")}</div>
                    <div class="lyric-line lyric-line-next">${escapeHtml(next || "点播歌曲，歌词毫秒级同步")}</div>
                `;
            }
        }
    }

    function expandLyricDock(e) {
        if (e.target.closest("#lyricCloseBtn")) return;
        if (!lyricDock) return;
        lyricDock.classList.add("expanded");
        if (window.player && window.player.lyricManager) {
            window.player.lyricManager.sync(window.player.audio.currentTime);
        }
    }

    function collapseLyricDock(e) {
        if (e) e.stopPropagation();
        if (lyricDock) lyricDock.classList.remove("expanded");
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
            sourcesListBody.innerHTML = '<div class="loading-state">暂无已加载音源脚本。</div>';
            return;
        }
        let html = '';
        list.forEach(src => {
            const isOk = src.status === 'ok';
            html += `
                <div class="source-card">
                    <div>
                        <strong>⚡ ${escapeHtml(src.name)}</strong>
                        <div style="font-size: 9.5px; color: var(--text-muted);">${escapeHtml(src.file || '')}</div>
                    </div>
                    <span class="source-status-badge ${isOk ? 'source-status-ok' : 'source-status-failed'}">
                        ${isOk ? '● 就绪' : '✕ 异常'}
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
            const res = await fetch("/api/sources_test", { method: "POST" });
            const data = await res.json();
            loadSources();
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
            const res = await fetch("/api/sources_sync", { method: "POST" });
            const data = await res.json();
            loadSources();
            showToast(`音源同步成功！当前生效: ${data.total_sources || 0} 个`);
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
        syncSources
    };
})();
