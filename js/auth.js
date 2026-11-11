/**
 * ========================================================
 * 模块：js/auth.js - 邀请码登录门禁与云端歌单同步控制器 (遵照 architecture-auth-sync.md)
 * 命名空间：window.AuthManager
 * 依赖协同：window.StorageManager, window.LibraryPanel, window.RightPanel, window.Shell, window.player
 * --------------------------------------------------------
 * 核心职责：
 *   1. 启动门禁校验 (GET /api/auth/me) 与全屏登录/邀请码注册遮罩
 *   2. 登录后从云端拉取歌单覆盖本地 4 键，退出登录时彻底清理本地歌单与播放态
 *   3. 监听歌单变更事件并执行 2 秒防抖上传 (POST /api/sync/library)
 *   4. 全局 401 响应兜底拦截，会话失效自动退回登录门禁
 * ========================================================
 */

window.AuthManager = (function () {
    'use strict';

    const SYNC_KEYS = new Set([
        "amusic_custom_playlists",
        "amusic_fav_playlists",
        "amusic_categories_custom",
        "amusic_categories_fav"
    ]);
    const SYNC_DEBOUNCE_MS = 2000;

    let currentUser = null;
    let authMode = "login"; // 'login' | 'register'
    let syncTimer = null;
    let isSyncing = false;
    let isApplyingCloud = false;
    let bootCallback = null;
    let eventsBound = false;
    let fetchWrapped = false;

    function getEl(id) {
        return document.getElementById(id);
    }

    function setSyncStatus(status, titleText) {
        const dot = getEl("userSyncDot");
        const header = getEl("userDropdownHeader");
        if (dot) {
            dot.classList.remove("syncing", "error", "ok");
            if (status) dot.classList.add(status);
            if (titleText) dot.title = titleText;
        }
        if (header && currentUser) {
            const stateSuffix = status === "syncing" ? " · 同步中..." : (status === "error" ? " · 同步失败" : " · 云端已同步");
            header.innerText = `👤 ${currentUser}${stateSuffix}`;
        }
    }

    function updateUserHeader(username) {
        const wrapper = getEl("userAccountWrapper");
        const label = getEl("userNameLabel");
        if (!wrapper) return;
        if (username) {
            if (label) label.innerText = username;
            wrapper.style.display = "inline-flex";
            setSyncStatus("ok", "云端已同步");
        } else {
            wrapper.style.display = "none";
            wrapper.classList.remove("open");
            if (label) label.innerText = "";
        }
    }

    function setAuthError(msg) {
        const errEl = getEl("authErrorMsg");
        if (!errEl) return;
        if (msg) {
            errEl.innerText = msg;
            errEl.style.display = "block";
        } else {
            errEl.innerText = "";
            errEl.style.display = "none";
        }
    }

    function switchAuthMode(mode) {
        authMode = mode === "register" ? "register" : "login";
        const tabLogin = getEl("authTabLogin");
        const tabReg = getEl("authTabRegister");
        const inviteField = getEl("authInviteField");
        const submitBtn = getEl("authSubmitBtn");
        const hintEl = getEl("authModeHint");

        if (tabLogin) tabLogin.classList.toggle("active", authMode === "login");
        if (tabReg) tabReg.classList.toggle("active", authMode === "register");
        if (inviteField) inviteField.style.display = authMode === "register" ? "flex" : "none";
        if (submitBtn) submitBtn.innerText = authMode === "register" ? "验证邀请码并注册" : "登录进入音乐库";
        if (hintEl) {
            hintEl.innerText = authMode === "register"
                ? "仅限持有邀请码的新用户注册，初始歌单从 0 开始并自动云同步"
                : "登录后将自动同步您的云端自建歌单与收藏分组";
        }
        setAuthError("");
    }

    function showAuthGate(checking = false) {
        const overlay = getEl("authGateOverlay");
        const checkingBox = getEl("authCheckingBox");
        const formWrap = getEl("authFormWrap");
        document.body.classList.add("auth-locked");
        if (!overlay) return;
        overlay.classList.add("open");
        if (checkingBox) checkingBox.style.display = checking ? "block" : "none";
        if (formWrap) formWrap.style.display = checking ? "none" : "block";
    }

    function hideAuthGate() {
        const overlay = getEl("authGateOverlay");
        document.body.classList.remove("auth-locked");
        if (overlay) overlay.classList.remove("open");
    }

    function closeUserMenu() {
        const wrapper = getEl("userAccountWrapper");
        const btn = getEl("btnUserAccount");
        if (wrapper) wrapper.classList.remove("open");
        if (btn) btn.setAttribute("aria-expanded", "false");
    }

    async function fetchCloudLibraryAndApply() {
        const res = await fetch("/api/sync/library", { credentials: "same-origin" });
        if (res.status === 401) {
            throw new Error("AUTH_REQUIRED");
        }
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `拉取云端歌单失败 (${res.status})`);
        }
        const lib = await res.json();
        isApplyingCloud = true;
        try {
            window.StorageManager?.applyCloudLibrary?.(lib);
        } finally {
            isApplyingCloud = false;
        }
        setSyncStatus("ok", "云端已同步");
        return lib;
    }

    async function syncLibraryNow(silentToast = false) {
        if (!currentUser || isSyncing) return false;
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }
        isSyncing = true;
        setSyncStatus("syncing", "正在同步到云端...");
        try {
            const payload = window.StorageManager?.getCloudLibraryPayload?.() || {};
            const res = await fetch("/api/sync/library", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            if (res.status === 401) {
                handleUnauthorized("登录已过期，请重新登录");
                return false;
            }
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.error || `同步失败 (${res.status})`);
            }
            setSyncStatus("ok", "云端已同步");
            if (!silentToast) {
                window.Shell?.showToast?.("歌单已同步至云端");
            }
            return true;
        } catch (err) {
            console.warn("[AuthManager] 云同步失败:", err);
            setSyncStatus("error", err.message || "云同步失败");
            if (!silentToast) {
                window.Shell?.showToast?.(`云同步失败: ${err.message}`);
            }
            return false;
        } finally {
            isSyncing = false;
        }
    }

    function scheduleSync() {
        if (!currentUser || isApplyingCloud) return;
        setSyncStatus("syncing", "等待防抖同步...");
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            syncTimer = null;
            syncLibraryNow(true);
        }, SYNC_DEBOUNCE_MS);
    }

    function stopPlaybackAndResetWorkspace() {
        try {
            if (window.player) {
                if (window.player.audio) {
                    window.player.audio.pause();
                    window.player._setAudioSource?.("");
                }
                window.player.setPlaylist([], -1);
                window.player.isPlaying = false;
            }
        } catch (e) {}

        window.LeftPanel?.closeDrawer?.();
        window.Shell?.closeAllDrawers?.();
        window.StorageManager?.clearUserLibrary?.();
        window.RightPanel?.resetView?.();
    }

    function handleUnauthorized(toastMsg = "请先登录后再继续操作") {
        const wasLoggedIn = !!currentUser;
        currentUser = null;
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }
        updateUserHeader(null);
        stopPlaybackAndResetWorkspace();
        switchAuthMode("login");
        showAuthGate(false);
        if (wasLoggedIn && toastMsg) {
            window.Shell?.showToast?.(toastMsg);
        }
    }

    async function logout() {
        closeUserMenu();
        if (syncTimer) {
            clearTimeout(syncTimer);
            syncTimer = null;
        }
        try {
            await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "same-origin"
            });
        } catch (e) {}
        currentUser = null;
        updateUserHeader(null);
        stopPlaybackAndResetWorkspace();
        const pwdInput = getEl("authPassword");
        const invInput = getEl("authInviteCode");
        if (pwdInput) pwdInput.value = "";
        if (invInput) invInput.value = "";
        switchAuthMode("login");
        showAuthGate(false);
        window.Shell?.showToast?.("已退出登录");
    }

    async function handleAuthSubmit(e) {
        if (e) e.preventDefault();
        const userInput = getEl("authUsername");
        const pwdInput = getEl("authPassword");
        const invInput = getEl("authInviteCode");
        const submitBtn = getEl("authSubmitBtn");

        const username = (userInput?.value || "").trim();
        const password = pwdInput?.value || "";
        const inviteCode = (invInput?.value || "").trim();

        if (!/^[a-zA-Z0-9_-]{3,24}$/.test(username)) {
            setAuthError("用户名需为 3-24 位字母、数字、下划线或短横线");
            return;
        }
        if (password.length < 6) {
            setAuthError("密码长度至少为 6 位");
            return;
        }
        if (authMode === "register" && !inviteCode) {
            setAuthError("请输入邀请码");
            return;
        }

        setAuthError("");
        if (submitBtn) submitBtn.disabled = true;

        try {
            const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
            const body = authMode === "register"
                ? { username, password, inviteCode }
                : { username, password };

            const res = await fetch(endpoint, {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.authenticated) {
                setAuthError(data.error || "认证失败，请重试");
                return;
            }

            currentUser = data.username;
            if (authMode === "register" && data.library) {
                isApplyingCloud = true;
                try {
                    window.StorageManager?.applyCloudLibrary?.(data.library);
                } finally {
                    isApplyingCloud = false;
                }
            } else {
                await fetchCloudLibraryAndApply();
            }

            if (pwdInput) pwdInput.value = "";
            if (invInput) invInput.value = "";
            updateUserHeader(currentUser);
            hideAuthGate();
            window.Shell?.showToast?.(`欢迎回来，${currentUser}`);

            if (typeof bootCallback === "function") {
                bootCallback(currentUser);
            }
        } catch (err) {
            setAuthError(err.message || "网络异常，请稍后重试");
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    function wrapFetchFor401() {
        if (fetchWrapped || typeof window.fetch !== "function") return;
        fetchWrapped = true;
        const origFetch = window.fetch.bind(window);
        window.fetch = async function (input, init) {
            const response = await origFetch(input, init);
            try {
                const rawUrl = typeof input === "string" ? input : (input?.url || "");
                const parsed = new URL(rawUrl, window.location.origin);
                if (
                    parsed.origin === window.location.origin &&
                    parsed.pathname.startsWith("/api/") &&
                    !parsed.pathname.startsWith("/api/auth/") &&
                    response.status === 401
                ) {
                    handleUnauthorized("登录已失效，请重新登录");
                }
            } catch (e) {}
            return response;
        };
    }

    function bindEvents() {
        if (eventsBound) return;
        eventsBound = true;

        getEl("authTabLogin")?.addEventListener("click", () => switchAuthMode("login"));
        getEl("authTabRegister")?.addEventListener("click", () => switchAuthMode("register"));
        getEl("authForm")?.addEventListener("submit", handleAuthSubmit);

        const userWrapper = getEl("userAccountWrapper");
        const userBtn = getEl("btnUserAccount");
        userBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!userWrapper) return;
            const isOpen = userWrapper.classList.toggle("open");
            userBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
        });

        getEl("btnSyncNow")?.addEventListener("click", (e) => {
            e.stopPropagation();
            closeUserMenu();
            syncLibraryNow(false);
        });

        getEl("btnLogout")?.addEventListener("click", (e) => {
            e.stopPropagation();
            logout();
        });

        document.addEventListener("click", (e) => {
            if (userWrapper && userWrapper.classList.contains("open") && !userWrapper.contains(e.target)) {
                closeUserMenu();
            }
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeUserMenu();
        });

        window.addEventListener("amusic-storage-changed", (evt) => {
            const detail = evt?.detail || {};
            if (detail.eventType === "restore" || SYNC_KEYS.has(detail.key)) {
                scheduleSync();
            }
        });
    }

    async function boot(onAuthenticated) {
        bootCallback = onAuthenticated;
        wrapFetchFor401();
        bindEvents();
        showAuthGate(true);

        try {
            const res = await fetch("/api/auth/me", { credentials: "same-origin" });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                if (data && data.authenticated && data.username) {
                    currentUser = data.username;
                    await fetchCloudLibraryAndApply();
                    updateUserHeader(currentUser);
                    hideAuthGate();
                    if (typeof bootCallback === "function") {
                        bootCallback(currentUser);
                    }
                    return;
                }
            }
        } catch (err) {
            console.warn("[AuthManager] 检查登录态失败:", err);
        }

        currentUser = null;
        updateUserHeader(null);
        switchAuthMode("login");
        showAuthGate(false);
    }

    return {
        boot,
        syncNow: () => syncLibraryNow(false),
        logout,
        handleUnauthorized,
        getCurrentUser: () => currentUser,
        isAuthenticated: () => !!currentUser
    };
})();
