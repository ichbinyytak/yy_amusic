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

window.addEventListener("DOMContentLoaded", () => {
    /* ========================================================
     * 区块 1: 初始化左侧大一统手风琴与外壳播控
     * ======================================================== */
    window.LeftPanel?.init?.();
    window.Shell?.init?.();

    /* ========================================================
     * 区块 2: 恢复上一次记忆的歌单或加载默认推荐歌单
     * ======================================================== */
    const lastPl = window.StorageManager?.getLastPlaylist?.();
    if (lastPl) {
        try {
            if (lastPl.kind === 'curated' && lastPl.name) {
                window.RightPanel?.selectCuratedCollection?.(lastPl.name, lastPl.curator, lastPl.url, lastPl.roomUrl, lastPl.tracks);
            } else if (lastPl.kind === 'custom' && lastPl.id) {
                const customs = window.StorageManager?.getCustomPlaylists?.() || [];
                if (customs.some(c => c.id === lastPl.id)) {
                    window.RightPanel?.selectCustomPlaylist?.(lastPl.id);
                }
            } else if (lastPl.kind === 'sv_chart' && lastPl.svKind && lastPl.svCategory) {
                window.RightPanel?.selectSvChart?.(lastPl.svKind, lastPl.svCategory, lastPl.name, lastPl.curator, lastPl.id, lastPl.url);
            } else if (lastPl.kind === 'sv_playlist' && lastPl.svId) {
                window.RightPanel?.selectSvPlaylist?.(lastPl.svId, lastPl.name, lastPl.curator, lastPl.url, lastPl.id);
            } else if (lastPl.id && lastPl.type) {
                window.RightPanel?.selectPlaylist?.(lastPl.id, lastPl.type, lastPl.name, lastPl.curator, lastPl.url);
            }
        } catch (e) {
            console.warn("[Main] 恢复上一次歌单失败:", e);
        }
    } else {
        // 首次打开：默认加载【潜力新歌：国语流行】
        window.RightPanel?.selectPlaylist?.(
            'pl.80e13199d5db46c7b519b25cf6e5816a',
            'playlist',
            '潜力新歌：国语流行',
            '国语流行',
            'https://music.apple.com/cn/playlist/%E6%BD%9C%E5%8A%9B%E6%96%B0%E6%AD%8C-%E5%9B%BD%E8%AF%AD%E6%B5%81%E8%A1%8C/pl.80e13199d5db46c7b519b25cf6e5816a'
        );
    }
});
