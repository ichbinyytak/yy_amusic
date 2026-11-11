/**
 * ========================================================
 * 模块：js/shell.js - 主页外壳控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.Shell
 * 依赖协同：window.player, window.Modals, window.LeftPanel, window.RightPanel
 * --------------------------------------------------------
 * 功能目录：
 *   1. 顶栏搜索交互 (handleSearch / clearSearch / exitSearch)
 *   2. 音量直立弹窗交互 (toggleVolumePopup / handleVerticalVolumeChange)
 *   3. 播控与进度条 (updatePlayPauseButton / handleProgressBarClick / handleCycleMode)
 *   4. 时间轴歌词系统 (renderLyricsView / 上下拖拽浏览前后歌词 / 放手平滑回正 / 长按复制歌词)
 *   5. 侧拉抽屉与底层音源 (toggleQueueModal / toggleSourceModal / testSources / syncSources)
 *   6. 全局轻量 Toast 提示 (showToast)
 *   7. 业务弹窗代理转发 (向后兼容无缝代理至 window.Modals)
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
    let renderedLyricKey = null;
    let currentTranslateY = 0;
    let isUserDragging = false;
    let hasDragged = false;
    let isLongPress = false;
    let longPressTimer = null;
    let dragStartY = 0;
    let dragStartX = 0;
    let initialTranslateY = 0;
    let isMouseDown = false;

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
            if (playerArtist) playerArtist.innerText = album ? `专辑: ${album}` : (track.platform === "streetvoice" ? "StreetVoice 街声" : "Apple Music 精选曲目");
            if (playerCurTime) playerCurTime.innerText = "00:00";
            if (playerTotalTime) playerTotalTime.innerText = formatDuration(track.durationMillis || (track.duration ? track.duration * 1000 : 0));
            if (progressBarFill) progressBarFill.style.width = "0%";
            updatePlayPauseButton(true);
            updateQueueCount();

            // 重新高亮右侧当前正在播放的行
            document.querySelectorAll(".track-table tr").forEach(tr => tr.classList.remove("track-row-playing"));
            const playingRow = document.getElementById(`track-row-${index}`);
            if (playingRow) playingRow.classList.add("track-row-playing");

            // 若播放队列抽屉处于展开状态，即时同步队列中的高亮项与播放指示符
            if (queueDrawer && queueDrawer.classList.contains("open")) {
                renderQueueList();
            }
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

        // 初始化歌词栏手势拖拽浏览与长按复制
        initLyricDockGesture();
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

    /* ========================================================
     * 区块 4: 时间轴歌词系统 (手势拖拽浏览、放手回正与长按复制)
     * ======================================================== */
    function getTrackElement() {
        let track = document.getElementById("lyricLinesTrack");
        if (!track && lyricLinesWrapper) {
            track = document.createElement("div");
            track.className = "lyric-lines-track";
            track.id = "lyricLinesTrack";
            while (lyricLinesWrapper.firstChild) {
                track.appendChild(lyricLinesWrapper.firstChild);
            }
            lyricLinesWrapper.appendChild(track);
        }
        return track;
    }

    function getLineHeight() {
        return isLyricExpanded ? 24 : 18;
    }

    function getCenterOffset() {
        return isLyricExpanded ? 24 : 0;
    }

    function getTargetY(idx) {
        const total = (currentSongLyricLines && currentSongLyricLines.length > 0) ? currentSongLyricLines.length : 2;
        const lh = getLineHeight();
        const offset = getCenterOffset();
        const clamped = Math.max(0, Math.min(total - 1, idx >= 0 ? idx : 0));
        return offset - clamped * lh;
    }

    function renderLyricsView(curText, nxtText) {
        const track = getTrackElement();
        if (!track) return;

        const curIdx = lastLyricIdx >= 0 ? lastLyricIdx : 0;

        // 如果没有完整歌词（纯音乐或占位提示）
        if (!currentSongLyricLines || currentSongLyricLines.length === 0) {
            renderedLyricKey = "__empty__";
            track.innerHTML = `
                <div class="lyric-line lyric-line-current" id="lyricCurrentLine">${escapeHtml(curText || "♪ YY-Amusic 纯文本音乐底座已就绪")}</div>
                <div class="lyric-line lyric-line-next" id="lyricNextLine">${escapeHtml(nxtText || "点播任意歌曲，歌词毫秒级同步滚屏")}</div>
            `;
            if (!isUserDragging) {
                track.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
                track.style.transform = 'translateY(0px)';
                currentTranslateY = 0;
            }
            return;
        }

        // 检查是否需要重新构建曲目完整歌词行 DOM 树
        const currentSongKey = currentSongLyricLines.length + "_" + (currentSongLyricLines[0]?.text || "") + "_" + (currentSongLyricLines[currentSongLyricLines.length - 1]?.text || "");
        if (renderedLyricKey !== currentSongKey) {
            renderedLyricKey = currentSongKey;
            let html = '';
            currentSongLyricLines.forEach((item, idx) => {
                let cls = 'lyric-line';
                if (idx === curIdx) cls += ' lyric-line-current';
                else if (idx === curIdx + 1) cls += ' lyric-line-next';
                else if (idx < curIdx) cls += ' lyric-line-prev';
                html += `<div class="${cls}" data-idx="${idx}" title="上下拉动浏览前后歌词 / 长按复制">${escapeHtml(item.text)}</div>`;
            });
            track.innerHTML = html;
        } else {
            // 增量高效更新高亮与前后状态类名
            const lineEls = track.querySelectorAll(".lyric-line");
            lineEls.forEach((el, idx) => {
                let cls = 'lyric-line';
                if (idx === curIdx) cls += ' lyric-line-current';
                else if (idx === curIdx + 1) cls += ' lyric-line-next';
                else if (idx < curIdx) cls += ' lyric-line-prev';
                el.className = cls;
            });
        }

        // 若用户未处于手动拖拽拉扯状态，平滑滚入当前播放行
        if (!isUserDragging) {
            const targetY = getTargetY(curIdx);
            track.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
            track.style.transform = `translateY(${targetY}px)`;
            currentTranslateY = targetY;
        }
    }

    function snapBackToCurrent() {
        const track = getTrackElement();
        if (!track) return;
        const targetY = getTargetY(lastLyricIdx >= 0 ? lastLyricIdx : 0);
        track.style.transition = 'transform 0.35s cubic-bezier(0.25, 1, 0.5, 1)';
        track.style.transform = `translateY(${targetY}px)`;
        currentTranslateY = targetY;
    }

    function applyDragOffset(dy) {
        const track = getTrackElement();
        if (!track) return;
        const totalLines = (currentSongLyricLines && currentSongLyricLines.length > 0) ? currentSongLyricLines.length : 2;
        const lh = getLineHeight();
        const offset = getCenterOffset();

        let newY = initialTranslateY + dy;
        const maxY = offset + 40;
        const minY = offset - (totalLines - 1) * lh - 40;

        // 弹性阻尼算法
        if (newY > maxY) {
            newY = maxY + (newY - maxY) * 0.35;
        } else if (newY < minY) {
            newY = minY + (newY - minY) * 0.35;
        }

        track.style.transition = 'none';
        track.style.transform = `translateY(${newY}px)`;
        currentTranslateY = newY;
    }

    function triggerLongPressCopy() {
        isLongPress = true;
        let textToCopy = "";
        let lineCount = 0;

        if (currentSongLyricLines && currentSongLyricLines.length > 0) {
            // 复制整首歌曲的全部歌词
            const lines = currentSongLyricLines.map(item => item.text).filter(Boolean);
            textToCopy = lines.join("\n");
            lineCount = lines.length;
        } else {
            const curEl = document.getElementById("lyricCurrentLine");
            textToCopy = curEl ? curEl.innerText.trim() : "";
            lineCount = textToCopy ? 1 : 0;
        }

        if (!textToCopy) return;

        // 触感震动反馈
        if (navigator.vibrate) {
            try { navigator.vibrate(40); } catch (e) {}
        }

        // 整个歌词栏背景闪烁高亮反馈
        if (lyricDock) {
            lyricDock.classList.add("lyric-copied");
            setTimeout(() => lyricDock.classList.remove("lyric-copied"), 600);
        }

        const toastMsg = lineCount > 1 ? `已复制全部歌词 (共 ${lineCount} 行)` : `已复制歌词: ${textToCopy}`;
        copyTextToClipboard(textToCopy, toastMsg);
    }

    function copyTextToClipboard(text, toastMsg) {
        if (!text) return;
        const msg = toastMsg || "已复制全部歌词";
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                showToast(msg);
            }).catch(() => {
                fallbackCopy(text, msg);
            });
        } else {
            fallbackCopy(text, msg);
        }
    }

    function fallbackCopy(text, toastMsg) {
        const msg = toastMsg || "已复制全部歌词";
        try {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.setAttribute("readonly", "");
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            textArea.style.top = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            textArea.setSelectionRange(0, 99999);
            document.execCommand('copy');
            document.body.removeChild(textArea);
        } catch (e) {}

        showToast(msg);
    }

    function initLyricDockGesture() {
        if (!lyricDock) return;

        // 1. 移动端触屏拖拽与长按手势
        lyricDock.addEventListener("touchstart", (e) => {
            if (e.target.closest("#lyricCloseBtn")) return;
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            dragStartY = touch.clientY;
            dragStartX = touch.clientX;
            initialTranslateY = currentTranslateY;
            isUserDragging = false;
            hasDragged = false;
            isLongPress = false;

            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                triggerLongPressCopy();
            }, 400);
        }, { passive: true });

        lyricDock.addEventListener("touchmove", (e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            const dy = touch.clientY - dragStartY;
            const dx = touch.clientX - dragStartX;

            if (!isUserDragging) {
                if (Math.hypot(dx, dy) > 6) {
                    clearTimeout(longPressTimer);
                    if (Math.abs(dy) > Math.abs(dx)) {
                        isUserDragging = true;
                        hasDragged = true;
                        lyricDock.classList.add("dragging");
                    }
                }
            }

            if (isUserDragging) {
                if (e.cancelable) e.preventDefault();
                applyDragOffset(dy);
            }
        }, { passive: false });

        const endTouch = () => {
            clearTimeout(longPressTimer);
            if (isUserDragging) {
                isUserDragging = false;
                lyricDock.classList.remove("dragging");
                snapBackToCurrent();
            }
            setTimeout(() => {
                hasDragged = false;
                isLongPress = false;
            }, 120);
        };
        lyricDock.addEventListener("touchend", endTouch);
        lyricDock.addEventListener("touchcancel", endTouch);

        // 2. 桌面鼠标拖拽与长按
        lyricDock.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            if (e.target.closest("#lyricCloseBtn")) return;
            isMouseDown = true;
            dragStartY = e.clientY;
            dragStartX = e.clientX;
            initialTranslateY = currentTranslateY;
            isUserDragging = false;
            hasDragged = false;
            isLongPress = false;

            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                triggerLongPressCopy();
            }, 450);
        });

        window.addEventListener("mousemove", (e) => {
            if (!isMouseDown) return;
            const dy = e.clientY - dragStartY;
            const dx = e.clientX - dragStartX;

            if (!isUserDragging) {
                if (Math.hypot(dx, dy) > 5) {
                    clearTimeout(longPressTimer);
                    isUserDragging = true;
                    hasDragged = true;
                    lyricDock.classList.add("dragging");
                }
            }

            if (isUserDragging) {
                applyDragOffset(dy);
            }
        });

        window.addEventListener("mouseup", () => {
            if (!isMouseDown) return;
            isMouseDown = false;
            clearTimeout(longPressTimer);
            if (isUserDragging) {
                isUserDragging = false;
                lyricDock.classList.remove("dragging");
                snapBackToCurrent();
            }
            setTimeout(() => {
                hasDragged = false;
                isLongPress = false;
            }, 120);
        });

        // 3. 滚轮平滑交互（拉动浏览前后歌词，静止 400ms 后自动回正）
        let wheelTimer = null;
        lyricDock.addEventListener("wheel", (e) => {
            if (e.target.closest("#lyricCloseBtn")) return;
            e.preventDefault();
            clearTimeout(longPressTimer);
            clearTimeout(wheelTimer);
            hasDragged = true;
            isUserDragging = true;
            lyricDock.classList.add("dragging");

            applyDragOffset(-e.deltaY);
            wheelTimer = setTimeout(() => {
                isUserDragging = false;
                lyricDock.classList.remove("dragging");
                snapBackToCurrent();
                setTimeout(() => { hasDragged = false; }, 120);
            }, 400);
        }, { passive: false });

        // 4. 点击事件拦截：发生拖拽或长按时拦截触发展开/收起
        lyricDock.addEventListener("click", (e) => {
            if (hasDragged || isLongPress) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, true);
    }

    function expandLyricDock(e) {
        if (e && e.target.closest("#lyricCloseBtn")) return;
        if (hasDragged || isLongPress) return;
        if (!lyricDock) return;
        isLyricExpanded = true;
        lyricDock.classList.add("expanded");
        snapBackToCurrent();
    }

    function collapseLyricDock(e) {
        if (e) e.stopPropagation();
        if (!lyricDock) return;
        isLyricExpanded = false;
        lyricDock.classList.remove("expanded");
        snapBackToCurrent();
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

        // 自动平滑滚动使当前播放项处于可视区
        const activeItem = queueListBody.querySelector(".queue-item.active");
        if (activeItem) {
            activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
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
                subtitleEl.innerHTML = `云端每日自动测速 · 最近更新: <span style="color:var(--text-primary); font-weight:600;">${escapeHtml(timeStr)}</span> · 双核冲刺毫秒出声`;
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
            const count = Array.isArray(data) ? data.length : (Array.isArray(data?.sources) ? data.sources.length : 0);
            showToast(`音源同步成功！当前生效: ${count} 个`);
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
        showToast,

        // -------------------- 业务弹窗代理 (向后兼容委托至 window.Modals) --------------------
        openAddToFavModal: (...args) => window.Modals?.openAddToFavModal?.(...args),
        closeAddToFavModal: (...args) => window.Modals?.closeAddToFavModal?.(...args),
        selectFavCategory: (...args) => window.Modals?.selectFavCategory?.(...args),
        confirmCreateCategoryAndFav: (...args) => window.Modals?.confirmCreateCategoryAndFav?.(...args),
        unfavCurrentFromModal: (...args) => window.Modals?.unfavCurrentFromModal?.(...args),
        openMoveCategoryModal: (...args) => window.Modals?.openMoveCategoryModal?.(...args),
        closeMoveCategoryModal: (...args) => window.Modals?.closeMoveCategoryModal?.(...args),
        selectMoveCategory: (...args) => window.Modals?.selectMoveCategory?.(...args),
        confirmCreateCategoryAndMove: (...args) => window.Modals?.confirmCreateCategoryAndMove?.(...args),
        openAddToCustomModal: (...args) => window.Modals?.openAddToCustomModal?.(...args),
        closeAddToCustomModal: (...args) => window.Modals?.closeAddToCustomModal?.(...args),
        confirmCreateAndAdd: (...args) => window.Modals?.confirmCreateAndAdd?.(...args),
        openBatchDownloadModal: (...args) => window.Modals?.openBatchDownloadModal?.(...args),
        closeBatchDownloadModal: (...args) => window.Modals?.closeBatchDownloadModal?.(...args),
        confirmBatchDownload: (...args) => window.Modals?.confirmBatchDownload?.(...args),
        openConfirmModal: (...args) => window.Modals?.openConfirmModal?.(...args),
        closeConfirmActionModal: (...args) => window.Modals?.closeConfirmActionModal?.(...args),
        openInputPromptModal: (...args) => window.Modals?.openInputPromptModal?.(...args),
        closeInputPromptModal: (...args) => window.Modals?.closeInputPromptModal?.(...args)
    };
})();
