/**
 * ========================================================
 * js/shell.js - 主页外壳控制器 (遵照 SITE_ARCHITECTURE.md)
 * 职责：
 * 1. 顶部紧凑搜索栏：输入后直接将结果路由到右侧详情区域
 * 2. 底部全局播放器播控与双行时间轴歌词
 * 3. 垂直音量直立滑块弹窗 (🔊 纯图标点击向上弹出，滑到底为 0，无静音按钮)
 * 4. 抽屉与收藏弹窗管理
 * ========================================================
 */

window.Shell = (function () {
    'use strict';

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
    const volumePopup = document.getElementById("volumePopup");
    const volumeVerticalSlider = document.getElementById("volumeVerticalSlider");
    const searchInput = document.getElementById("searchInput");
    const clearBtn = document.getElementById("clearBtn");
    const toast = document.getElementById("toast");

    let toastTimer = null;
    let isLyricExpanded = false;
    let lastLyricIdx = -1;
    let currentSongLyricLines = [];

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatDuration(ms) {
        if (!ms || isNaN(ms)) return "00:00";
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
    }

    function init() {
        if (!window.player) {
            console.error("[Shell] 播放引擎未就绪");
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

            // 重新高亮右侧当前正在播放的行
            document.querySelectorAll(".track-table tr").forEach(tr => tr.classList.remove("track-row-playing"));
            const playingRow = document.getElementById(`track-row-${index}`);
            if (playingRow) playingRow.classList.add("track-row-playing");
        });

        window.player.on("stateChange", ({ isPlaying, error }) => {
            updatePlayPauseButton(isPlaying);
            if (error) showToast(`播放提示: ${error}`);
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

        // 初始化音量滑块
        if (volumeVerticalSlider) {
            const currentVol = (window.player.audio.volume * 100) || 80;
            volumeVerticalSlider.value = currentVol;
        }

        // 点击页面任意外部关闭音量弹窗
        document.addEventListener("click", (e) => {
            if (volumePopup && !e.target.closest(".volume-wrapper")) {
                volumePopup.classList.remove("open");
            }
        });

        // 搜索框回车监听
        if (searchInput) {
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    handleSearch();
                }
            });
            searchInput.addEventListener("input", (e) => {
                if (clearBtn) {
                    clearBtn.style.display = e.target.value ? "inline-flex" : "none";
                }
            });
        }
    }

    /* -------------------- 顶栏搜索交互 -------------------- */
    function handleSearch() {
        const query = searchInput ? searchInput.value.trim() : "";
        if (!query) return;
        if (window.SearchPanel) {
            window.SearchPanel.search(query);
        } else {
            window.RightPanel?.handleSearch?.(query);
        }
    }

    function clearSearch() {
        if (window.SearchPanel) {
            window.SearchPanel.exitSearch();
        } else {
            if (searchInput) searchInput.value = "";
            if (clearBtn) clearBtn.style.display = "none";
            window.LeftPanel?.exitSearch?.();
        }
    }

    function exitSearch() {
        if (window.SearchPanel) {
            window.SearchPanel.exitSearch();
        } else {
            if (searchInput) searchInput.value = "";
            if (clearBtn) clearBtn.style.display = "none";
            window.LeftPanel?.exitSearch?.();
        }
    }

    /* -------------------- 音量直立弹窗交互 -------------------- */
    function toggleVolumePopup() {
        if (!volumePopup) return;
        volumePopup.classList.toggle("open");
    }

    function handleVerticalVolumeChange(val) {
        const v = Math.max(0, Math.min(100, val)) / 100;
        if (window.player) window.player.setVolume(v);
    }

    /* -------------------- 播控与进度条 -------------------- */
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

    function handleProgressBarClick(e) {
        if (!window.player) return;
        const bar = document.getElementById("progressBarBg");
        if (!bar) return;
        const rect = bar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        window.player.seek(pct);
    }

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

    /* -------------------- 歌词系统 -------------------- */
    function renderLyricsView(curText, nxtText) {
        if (!lyricLinesWrapper) return;
        if (!isLyricExpanded) {
            lyricLinesWrapper.innerHTML = `
                <div class="lyric-line lyric-line-current">${escapeHtml(curText || "♪ YY-Amusic 纯文本底座已就绪")}</div>
                <div class="lyric-line lyric-line-next">${escapeHtml(nxtText || "点播任意歌曲，歌词毫秒级同步")}</div>
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

    /* -------------------- 抽屉与音源管理 -------------------- */
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
        list.forEach((t, idx) => {
            const isPlaying = idx === curIdx;
            html += `
                <div class="queue-item ${isPlaying ? 'active' : ''}" onclick="window.player.playIndex(${idx})">
                    <span>${isPlaying ? '🔊 ' : (idx + 1) + '. '}${escapeHtml(t.name || t.title)} - ${escapeHtml(t.artist)}</span>
                    <span style="font-family:var(--font-mono); font-size:var(--fs-t4); opacity:0.7;">${formatDuration(t.durationMillis)}</span>
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
            loadSourcesList();
        } else {
            if (drawerBackdrop) drawerBackdrop.classList.remove("open");
        }
    }

    async function loadSourcesList() {
        if (!sourcesListBody) return;
        sourcesListBody.innerHTML = '<div class="loading-state">正在检测音源...</div>';
        try {
            const res = await fetch("/api/sources");
            const data = await res.json();
            renderSourceList(data);
        } catch (err) {
            sourcesListBody.innerHTML = `<div class="loading-state">获取音源失败: ${escapeHtml(err.message)}</div>`;
        }
    }

    function renderSourceList(data) {
        if (!sourcesListBody) return;
        const sources = Array.isArray(data) ? data : (data.sources || []);
        const testedAt = (!Array.isArray(data) && data) ? (data.tested_at || data.updated_at) : null;

        // 更新抽屉副标题显示最后更新与测速时间
        const subtitleEl = document.querySelector(".source-drawer-subtitle");
        if (subtitleEl) {
            let timeStr = "";
            if (testedAt) {
                try {
                    const d = new Date(testedAt);
                    if (!isNaN(d.getTime())) {
                        const pad = n => String(n).padStart(2, '0');
                        const Y = d.getFullYear();
                        const M = pad(d.getMonth() + 1);
                        const D = pad(d.getDate());
                        const h = pad(d.getHours());
                        const m = pad(d.getMinutes());
                        timeStr = `${Y}-${M}-${D} ${h}:${m}`;
                    } else {
                        timeStr = testedAt;
                    }
                } catch(e) {
                    timeStr = testedAt;
                }
            }
            if (timeStr) {
                subtitleEl.innerHTML = `云端每日自动测速 · 最近更新: <span style="color:var(--text-main); font-weight:600;">${escapeHtml(timeStr)}</span> · 双核冲刺毫秒出声`;
            } else {
                subtitleEl.innerText = "云端每日自动测速与同步，双核并发冲刺，毫秒出声";
            }
        }

        if (sources.length === 0) {
            sourcesListBody.innerHTML = '<div class="loading-state">暂无可用的音源</div>';
            return;
        }

        let html = '';
        sources.forEach((s) => {
            const latVal = (s.latency_ms !== undefined && s.latency_ms !== null) ? s.latency_ms : s.latency;
            const isOk = s.status === "ok" && (latVal !== undefined && latVal > 0 && latVal < 5000);
            const latencyText = (latVal !== undefined && latVal !== null && latVal > 0 && isOk)
                ? `${latVal}ms`
                : (isOk ? "在线" : "已失效");
            html += `
                <div class="source-card">
                    <div>
                        <strong>${escapeHtml(s.name || s.id)}</strong>
                        <div style="font-size:var(--fs-t4); color:var(--text-muted);">${escapeHtml(s.type || (s.platform ? s.platform.toUpperCase() : '内置音源'))}</div>
                    </div>
                    <span class="source-status-badge ${isOk ? 'source-status-ok' : 'source-status-failed'}">${latencyText}</span>
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

    /* -------------------- 弹窗：添加到收藏分类 -------------------- */
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
                    <span>${escapeHtml(name)} <span style="opacity:0.7; font-size:var(--fs-t4);">• ${escapeHtml(curator)}</span></span>
                    ${isFaved ? `
                        <button class="btn btn-sm btn-ghost" style="color:#ff7588; font-size:var(--fs-t4); padding:1px 5px; cursor:pointer;" onclick="window.Shell.unfavCurrentFromModal()" title="取消收藏">✕ 取消收藏</button>
                    ` : ''}
                </div>
            `;
        }

        if (choiceList) {
            const cats = window.StorageManager.getAllCategories ? window.StorageManager.getAllCategories() : window.StorageManager.getRegisteredCategories('fav');
            const favs = window.StorageManager.getFavPlaylists();
            let html = '';
            cats.forEach(c => {
                const count = favs.filter(f => (f.category || '未分类') === c).length;
                const isCurrent = isFaved && curCat === c;
                html += `
                    <div class="playlist-choice-item" onclick="window.Shell.selectFavCategory('${escapeHtml(c)}')" style="${isCurrent ? 'background:rgba(88,166,255,0.15); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:var(--fs-t4); margin-left:6px;">(当前分类)</span>' : ''}
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
        showToast(`已收藏至【${catName}】`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
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
        showToast(`已创建分类【${name}】并收藏`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    function unfavCurrentFromModal() {
        if (!pendingFavPlaylist) return;
        window.StorageManager.unfavPlaylist(pendingFavPlaylist.id);
        showToast(`已取消收藏《${pendingFavPlaylist.name || pendingFavPlaylist.title}》`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    /* -------------------- 弹窗：移动歌单到分组 -------------------- */
    let pendingMoveData = null; // { kind, id, curCat }

    function openMoveCategoryModal(kind, playlistId, curCat) {
        if (!playlistId) return;
        pendingMoveData = { kind, id: playlistId, curCat: curCat || "未分组" };

        const modal = document.getElementById("moveCategoryModal");
        const infoEl = document.getElementById("moveModalPlaylistInfo");
        const choiceList = document.getElementById("moveCategoryChoiceList");
        const input = document.getElementById("newMoveCategoryInput");

        if (input) input.value = "";

        let plName = "当前歌单";
        if (kind === 'fav') {
            const item = window.StorageManager.getFavPlaylists().find(f => f.id === playlistId);
            if (item) plName = item.name || item.title || plName;
        } else {
            const item = window.StorageManager.getCustomPlaylists().find(c => c.id === playlistId);
            if (item) plName = item.title || plName;
        }

        if (infoEl) {
            infoEl.innerHTML = `<span>移动歌单：<strong>${escapeHtml(plName)}</strong> <span style="opacity:0.7; font-size:var(--fs-t4);">(当前: ${escapeHtml(curCat || '未分组')})</span></span>`;
        }

        if (choiceList) {
            const cats = window.StorageManager.getAllCategories ? window.StorageManager.getAllCategories() : window.StorageManager.getRegisteredCategories(kind);
            let html = '';
            cats.forEach(c => {
                const isCurrent = (curCat || '未分组') === c;
                html += `
                    <div class="playlist-choice-item" onclick="window.Shell.selectMoveCategory('${escapeHtml(c)}')" style="${isCurrent ? 'background:rgba(88,166,255,0.15); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:var(--fs-t4); margin-left:6px;">(当前分组)</span>' : ''}
                        </div>
                        <span class="meta-tag">${isCurrent ? '已在此组' : '移至此组'}</span>
                    </div>
                `;
            });
            choiceList.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeMoveCategoryModal() {
        const modal = document.getElementById("moveCategoryModal");
        if (modal) modal.classList.remove("open");
        pendingMoveData = null;
    }

    function selectMoveCategory(catName) {
        if (!pendingMoveData) return;
        window.StorageManager.changePlaylistCategory(pendingMoveData.kind, pendingMoveData.id, catName);
        showToast(`已移动至【${catName}】`);
        closeMoveCategoryModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    function confirmCreateCategoryAndMove() {
        if (!pendingMoveData) return;
        const input = document.getElementById("newMoveCategoryInput");
        const name = input ? input.value.trim() : "";
        if (!name) {
            showToast("请输入新分组名称");
            return;
        }
        window.StorageManager.addCategory(pendingMoveData.kind, name);
        window.StorageManager.changePlaylistCategory(pendingMoveData.kind, pendingMoveData.id, name);
        showToast(`已创建分组【${name}】并移动至此`);
        closeMoveCategoryModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    /* -------------------- 弹窗：添加到自建歌单 -------------------- */
    function openAddToCustomModal(songInfoText) {
        const modal = document.getElementById("addToPlaylistModal");
        const infoEl = document.getElementById("addToSongInfo");
        const choiceList = document.getElementById("playlistChoiceList");
        const input = document.getElementById("newPlaylistInput");

        if (input) input.value = "";
        if (infoEl) infoEl.innerText = songInfoText || "已选择歌曲";

        if (choiceList) {
            const customs = window.StorageManager.getCustomPlaylists();
            if (customs.length === 0) {
                choiceList.innerHTML = '<div style="padding:8px; font-size:var(--fs-t4); color:var(--text-muted);">暂无自建歌单，请在下方直接输入名称新建</div>';
            } else {
                let html = '';
                customs.forEach(pl => {
                    const count = pl.tracks ? pl.tracks.length : 0;
                    html += `
                        <div class="playlist-choice-item" onclick="window.RightPanel.confirmAddPendingToPlaylist('${escapeHtml(pl.id)}')">
                            <strong>${escapeHtml(pl.title)}</strong>
                            <span class="meta-tag">共 ${count} 首歌</span>
                        </div>
                    `;
                });
                choiceList.innerHTML = html;
            }
        }

        if (modal) modal.classList.add("open");
    }

    function closeAddToCustomModal() {
        const modal = document.getElementById("addToPlaylistModal");
        if (modal) modal.classList.remove("open");
    }

    function confirmCreateAndAdd() {
        const input = document.getElementById("newPlaylistInput");
        const title = input ? input.value.trim() : "";
        if (!title) {
            showToast("请输入新歌单名称");
            return;
        }
        const newPl = window.StorageManager.createCustomPlaylist(title, "默认");
        if (newPl) {
            window.RightPanel.confirmAddPendingToPlaylist(newPl.id);
            window.LibraryPanel?.renderLibrary?.();
        }
    }

    /* -------------------- 弹窗：批量打包下载确认 -------------------- */
    let pendingBatchDownloadTracks = [];

    function openBatchDownloadModal(tracks) {
        pendingBatchDownloadTracks = tracks || [];
        const modal = document.getElementById("batchDownloadModal");
        const summaryEl = document.getElementById("batchDownloadSummary");
        const listEl = document.getElementById("batchDownloadSongList");

        if (summaryEl) {
            summaryEl.innerText = `已选中 ${pendingBatchDownloadTracks.length} 首歌曲，将打包为单个 ZIP 文件下载：`;
        }
        if (listEl) {
            let html = "";
            pendingBatchDownloadTracks.forEach((t, i) => {
                const title = t.name || t.title || "未知歌曲";
                const artist = t.artist || "未知歌手";
                const dur = t.durationMillis ? `${Math.floor(t.durationMillis / 60000)}:${String(Math.floor((t.durationMillis % 60000) / 1000)).padStart(2, '0')}` : "";
                html += `
                    <div style="padding:3px 4px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05);">
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;">${i + 1}. <strong>${escapeHtml(title)}</strong> - ${escapeHtml(artist)}</span>
                        ${dur ? `<span style="color:var(--text-muted); font-size:10px; flex-shrink:0;">${dur}</span>` : ''}
                    </div>
                `;
            });
            listEl.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeBatchDownloadModal() {
        const modal = document.getElementById("batchDownloadModal");
        if (modal) modal.classList.remove("open");
        pendingBatchDownloadTracks = [];
    }

    function confirmBatchDownload() {
        if (!pendingBatchDownloadTracks || pendingBatchDownloadTracks.length === 0) {
            closeBatchDownloadModal();
            return;
        }
        const toDownload = [...pendingBatchDownloadTracks];
        closeBatchDownloadModal();
        window.Downloader?.startZipBatchDownload?.(toDownload);
    }

    /* -------------------- 全局 Toast 提示 -------------------- */
    function showToast(msg) {
        if (!toast) return;
        toast.innerText = msg;
        toast.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove("show");
        }, 2200);
    }

    /* -------------------- 弹窗：通用确认 (防误触) -------------------- */
    let pendingConfirmCallback = null;

    function openConfirmModal({ title, message, confirmText, cancelText, onConfirm }) {
        const modal = document.getElementById("confirmActionModal");
        const titleEl = document.getElementById("confirmActionTitle");
        const msgEl = document.getElementById("confirmActionMessage");
        const submitBtn = document.getElementById("btnConfirmActionSubmit");
        const cancelBtn = document.getElementById("btnConfirmActionCancel");

        if (titleEl) titleEl.innerText = title || "操作确认";
        if (msgEl) msgEl.innerText = message || "确认执行此操作吗？";
        if (cancelBtn) cancelBtn.innerText = cancelText || "取消";
        if (submitBtn) submitBtn.innerText = confirmText || "确认";

        pendingConfirmCallback = onConfirm;

        if (submitBtn) {
            submitBtn.onclick = () => {
                const cb = pendingConfirmCallback;
                closeConfirmActionModal();
                if (typeof cb === 'function') cb();
            };
        }

        if (modal) modal.classList.add("open");
    }

    function closeConfirmActionModal() {
        const modal = document.getElementById("confirmActionModal");
        if (modal) modal.classList.remove("open");
        pendingConfirmCallback = null;
    }

    /* -------------------- 弹窗：通用文本输入/重命名 -------------------- */
    let pendingInputCallback = null;

    function openInputPromptModal({ title, desc, defaultValue, onConfirm }) {
        const modal = document.getElementById("inputPromptModal");
        const titleEl = document.getElementById("inputPromptTitle");
        const descEl = document.getElementById("inputPromptDesc");
        const inputEl = document.getElementById("inputPromptValue");
        const submitBtn = document.getElementById("btnInputPromptSubmit");

        if (titleEl) titleEl.innerText = title || "✎ 重命名";
        if (descEl) descEl.innerText = desc || "请输入新名称：";
        if (inputEl) inputEl.value = defaultValue || "";

        pendingInputCallback = onConfirm;

        function submit() {
            const val = inputEl ? inputEl.value.trim() : "";
            const cb = pendingInputCallback;
            closeInputPromptModal();
            if (typeof cb === 'function') cb(val);
        }

        if (submitBtn) submitBtn.onclick = submit;
        if (inputEl) {
            inputEl.onkeydown = (e) => {
                if (e.key === "Enter") submit();
            };
        }

        if (modal) {
            modal.classList.add("open");
            setTimeout(() => {
                inputEl?.focus();
                inputEl?.select();
            }, 100);
        }
    }

    function closeInputPromptModal() {
        const modal = document.getElementById("inputPromptModal");
        if (modal) modal.classList.remove("open");
        pendingInputCallback = null;
    }

    return {
        init,
        handleSearch,
        clearSearch,
        exitSearch,
        toggleVolumePopup,
        handleVerticalVolumeChange,
        handleProgressBarClick,
        handleCycleMode,
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
        unfavCurrentFromModal,
        openMoveCategoryModal,
        closeMoveCategoryModal,
        selectMoveCategory,
        confirmCreateCategoryAndMove,
        openAddToCustomModal,
        closeAddToCustomModal,
        confirmCreateAndAdd,
        openBatchDownloadModal,
        closeBatchDownloadModal,
        confirmBatchDownload,
        openConfirmModal,
        closeConfirmActionModal,
        openInputPromptModal,
        closeInputPromptModal,
        showToast
    };
})();
