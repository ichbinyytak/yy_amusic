/**
 * ========================================================
 * js/main.js - YY-Amusic 应用总装入口
 * ========================================================
 */

window.addEventListener("DOMContentLoaded", () => {
    // 1. 初始化各框架
    window.LeftPanel.init();
    window.Shell.init();

    // 2. 搜索框回车事件绑定
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                window.LeftPanel.handleSearch();
            }
        });
    }

    // 3. 无论是否恢复歌单，左侧列表默认加载“最新发布”
    window.LeftPanel.loadNewPage();

    // 4. 检查并恢复上一次记忆的歌单
    const lastPlRaw = localStorage.getItem("amusic_last_playlist");
    if (lastPlRaw) {
        try {
            const lastPl = JSON.parse(lastPlRaw);
            if (lastPl.kind === 'curated' && lastPl.name) {
                window.RightPanel.selectCuratedCollection(lastPl.name, lastPl.curator, lastPl.url, lastPl.roomUrl, lastPl.tracks);
            } else if (lastPl.kind === 'custom' && lastPl.id) {
                const customs = window.LeftPanel.getCustomPlaylists();
                if (customs.some(c => c.id === lastPl.id)) {
                    window.RightPanel.selectCustomPlaylist(lastPl.id);
                }
            } else if (lastPl.id && lastPl.type) {
                window.RightPanel.selectPlaylist(lastPl.id, lastPl.type, lastPl.name, lastPl.curator, lastPl.url);
            }
        } catch (e) {
            console.warn("恢复上一次歌单失败", e);
        }
    }
});
