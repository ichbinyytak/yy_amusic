/**
 * ========================================================
 * 模块：js/importer.js - 外部歌单/分享口令识别与转化分流器
 * 命名空间：window.PlaylistImporter
 * 设计依据：architecture-playlist-import.md (单一事实来源)
 * 依赖协同：window.RightPanel, window.LeftPanel, window.Shell
 * --------------------------------------------------------
 * 核心特性：
 *   1. 搜索框零侵入：无缝识别分享文案、多跳短链、网页长链与平台短前缀
 *   2. 本站原生零耗时：Apple Music 与街声直通原生加载 (selectPlaylist / selectSvPlaylist)
 *   3. 外部平台静默分流：网易云/QQ/酷我/汽水/咪咕/酷狗/Spotify 异步解析加载至右侧详情
 * ========================================================
 */

window.PlaylistImporter = (function () {
    'use strict';

    const URL_REGEX = /https?:\/\/[^\s<>\"'()]+/i;
    const PREFIX_REGEX = /^(wy|qq|tx|kw|kg|mg):/i;
    const PLATFORM_DOMAINS = [
        "163cn.tv", "music.163.com",
        "y.qq.com", "qqmusic.qq.com",
        "kuwo.cn",
        "kugou.com",
        "migu.cn",
        "douyin.com", "qishui",
        "spotify.com", "spotify.link",
        "music.apple.com",
        "streetvoice.cn", "streetvoice.com"
    ];

    /**
     * 判断输入是否为外部平台分享文本、链接或前缀
     */
    function canHandle(input) {
        if (!input || typeof input !== 'string') return false;
        const text = input.trim();
        if (PREFIX_REGEX.test(text)) return true;
        if (URL_REGEX.test(text)) {
            const lower = text.toLowerCase();
            return PLATFORM_DOMAINS.some(domain => lower.includes(domain));
        }
        return false;
    }

    /**
     * 提取文本中的有效 URL
     */
    function extractUrl(text) {
        if (!text) return "";
        const m = text.match(URL_REGEX);
        if (m) {
            return m[0].replace(/[，。！？；、),\"'>]+$/, '');
        }
        return "";
    }

    /**
     * 主导入处理管道
     */
    async function importFromInput(input) {
        if (!input || !String(input).trim()) return;
        const rawText = String(input).trim();

        // 同步顶栏搜索框与清除按钮
        const searchInput = document.getElementById("searchInput");
        const clearBtn = document.getElementById("clearBtn");
        if (searchInput) searchInput.value = rawText;
        if (clearBtn) clearBtn.style.display = "inline-flex";

        const url = extractUrl(rawText);

        // 分支 A: Apple Music 官方链接 -> 直通原生 Apple Music 逻辑 (支持官方自动更新)
        if (url && url.includes("music.apple.com")) {
            const m = url.match(/music\.apple\.com\/([a-z]{2}(?:-[a-z]{2})?)\/(playlist|album|song)\/(?:([^/]+)\/)?([a-zA-Z0-9.\-_]+)/i);
            if (m) {
                const sf = m[1].toLowerCase();
                const type = m[2].toLowerCase();
                let title = m[3] ? decodeURIComponent(m[3]).replace(/-/g, ' ') : "Apple Music 歌单";
                const id = m[4];

                if (window.RegionPanel?.setStorefront && sf) {
                    window.RegionPanel.setStorefront(sf);
                }
                window.RightPanel?.selectPlaylist?.(id, type, title, "Apple Music", url);
                return;
            }
        }

        // 分支 B: 街声官方链接 -> 直通原生街声逻辑 (支持官方实时排行榜/歌单)
        if (url && (url.includes("streetvoice.cn") || url.includes("streetvoice.com"))) {
            const m = url.match(/playlists\/(\d+)/);
            if (m) {
                const svId = m[1];
                window.RightPanel?.selectSvPlaylist?.(svId, `街声歌单 #${svId}`, "StreetVoice", url);
                return;
            }
        }

        // 分支 C: 外部平台解析 -> 驱动右侧详情区进入加载骨架
        window.RightPanel?.prepareImportLoading?.(rawText);

        try {
            const resp = await fetch("/api/import_playlist", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ text: rawText })
            });

            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                const errMsg = errData.error || `HTTP ${resp.status}`;
                throw new Error(errMsg);
            }

            const importData = await resp.json();
            if (!importData || !importData.ok) {
                throw new Error(importData?.error || "外部歌单解析失败");
            }

            // 加载到右侧详情面板
            window.RightPanel?.renderImportedPlaylist?.(importData);

            if (window.Shell?.showToast) {
                window.Shell.showToast(`已成功转化《${importData.title}》(共 ${importData.total} 首)`);
                if (importData.notice) {
                    setTimeout(() => {
                        window.Shell?.showToast?.(importData.notice);
                    }, 1800);
                }
            }
        } catch (err) {
            console.error("[PlaylistImporter] 解析转化异常:", err);
            window.RightPanel?.renderImportError?.(err.message);
            if (window.Shell?.showToast) {
                window.Shell.showToast(`解析失败: ${err.message}`);
            }
        }
    }

    return {
        canHandle,
        extractUrl,
        importFromInput
    };
})();
