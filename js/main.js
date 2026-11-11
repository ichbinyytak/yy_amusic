/**
 * ========================================================
 * 模块：js/main.js - 全局生命周期与应用总装入口 (遵照 SITE_ARCHITECTURE.md)
 * 依赖协同：window.LeftPanel, window.Shell, window.StorageManager, window.RightPanel
 * --------------------------------------------------------
 * 职责定位：
 *   1. 浏览器 DOM 就绪后的统一生命周期引导
 *   2. 启动左右双栏面板与播放器外壳控制器
 *   3. 读取用户上次收听歌单记忆，或加载默认首发歌单
 * --------------------------------------------------------
 * 功能目录：
 *   1. 面板装配与初始化 (LeftPanel / Shell)
 *   2. 历史播放状态恢复与首发兜底 (StorageManager / RightPanel)
 * ========================================================
 */

function loadInitialWorkspacePlaylist() {
    const lastPl = window.StorageManager?.getLastPlaylist?.();
    let loaded = false;

    if (lastPl) {
        try {
            if (lastPl.kind === 'curated' && lastPl.name) {
                window.RightPanel?.selectCuratedCollection?.(lastPl.name, lastPl.curator, lastPl.url, lastPl.roomUrl, lastPl.tracks);
                loaded = true;
            } else if (lastPl.kind === 'custom' && lastPl.id) {
                const customs = window.StorageManager?.getCustomPlaylists?.() || [];
                if (customs.some(c => c.id === lastPl.id)) {
                    window.RightPanel?.selectCustomPlaylist?.(lastPl.id);
                    loaded = true;
                }
            } else if (lastPl.kind === 'sv_chart' && lastPl.svKind && lastPl.svCategory) {
                window.RightPanel?.selectSvChart?.(lastPl.svKind, lastPl.svCategory, lastPl.name, lastPl.curator, lastPl.id, lastPl.url);
                loaded = true;
            } else if (lastPl.kind === 'sv_playlist' && lastPl.svId) {
                window.RightPanel?.selectSvPlaylist?.(lastPl.svId, lastPl.name, lastPl.curator, lastPl.url, lastPl.id);
                loaded = true;
            } else if (lastPl.id && lastPl.type) {
                window.RightPanel?.selectPlaylist?.(lastPl.id, lastPl.type, lastPl.name, lastPl.curator, lastPl.url);
                loaded = true;
            }
        } catch (e) {
            console.warn("[Main] 恢复上一次歌单失败:", e);
        }
    }

    if (!loaded) {
        // 首次打开或新账号：默认加载【潜力新歌：国语流行】
        window.RightPanel?.selectPlaylist?.(
            'pl.80e13199d5db46c7b519b25cf6e5816a',
            'playlist',
            '潜力新歌：国语流行',
            '国语流行',
            'https://music.apple.com/cn/playlist/%E6%BD%9C%E5%8A%9B%E6%96%B0%E6%AD%8C-%E5%9B%BD%E8%AF%AD%E6%B5%81%E8%A1%8C/pl.80e13199d5db46c7b519b25cf6e5816a'
        );
    }
}

let hasInitializedAppShell = false;

window.addEventListener("DOMContentLoaded", () => {
    window.ThemeManager?.init?.();

    const startOrRefreshApp = () => {
        if (!hasInitializedAppShell) {
            hasInitializedAppShell = true;
            window.LeftPanel?.init?.();
            window.Shell?.init?.();
        } else {
            window.LibraryPanel?.renderLibrary?.();
        }
        loadInitialWorkspacePlaylist();
    };

    if (window.AuthManager?.boot) {
        window.AuthManager.boot(startOrRefreshApp);
    } else {
        startOrRefreshApp();
    }
});
