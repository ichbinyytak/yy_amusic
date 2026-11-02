/**
 * ========================================================
 * js/main.js - YY-Amusic 应用总装入口 (遵照 SITE_ARCHITECTURE.md)
 * ========================================================
 */

window.addEventListener("DOMContentLoaded", () => {
    // 1. 初始化左侧大一统手风琴与外壳播控
    window.LeftPanel?.init?.();
    window.Shell?.init?.();

    // 2. 检查并恢复上一次记忆的歌单；首次打开默认加载【潜力新歌：国语流行】
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
