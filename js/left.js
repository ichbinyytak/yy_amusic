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

    let switchTab = function () {};
    let exitSearch = function () {};

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

        // 装配顶部主标签页与左右全页视图
        assembleTopAccordions();
    }

    /**
     * 装配顶部主标签页 (Apple专区 | 我的音乐库) 与全页视图切换
     */
    function assembleTopAccordions() {
        const listPanel = document.getElementById("listPanel");
        if (!listPanel) return;

        // 1. 顶部主标签页栏 (保证单例，置于 listPanel 首位)
        let tabsNav = document.getElementById("leftTabsNav");
        if (!tabsNav) {
            tabsNav = document.createElement("div");
            tabsNav.id = "leftTabsNav";
            tabsNav.className = "left-tabs-nav";
            listPanel.insertBefore(tabsNav, listPanel.firstChild);
        }

        const currentSf = window.currentStorefront || (function () {
            try { return localStorage.getItem("amusic_storefront") || "cn"; } catch (e) { return "cn"; }
        })();
        window.currentStorefront = currentSf;

        const regionNames = {
            "cn": "中国大陆",
            "hk": "香港",
            "tw": "台湾",
            "us": "美国"
        };
        const currentName = regionNames[currentSf] || "中国大陆";

        tabsNav.innerHTML = `
            <div class="left-tabs-group">
                <div class="left-tab-col" id="tabAppleCol" data-tab="apple">
                    <div id="top_region">
                        <span class="top-accordion-left" id="tabAppleBtn">Apple专区</span>
                    </div>
                </div>
                <div class="left-tab-divider"></div>
                <div class="left-tab-col" id="tabLibraryCol" data-tab="library">
                    <span id="tabLibraryBtn">我的音乐库</span>
                </div>
            </div>
        `;

        // 2. 列表滚动容器内创建两个独立的整页视图面板
        const scrollContainer = document.getElementById("playlistList");
        if (!scrollContainer) return;
        scrollContainer.innerHTML = "";
        scrollContainer.className = "list-panel-scroll";

        const viewApple = document.createElement("div");
        viewApple.id = "viewApple";
        viewApple.className = "left-view-pane";

        const viewLibrary = document.createElement("div");
        viewLibrary.id = "viewLibrary";
        viewLibrary.className = "left-view-pane";

        // 2.1 Apple专区视图首行：独立设置行放置【地区选择器】(纯就地下拉，彻底防止顶部Tab误触)
        const appleToolbar = document.createElement("div");
        appleToolbar.className = "left-view-toolbar-row";
        appleToolbar.id = "appleToolbarRow";
        appleToolbar.innerHTML = `
            <span style="font-size: var(--fs-t3); color: var(--text-secondary); display:inline-flex; align-items:center; gap:4px;">
                <span>🌐 Apple 市场</span>
            </span>
            <div class="region-dropdown-wrapper" id="regionDropdownWrapper" onclick="event.stopPropagation();">
                <button class="region-dropdown-trigger" id="regionDropdownTrigger" type="button" title="切换地区">
                    <span id="regionCurrentText">${escapeHtml(currentName)}</span>
                    <span class="region-dropdown-arrow">▾</span>
                </button>
                <div class="region-dropdown-menu" id="regionDropdownMenu">
                    <div class="region-dropdown-item ${currentSf === 'cn' ? 'active' : ''}" data-val="cn">中国大陆</div>
                    <div class="region-dropdown-item ${currentSf === 'hk' ? 'active' : ''}" data-val="hk">香港</div>
                    <div class="region-dropdown-item ${currentSf === 'tw' ? 'active' : ''}" data-val="tw">台湾</div>
                    <div class="region-dropdown-item ${currentSf === 'us' ? 'active' : ''}" data-val="us">美国</div>
                </div>
                <!-- 隐式同步 select，确保自动化测试与既有 API 逻辑 100% 兼容 -->
                <select class="region-micro-select" id="regionMicroSelect" title="切换地区" style="display:none;">
                    <option value="cn" ${currentSf === 'cn' ? 'selected' : ''}>中国大陆</option>
                    <option value="hk" ${currentSf === 'hk' ? 'selected' : ''}>香港</option>
                    <option value="tw" ${currentSf === 'tw' ? 'selected' : ''}>台湾</option>
                    <option value="us" ${currentSf === 'us' ? 'selected' : ''}>美国</option>
                </select>
            </div>
        `;
        viewApple.appendChild(appleToolbar);

        const appleContent = document.createElement("div");
        appleContent.id = "appleContent";
        viewApple.appendChild(appleContent);

        // 2.2 我的音乐库视图首行：独立设置行放置【备份歌单】与【恢复歌单】(彻底防止顶部Tab误触)
        const libToolbar = document.createElement("div");
        libToolbar.className = "left-view-toolbar-row";
        libToolbar.id = "libraryToolbarRow";
        libToolbar.innerHTML = `
            <button class="btn-lib-text-action" id="btnExportBackup" title="备份当前全部歌单为 JSON 文件" onclick="event.stopPropagation(); window.Shell?.openConfirmModal?.({ title: '↑ 备份歌单确认', message: '确定将当前音乐库全部歌单导出为 JSON 备份文件吗？', confirmText: '确认备份', onConfirm: () => window.BackupManager?.exportData?.() });">
                <span>↑ 备份歌单</span>
            </button>
            <button class="btn-lib-text-action" id="btnImportBackup" title="从 JSON 文件恢复歌单数据" onclick="event.stopPropagation(); window.Shell?.openConfirmModal?.({ title: '↓ 恢复歌单确认', message: '恢复歌单将读取本地 JSON 备份文件并合并至您的音乐库，确认继续吗？', confirmText: '确认恢复', onConfirm: () => window.BackupManager?.triggerImport?.() });">
                <span>↓ 恢复歌单</span>
            </button>
        `;
        viewLibrary.appendChild(libToolbar);

        const libContent = document.createElement("div");
        libContent.id = "libContent";
        viewLibrary.appendChild(libContent);

        // 2.3 方案B：专设搜索结果视图面板 (用于左侧并列展示搜索匹配的歌单与专辑)
        const viewSearch = document.createElement("div");
        viewSearch.id = "viewSearch";
        viewSearch.className = "left-view-pane";

        scrollContainer.appendChild(viewApple);
        scrollContainer.appendChild(viewLibrary);
        scrollContainer.appendChild(viewSearch);

        // 绑定自定义纯下拉切换逻辑 (纯下拉无弹窗)
        const regionWrapper = appleToolbar.querySelector("#regionDropdownWrapper");
        const regionTrigger = appleToolbar.querySelector("#regionDropdownTrigger");
        const regionMenu = appleToolbar.querySelector("#regionDropdownMenu");
        const regionCurrentText = appleToolbar.querySelector("#regionCurrentText");
        const microSelect = appleToolbar.querySelector("#regionMicroSelect");

        function closeRegionDropdown() {
            regionWrapper?.classList.remove("open");
        }

        regionTrigger?.addEventListener("click", (e) => {
            e.stopPropagation();
            regionWrapper?.classList.toggle("open");
        });

        regionMenu?.querySelectorAll(".region-dropdown-item").forEach(item => {
            item.addEventListener("click", (e) => {
                e.stopPropagation();
                const val = item.getAttribute("data-val");
                if (!val) return;
                
                regionMenu.querySelectorAll(".region-dropdown-item").forEach(i => i.classList.remove("active"));
                item.classList.add("active");
                if (regionCurrentText) regionCurrentText.innerText = item.innerText.trim();
                closeRegionDropdown();

                // 同步 microSelect 并分发 change 事件驱动 RegionPanel
                if (microSelect) {
                    microSelect.value = val;
                    microSelect.dispatchEvent(new Event("change", { bubbles: true }));
                }
            });
        });

        document.addEventListener("click", (e) => {
            if (regionWrapper && !regionWrapper.contains(e.target)) {
                closeRegionDropdown();
            }
        });

        // 3. 分别挂载 Apple专区、我的音乐库 与 搜索结果控制器至独立内容容器
        window.RegionPanel?.init?.(appleContent, microSelect);
        window.LibraryPanel?.init?.(libContent);
        window.SearchPanel?.init?.(viewSearch);

        // 4. 读取偏好或默认激活 Apple 专区
        let activeTab = "apple";
        let previousActiveTab = "apple";
        try {
            const saved = localStorage.getItem("amusic_active_left_tab");
            if (saved === "apple" || saved === "library") {
                activeTab = saved;
                previousActiveTab = saved;
            }
        } catch (e) {}

        switchTab = function (tabName) {
            const colApple = tabsNav.querySelector("#tabAppleCol");
            const colLib = tabsNav.querySelector("#tabLibraryCol");
            const btnApple = tabsNav.querySelector("#tabAppleBtn");
            const btnLib = tabsNav.querySelector("#tabLibraryBtn");

            if (tabName === "search") {
                activeTab = "search";
                colApple?.classList.remove("active");
                colLib?.classList.remove("active");
                btnApple?.classList.remove("active");
                btnLib?.classList.remove("active");
                viewSearch.classList.add("active");
                viewApple.classList.remove("active");
                viewLibrary.classList.remove("active");
                return;
            }

            activeTab = tabName;
            previousActiveTab = tabName;
            try { localStorage.setItem("amusic_active_left_tab", tabName); } catch (e) {}

            viewSearch.classList.remove("active");

            if (tabName === "apple") {
                colApple?.classList.add("active");
                colLib?.classList.remove("active");
                btnApple?.classList.add("active");
                btnLib?.classList.remove("active");
                viewApple.classList.add("active");
                viewLibrary.classList.remove("active");
            } else {
                colLib?.classList.add("active");
                colApple?.classList.remove("active");
                btnLib?.classList.add("active");
                btnApple?.classList.remove("active");
                viewLibrary.classList.add("active");
                viewApple.classList.remove("active");
                // 每次切入音乐库主动同步刷新一次，确保最新歌单立即呈现
                window.LibraryPanel?.renderLibrary?.();
            }
        };

        exitSearch = function () {
            switchTab(previousActiveTab || "apple");
        };

        // 统一在导航栏做事件委托，彻底消除点不准/点到文字未触发的问题
        tabsNav.addEventListener("click", (e) => {
            // 如果点到导出/导入按钮或地区下拉框，不触发 Tab 切换
            if (e.target.closest("#regionMicroSelect") || e.target.closest(".left-tabs-tools")) {
                return;
            }
            if (e.target.closest("#tabLibraryCol") || e.target.closest("#tabLibraryBtn")) {
                switchTab("library");
            } else if (e.target.closest("#tabAppleCol") || e.target.closest("#tabAppleBtn") || e.target.closest("#top_region")) {
                switchTab("apple");
            }
        });

        // 绑定直接元素的快捷监听
        tabsNav.querySelector("#tabAppleCol")?.addEventListener("click", () => switchTab("apple"));
        tabsNav.querySelector("#tabLibraryCol")?.addEventListener("click", () => switchTab("library"));
        tabsNav.querySelector("#tabAppleBtn")?.addEventListener("click", () => switchTab("apple"));
        tabsNav.querySelector("#tabLibraryBtn")?.addEventListener("click", () => switchTab("library"));

        window.LeftPanel.switchTab = switchTab;

        switchTab(activeTab);
    }

    function createTopAccordion({ id, title, extraHeaderHtml }) {
        const block = document.createElement("div");
        block.className = "top-accordion-block";
        if (id) block.id = id;

        const isOpen = expandedTopAccordions.has(id);

        const hdr = document.createElement("div");
        hdr.className = `top-accordion-hdr ${isOpen ? 'open' : ''}`;
        hdr.innerHTML = `
            <div class="top-accordion-left">
                <span class="top-accordion-arrow ${isOpen ? 'open' : ''}">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
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
                hdr.classList.remove("open");
                const arrow = hdr.querySelector(".top-accordion-arrow");
                arrow.classList.remove("open");
                arrow.innerHTML = iconArrowCollapsed;
            } else {
                expandedTopAccordions.add(id);
                body.classList.add("open");
                hdr.classList.add("open");
                const arrow = hdr.querySelector(".top-accordion-arrow");
                arrow.classList.add("open");
                arrow.innerHTML = iconArrowExpanded;
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
     * 1. 彻底取消行内按钮，100% 满宽留给标题
     * 2. 统一绑定 ContextMenu (长按 500ms 或鼠标右键呼出操作)
     */
    function createPlaylistCard(item, options = {}) {
        const isCustom = !!options.isCustom;
        const isFav = !!options.isFav;
        const onDelete = options.onDelete;
        const onRename = options.onRename;

        const isCurated = !!item.isCurated || item.type === "curated" || item.kind === "curated" || (item.tracks && item.tracks.length > 0);
        const kind = item.kind || item.type || (item.attributes ? (item.type === "albums" ? "album" : "playlist") : "playlist");
        const isAlbum = kind === "album" || kind === "albums";
        const typeLabel = isCustom ? "[自建]" : (isCurated ? "[精选]" : (isAlbum ? "[专辑]" : "[歌单]"));
        // 遵循色彩规范：仅大标题红，卡片内标签采用标准中性/副色，杜绝红字
        const tagColor = isCustom ? "var(--accent)" : (isAlbum ? "#e3b341" : "var(--text-secondary)");

        const name = item.title || item.name || item.attributes?.name || "未知标题";
        const rawCurator = item.curator || item.subtitle || item.attributes?.curatorName || item.attributes?.artistName || "";
        const cleanCurator = cleanCuratorName(rawCurator);

        // 真实曲目数；彻底去除 "🔗 官方精选" 占位符
        const trackCount = item.trackCount || (item.tracks ? item.tracks.length : "");
        const trackCountBadge = trackCount ? `${trackCount} 首` : "";

        const card = document.createElement("div");
        card.className = "playlist-card";
        if (item.id) card.id = `card-${item.id}`;

        const sf = window.RegionPanel?.getStorefront?.() || "cn";
        const url = item.url || item.attributes?.url || `https://music.apple.com/${sf}/${isAlbum ? 'album' : 'playlist'}/${item.id || ''}`;

        card.innerHTML = `
            <div class="playlist-card-row1">
                <div class="playlist-card-title-group" style="width:100%;">
                    <span class="playlist-type-tag" style="color: ${tagColor};">${typeLabel}</span>
                    <span class="playlist-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                </div>
            </div>
            <div class="playlist-card-row2">
                <span class="playlist-curator" title="${escapeHtml(cleanCurator)}">${escapeHtml(cleanCurator)}</span>
                ${trackCountBadge ? `<span class="playlist-track-badge">${escapeHtml(trackCountBadge)}</span>` : ''}
            </div>
        `;

        // 严格遵照用户指令：
        // 1. Apple区域歌单长按不出现任何菜单 (收藏到右侧收藏，播放到右侧按，复制和打包均不需要)
        // 2. 我的音乐库歌单长按彻底移除“播放全部” (统一在右侧曲目列表按播放)
        // 3. 所有歌单长按均彻底去除“复制链接 / 复制歌单名”
        if (isCustom || isFav) {
            window.ContextMenu?.bind(card, () => {
                return [
                    {
                        icon: "⇄",
                        label: "移动至分组",
                        onClick: () => {
                            window.Shell?.openMoveCategoryModal?.(isCustom ? 'custom' : 'fav', item.id, item.category || '未分组');
                        }
                    },
                    {
                        icon: "✎",
                        label: "重命名歌单",
                        onClick: () => {
                            if (onRename) onRename();
                        }
                    },
                    {
                        icon: "✕",
                        label: "删除歌单",
                        danger: true,
                        onClick: () => {
                            if (onDelete) onDelete();
                        }
                    }
                ];
            });
        } else if (item._isSearch) {
            // 搜索结果卡片：长按可一键收藏加入我的分组
            window.ContextMenu?.bind(card, () => {
                return [
                    {
                        icon: "＋",
                        label: "加入我的分组",
                        onClick: () => {
                            const plData = {
                                id: item.id,
                                type: item.type || (item.kind === "album" ? "album" : "playlist"),
                                name: name,
                                title: name,
                                curator: cleanCurator || "Apple Music",
                                url: url,
                                trackCount: trackCount || 0
                            };
                            window.Shell?.openAddToFavModal?.(plData);
                        }
                    }
                ];
            });
        }
        // Apple专区歌单：直接静默，不绑定 ContextMenu，完全不弹出菜单

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
            btnEl.innerHTML = "＋";
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
        switchTab: (...args) => switchTab(...args),
        exitSearch: (...args) => exitSearch(...args),
        toggleDrawer,
        openDrawer,
        closeDrawer
    };
})();
