/**
 * ========================================================
 * js/left.js - 左侧大一统总装调度入口与公共卡片构造器 (遵照 SITE_ARCHITECTURE.md)
 * 职责：
 * 1. 挂载 3 大同级单窗口就地手风琴 (我的音乐库 / 区域 / 数据管理)
 * 2. 公共卡片构造器 (脱水清洗 Apple Music 前缀、彻底消除 🔗 官方精选、纯图标操作)
 * 3. 抽屉打开/关闭管理
 * ========================================================
 */

window.LeftPanel = (function () {
    'use strict';

    const expandedTopAccordions = new Set(["top_region", "top_library"]); // 默认展开音乐库与区域

    const iconArrowCollapsed = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>`;
    const iconArrowExpanded = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>`;

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * 脱水清洗策划人/歌手文本：
     * 1. 凡是 "Apple Music 爵士乐" ➔ 剔除前缀保留 "爵士乐"
     * 2. 若纯粹只有 "Apple Music" 几个字 ➔ 直接留白置空，消除全屏重复噪音
     * 3. 真正的歌手名完整保留
     */
    function cleanCuratorName(raw) {
        if (!raw) return "";
        const str = String(raw).trim();
        if (str === "Apple Music") return "";
        if (str.startsWith("Apple Music ")) {
            return str.replace(/^Apple Music\s+/, "");
        }
        return str;
    }

    function init() {
        const listPanel = document.getElementById("listPanel");
        if (!listPanel) return;

        // 绑定 ESC 关闭侧边栏
        window.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeDrawer();
        });

        // 装配三大顶级手风琴
        assembleTopAccordions();
    }

    /**
     * 装配三大同级顶级手风琴
     */
    function assembleTopAccordions() {
        const scrollContainer = document.getElementById("playlistList");
        if (!scrollContainer) return;
        scrollContainer.innerHTML = "";
        scrollContainer.className = "list-panel-scroll";

        // 1. ## 我的音乐库 手风琴
        const libBlock = createTopAccordion({
            id: "top_library",
            title: "我的音乐库",
            extraHeaderHtml: ""
        });
        scrollContainer.appendChild(libBlock.blockEl);
        window.LibraryPanel?.init?.(libBlock.bodyEl);

        // 2. ## 区域 手风琴 (内嵌极简紧凑微型下拉选择器)
        const currentSf = window.currentStorefront || "cn";
        const regionSelectHtml = `
            <select class="region-micro-select" id="regionMicroSelect" title="切换地区" onclick="event.stopPropagation();">
                <option value="cn" ${currentSf === 'cn' ? 'selected' : ''}>🇨🇳 大陆</option>
                <option value="hk" ${currentSf === 'hk' ? 'selected' : ''}>🇭🇰 香港</option>
                <option value="tw" ${currentSf === 'tw' ? 'selected' : ''}>🇹🇼 台湾</option>
                <option value="us" ${currentSf === 'us' ? 'selected' : ''}>🇺🇸 美国</option>
                <option value="jp" ${currentSf === 'jp' ? 'selected' : ''}>🇯🇵 日本</option>
                <option value="gb" ${currentSf === 'gb' ? 'selected' : ''}>🇬🇧 英国</option>
            </select>
        `;

        const regionBlock = createTopAccordion({
            id: "top_region",
            title: "区域",
            extraHeaderHtml: regionSelectHtml
        });
        scrollContainer.appendChild(regionBlock.blockEl);

        const microSelect = regionBlock.headerEl.querySelector("#regionMicroSelect");
        window.RegionPanel?.init?.(regionBlock.bodyEl, microSelect);

        // 3. ## 数据管理 手风琴
        const backupBlock = createTopAccordion({
            id: "top_backup",
            title: "数据管理",
            extraHeaderHtml: ""
        });
        scrollContainer.appendChild(backupBlock.blockEl);
        window.BackupManager?.renderBackupSection?.(backupBlock.bodyEl);
    }

    function createTopAccordion({ id, title, extraHeaderHtml }) {
        const block = document.createElement("div");
        block.className = "top-accordion-block";

        const isOpen = expandedTopAccordions.has(id);

        const hdr = document.createElement("div");
        hdr.className = "top-accordion-hdr";
        hdr.innerHTML = `
            <div class="top-accordion-left">
                <span class="top-accordion-arrow">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(title)}</span>
            </div>
            <div class="top-accordion-right">
                ${extraHeaderHtml || ""}
            </div>
        `;

        const body = document.createElement("div");
        body.className = `top-accordion-body ${isOpen ? 'open' : ''}`;

        hdr.onclick = () => {
            if (expandedTopAccordions.has(id)) {
                expandedTopAccordions.delete(id);
                body.classList.remove("open");
                hdr.querySelector(".top-accordion-arrow").innerHTML = iconArrowCollapsed;
            } else {
                expandedTopAccordions.add(id);
                body.classList.add("open");
                hdr.querySelector(".top-accordion-arrow").innerHTML = iconArrowExpanded;
            }
        };

        block.appendChild(hdr);
        block.appendChild(body);

        return {
            blockEl: block,
            headerEl: hdr,
            bodyEl: body
        };
    }

    /**
     * 全局统一脱水卡片构造器 (100% 遵照 SITE_ARCHITECTURE.md 规范)
     */
    function createPlaylistCard(item, options = {}) {
        const isCustom = !!options.isCustom;
        const isFav = !!options.isFav;
        const onDelete = options.onDelete;

        const isCurated = !!item.isCurated || item.type === "curated" || item.kind === "curated" || (item.tracks && item.tracks.length > 0);
        const kind = item.kind || item.type || (item.attributes ? (item.type === "albums" ? "album" : "playlist") : "playlist");
        const isAlbum = kind === "album" || kind === "albums";
        const typeLabel = isCustom ? "[自建]" : (isCurated ? "[精选]" : (isAlbum ? "[专辑]" : "[歌单]"));
        const tagColor = isCustom ? "var(--accent)" : (isCurated ? "var(--accent-apple)" : (isAlbum ? "#e3b341" : "#58a6ff"));

        const name = item.title || item.name || item.attributes?.name || "未知标题";
        const rawCurator = item.curator || item.subtitle || item.attributes?.curatorName || item.attributes?.artistName || "";
        const cleanCurator = cleanCuratorName(rawCurator);

        // 真实曲目数；彻底去除 "🔗 官方精选" 占位符
        const trackCount = item.trackCount || (item.tracks ? item.tracks.length : "");
        const trackCountBadge = trackCount ? `${trackCount} 首` : "";

        const card = document.createElement("div");
        card.className = "playlist-card";
        if (item.id) card.id = `card-${item.id}`;

        const isAlreadyFaved = !isCustom && item.id && window.StorageManager.isPlaylistFaved(item.id);

        card.innerHTML = `
            <div class="playlist-card-row1">
                <div class="playlist-card-title-group">
                    <span class="playlist-type-tag" style="color: ${tagColor};">${typeLabel}</span>
                    <span class="playlist-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                </div>
                <div class="playlist-card-actions">
                    <button class="btn-card-action" data-action="play" title="播放全部">▶</button>
                    ${(isCustom || isFav) ? `
                        <button class="btn-card-action btn-del" data-action="del" title="删除">✕</button>
                    ` : `
                        <button class="btn-card-action fav ${isAlreadyFaved ? 'active' : ''}" data-action="fav" title="${isAlreadyFaved ? '已收藏' : '收藏'}">${isAlreadyFaved ? '★' : '☆'}</button>
                    `}
                    <button class="btn-card-action" data-action="download" title="下载整单">↓</button>
                </div>
            </div>
            <div class="playlist-card-row2">
                <span class="playlist-curator" title="${escapeHtml(cleanCurator)}">${escapeHtml(cleanCurator)}</span>
                ${trackCountBadge ? `<span class="playlist-track-badge">${escapeHtml(trackCountBadge)}</span>` : ''}
            </div>
        `;

        // 按钮事件绑定
        const btnPlay = card.querySelector('[data-action="play"]');
        if (btnPlay) {
            btnPlay.onclick = (e) => {
                e.stopPropagation();
                openItem(item, isCustom, isCurated, isAlbum, name, cleanCurator, () => {
                    window.RightPanel?.playCurrentAll?.();
                });
            };
        }

        const btnDel = card.querySelector('[data-action="del"]');
        if (btnDel) {
            btnDel.onclick = (e) => {
                e.stopPropagation();
                if (onDelete) onDelete();
            };
        }

        const btnFav = card.querySelector('[data-action="fav"]');
        if (btnFav) {
            btnFav.onclick = (e) => {
                e.stopPropagation();
                promptFavCard(item, name, cleanCurator, btnFav);
            };
        }

        const btnDownload = card.querySelector('[data-action="download"]');
        if (btnDownload) {
            btnDownload.onclick = (e) => {
                e.stopPropagation();
                openItem(item, isCustom, isCurated, isAlbum, name, cleanCurator, () => {
                    window.RightPanel?.downloadCurrentPlaylist?.();
                });
            };
        }

        // 卡片点击展开至右侧
        card.onclick = () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            closeDrawer();
            openItem(item, isCustom, isCurated, isAlbum, name, cleanCurator);
        };

        return card;
    }

    function openItem(item, isCustom, isCurated, isAlbum, name, curator, onLoaded) {
        const sf = window.RegionPanel?.getStorefront?.() || "cn";
        const url = item.url || item.attributes?.url || `https://music.apple.com/${sf}/${isAlbum ? 'album' : 'playlist'}/${item.id || ''}`;

        if (isCustom) {
            window.RightPanel?.selectCustomPlaylist?.(item.id);
            if (onLoaded) setTimeout(onLoaded, 100);
            return;
        }

        const isCuratedCollection = isCurated || (!item.id && (item.tracks || item.roomUrl));
        if (isCuratedCollection && window.RightPanel?.selectCuratedCollection) {
            window.RightPanel.selectCuratedCollection(name, curator, url, item.roomUrl, item.tracks);
            if (onLoaded) setTimeout(onLoaded, 300);
        } else if (item.id) {
            const autoType = String(item.id).startsWith("pl.") ? "playlist" : (/^\d+$/.test(String(item.id)) ? "album" : (isAlbum ? "album" : "playlist"));
            window.RightPanel.selectPlaylist(item.id, autoType, name, curator, url);
            if (onLoaded) setTimeout(onLoaded, 600);
        }
    }

    function promptFavCard(item, name, curator, btnEl) {
        if (!item.id) return;
        const isFaved = window.StorageManager.isPlaylistFaved(item.id);
        if (isFaved) {
            window.StorageManager.unfavPlaylist(item.id);
            btnEl.classList.remove("active");
            btnEl.innerHTML = "☆";
            window.Shell?.showToast?.(`已取消收藏《${name}》`);
        } else {
            const plData = {
                id: item.id,
                type: item.type || (item.kind === "album" ? "album" : "playlist"),
                name: name,
                title: name,
                curator: curator,
                url: item.url || "",
                trackCount: item.trackCount || 0
            };
            window.Shell?.openAddToFavModal?.(plData);
        }
    }

    // 侧边栏抽屉显示/隐藏
    function toggleDrawer() {
        const listPanel = document.getElementById("listPanel");
        const backdrop = document.getElementById("leftDrawerBackdrop");
        const btn = document.getElementById("btnHamburger");
        if (!listPanel) return;
        const isOpen = listPanel.classList.toggle("open");
        if (backdrop) backdrop.classList.toggle("open", isOpen);
        if (btn) btn.classList.toggle("active", isOpen);
    }

    function openDrawer() {
        const listPanel = document.getElementById("listPanel");
        const backdrop = document.getElementById("leftDrawerBackdrop");
        const btn = document.getElementById("btnHamburger");
        if (listPanel) listPanel.classList.add("open");
        if (backdrop) backdrop.classList.add("open");
        if (btn) btn.classList.add("active");
    }

    function closeDrawer() {
        const listPanel = document.getElementById("listPanel");
        const backdrop = document.getElementById("leftDrawerBackdrop");
        const btn = document.getElementById("btnHamburger");
        if (listPanel) listPanel.classList.remove("open");
        if (backdrop) backdrop.classList.remove("open");
        if (btn) btn.classList.remove("active");
    }

    return {
        init,
        createPlaylistCard,
        toggleDrawer,
        openDrawer,
        closeDrawer
    };
})();
