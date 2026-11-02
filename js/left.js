/**
 * ========================================================
 * js/left.js - 左侧框架控制器 (Apple 区域、三大 Tab 与歌单探索)
 * ========================================================
 */

window.LeftPanel = (function () {
    let currentMainTab = "new";
    let currentLibraryFilter = "全部";
    let cachedCategories = [];

    // DOM 元素引用
    const storefrontSelect = document.getElementById("storefrontSelect");
    const playlistListEl = document.getElementById("playlistList");
    const listPanelTitle = document.getElementById("listPanelTitle");
    const itemCountBadge = document.getElementById("itemCountBadge");
    const categoryFilterBar = document.getElementById("categoryFilterBar");
    const searchInput = document.getElementById("searchInput");
    const clearBtn = document.getElementById("clearBtn");

    // 矢量图标定义 (纯图标，保证高分辨率清晰呈现)
    const iconDownload = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px;"><line x1="12" y1="3" x2="12" y2="16"></line><polyline points="7 11 12 16 17 11"></polyline><line x1="4" y1="21" x2="20" y2="21"></line></svg>`;
    const iconUpload = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -1px;"><line x1="12" y1="17" x2="12" y2="4"></line><polyline points="7 9 12 4 17 9"></polyline><line x1="4" y1="21" x2="20" y2="21"></line></svg>`;
    const iconAdd = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    const iconMinus = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
    const iconEdit = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`;
    const iconArrowCollapsed = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>`;
    const iconArrowExpanded = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>`;

    // 状态记录：最新发布 & 各专区分区板块展开状态 (默认全折叠，初始为空 Set)
    const expandedSections = new Set();
    // 状态记录：我的音乐库分类折叠状态 (默认全折叠，初始为空 Set)
    const expandedGroups = new Set();

    function init() {
        if (storefrontSelect) {
            storefrontSelect.value = window.currentStorefront || "cn";
            storefrontSelect.addEventListener("change", (e) => {
                const sf = e.target.value;
                currentStorefront = sf;
                window.currentStorefront = sf;
                try { localStorage.setItem("amusic_storefront", sf); } catch (err) {}
                const query = searchInput ? searchInput.value.trim() : "";
                if (query) {
                    handleSearch();
                } else if (currentMainTab === "new") {
                    loadNewPage();
                } else if (currentMainTab === "categories") {
                    loadSearchPage();
                }
            });
        }

        // 按 Esc 键快速收回侧边抽屉
        window.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                closeDrawer();
            }
        });
    }

    // 侧边栏抽屉显示/隐藏管理
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

    // 三大核心 Tab 切换
    function switchMainTab(tab) {
        currentMainTab = tab;
        document.querySelectorAll(".main-tab-btn").forEach(btn => btn.classList.remove("active"));
        const btn = document.getElementById(
            tab === "new" ? "btnTabNew" :
            tab === "categories" ? "btnTabCategories" : "btnTabLibrary"
        );
        if (btn) btn.classList.add("active");

        if (tab === "new") {
            loadNewPage();
        } else if (tab === "categories") {
            loadSearchPage();
        } else if (tab === "library") {
            loadLibraryPage();
        }
    }

    function getStorefront() {
        return window.currentStorefront || (storefrontSelect ? storefrontSelect.value : "cn") || "cn";
    }

    // 1. 最新发布 (/new)
    function loadNewPage() {
        switchTabUI("new", "最新发布");
        if (categoryFilterBar) categoryFilterBar.style.display = "none";

        const sf = getStorefront();
        const cacheKey = `new_page_${sf}`;
        swrFetch(`/api/apple_new?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                playlistListEl.innerHTML = '<div class="loading-state">正在获取 Apple 官方最新发布板块...</div>';
                itemCountBadge.innerText = "...";
            },
            onCached: (data) => {
                const sections = data?.sections || [];
                renderNewSections(sections, false, "new");
            },
            onUpdated: (data) => {
                const sections = data?.sections || [];
                renderNewSections(sections, false, "new");
            },
            onError: (err) => {
                playlistListEl.innerHTML = `<div class="loading-state">❌ 获取 /new 页面失败: ${err.message}</div>`;
                itemCountBadge.innerText = "0";
            }
        });
    }

    function renderNewSections(sections, backToCategories = false, contextKey = "new") {
        playlistListEl.innerHTML = "";
        if (!sections || sections.length === 0) {
            playlistListEl.innerHTML = '<div class="loading-state">暂未解析到板块数据。</div>';
            itemCountBadge.innerText = "0";
            return;
        }

        let totalItems = 0;
        sections.forEach(s => totalItems += (s.items?.length || 0));
        itemCountBadge.innerText = `${sections.length} 板块 / ${totalItems} 歌单`;

        if (backToCategories) {
            const divBack = document.createElement("div");
            divBack.className = "section-divider back-divider";
            divBack.style.cursor = "pointer";
            divBack.style.color = "var(--accent)";
            divBack.innerHTML = `<span>‹ 返回全部分类专区</span><span class="section-count">返回</span>`;
            divBack.onclick = () => loadSearchPage();
            playlistListEl.appendChild(divBack);
        }

        sections.forEach((sec, idx) => {
            const secTitle = sec.title || "推荐板块";
            const secItems = sec.items || [];
            if (secItems.length === 0) return;

            const secKey = `${contextKey}_${idx}_${secTitle}`;
            const isExpanded = expandedSections.has(secKey); // 默认全折叠

            const secBlock = document.createElement("div");
            secBlock.className = "section-accordion-block";

            const div = document.createElement("div");
            div.className = "section-divider section-accordion-hdr";
            div.innerHTML = `
                <div class="section-hdr-left">
                    <span class="section-arrow">${isExpanded ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span class="section-title-text">${escapeHtml(secTitle)}</span>
                </div>
                <span class="section-count">${secItems.length} 个</span>
            `;

            const secBody = document.createElement("div");
            secBody.className = `section-body ${isExpanded ? 'open' : ''}`;

            div.onclick = () => {
                if (expandedSections.has(secKey)) {
                    expandedSections.delete(secKey);
                    secBody.classList.remove("open");
                    const arrowEl = div.querySelector(".section-arrow");
                    if (arrowEl) arrowEl.innerHTML = iconArrowCollapsed;
                } else {
                    expandedSections.add(secKey);
                    secBody.classList.add("open");
                    const arrowEl = div.querySelector(".section-arrow");
                    if (arrowEl) arrowEl.innerHTML = iconArrowExpanded;
                }
            };

            secItems.forEach(item => {
                const card = createPlaylistCard(item);
                secBody.appendChild(card);
            });

            secBlock.appendChild(div);
            secBlock.appendChild(secBody);
            playlistListEl.appendChild(secBlock);
        });
    }

    // 2. 类别探索 (/search 50+ 官方专区与排行榜) - 由 explore.js 模块驱动
    function loadSearchPage() {
        switchTabUI("categories", "类别探索");
        if (categoryFilterBar) categoryFilterBar.style.display = "none";

        window.ExplorePanel.loadCategories({
            containerEl: playlistListEl,
            badgeEl: itemCountBadge,
            titleEl: listPanelTitle,
            renderSections: renderNewSections,
            getStorefront: getStorefront,
            createCard: createPlaylistCard,
            reloadExplore: loadSearchPage
        });
    }

    // 3. 我的音乐库 (分组层级结构：收藏歌单 + 我的歌单，默认折叠，未分类置顶)
    function loadLibraryPage() {
        switchTabUI("library", "我的音乐库");

        const favs = window.StorageManager.getFavPlaylists().map(f => ({ ...f, _kind: 'fav' }));
        const customs = window.StorageManager.getCustomPlaylists().map(c => ({ ...c, _kind: 'custom', name: c.title }));
        const allCount = favs.length + customs.length;

        itemCountBadge.innerText = `${allCount} 歌单`;

        // 顶栏无“全部”文字，右侧仅保留备份与恢复纯图标
        if (categoryFilterBar) {
            categoryFilterBar.style.display = "flex";
            categoryFilterBar.innerHTML = `
                <div class="filter-bar-row" style="justify-content: flex-end; width: 100%; padding: 2px 2px;">
                    <span class="cat-pill" onclick="window.LeftPanel.exportBackup()" title="导出配置与歌单备份 (JSON)">${iconDownload}</span>
                    <span class="cat-pill" onclick="window.LeftPanel.triggerImportBackup()" title="导入恢复配置与歌单 (JSON)">${iconUpload}</span>
                </div>
            `;
        }

        playlistListEl.innerHTML = "";

        // 渲染两大核心独立板块：板块 1 收藏歌单，板块 2 我的歌单
        renderLibrarySection('fav', '⭐ 收藏歌单', favs);
        renderLibrarySection('custom', '🎵 我的歌单', customs);
    }

    // 渲染具体的音乐库板块（收藏 / 自建）
    function renderLibrarySection(kind, title, items) {
        const block = document.createElement("div");
        block.className = "library-section-block";

        // 板块顶栏标题：名称 + 计数 + ➕加分类纯图标按钮
        const header = document.createElement("div");
        header.className = "library-section-title";
        header.innerHTML = `
            <span>${title} <span class="section-count">(${items.length})</span></span>
            <div class="library-action-btns">
                <button class="lib-icon-btn btn-accent" onclick="window.LeftPanel.promptCreateCategory('${kind}')" title="新建分类">${iconAdd}</button>
            </div>
        `;
        block.appendChild(header);

        // 按分类聚合，且确保“未分类”排在所有分类最上方
        const catMap = new Map();
        catMap.set("未分类", []);

        // 获取已注册的分类（包括没有歌单的空分类），并保证未分类在首位
        const registered = window.StorageManager.getRegisteredCategories(kind);
        registered.forEach(c => {
            if (c !== "未分类" && !catMap.has(c)) {
                catMap.set(c, []);
            }
        });

        // 归类歌单
        items.forEach(p => {
            let cat = p.category;
            if (!cat || cat === "默认" || cat === "未分类") {
                cat = "未分类";
            }
            if (!catMap.has(cat)) {
                catMap.set(cat, []);
            }
            catMap.get(cat).push(p);
        });

        // 逐个分类渲染行
        for (const [catName, catPlaylists] of catMap.entries()) {
            const groupKey = `${kind}_${catName}`;
            const isExpanded = expandedGroups.has(groupKey); // 默认全折叠

            // 分类标题行：左右布局，右侧明确放置修改✏️与删除➖纯图标
            const catRow = document.createElement("div");
            catRow.className = "library-cat-row";
            catRow.innerHTML = `
                <div class="library-cat-left">
                    <span class="library-cat-arrow">${isExpanded ? iconArrowExpanded : iconArrowCollapsed}</span>
                    <span class="library-cat-name">${catName === '未分类' ? '📁 未分类' : '📁 ' + escapeHtml(catName)}</span>
                    <span class="library-cat-count">(${catPlaylists.length})</span>
                </div>
                <div class="library-action-btns">
                    <button class="lib-icon-btn" onclick="event.stopPropagation(); window.LeftPanel.promptEditCategory('${kind}', '${escapeHtml(catName)}')" title="修改分类名称">${iconEdit}</button>
                    <button class="lib-icon-btn btn-danger" onclick="event.stopPropagation(); window.LeftPanel.promptDeleteCategory('${kind}', '${escapeHtml(catName)}')" title="删除分类">${iconMinus}</button>
                </div>
            `;
            catRow.addEventListener("click", () => {
                toggleCategoryExpand(groupKey);
            });
            block.appendChild(catRow);

            // 分类折叠容器 (展开时显示)
            const catBody = document.createElement("div");
            catBody.className = `library-cat-body ${isExpanded ? 'open' : ''}`;

            if (catPlaylists.length === 0) {
                catBody.innerHTML = `<div style="padding: 6px 26px; font-size: 10px; color: var(--text-muted);">暂无歌单</div>`;
            } else {
                catPlaylists.forEach(item => {
                    const plItem = document.createElement("div");
                    plItem.className = "library-playlist-item";
                    const isFav = item._kind === 'fav';
                    const trackCount = isFav ? (item.trackCount || '?') : ((item.tracks || []).length);
                    const subLabel = isFav ? escapeHtml(item.curator || 'Apple 官方') : '自建歌单';

                    plItem.innerHTML = `
                        <div class="library-playlist-info">
                            <span class="library-playlist-title">${escapeHtml(item.name || item.title)}</span>
                            <span class="library-playlist-sub">${subLabel} • 共 ${trackCount} 首</span>
                        </div>
                        <div class="library-action-btns">
                            <button class="lib-icon-btn" onclick="event.stopPropagation(); window.LeftPanel.promptEditPlaylist('${item._kind}', '${escapeHtml(item.id)}')" title="修改歌单名称">${iconEdit}</button>
                            <button class="lib-icon-btn btn-danger" onclick="event.stopPropagation(); window.LeftPanel.deleteLibraryItem('${item._kind}', '${escapeHtml(item.id)}')" title="${isFav ? '取消收藏' : '删除歌单'}">${iconMinus}</button>
                        </div>
                    `;

                    plItem.addEventListener("click", () => {
                        document.querySelectorAll(".library-playlist-item").forEach(c => c.classList.remove("active"));
                        plItem.classList.add("active");
                        closeDrawer();
                        if (isFav) {
                            window.RightPanel.selectPlaylist(item.id, item.type || "playlist", item.name || item.title, item.curator, item.url);
                        } else {
                            window.RightPanel.selectCustomPlaylist(item.id);
                        }
                    });

                    catBody.appendChild(plItem);
                });
            }

            block.appendChild(catBody);
        }

        playlistListEl.appendChild(block);
    }

    // 展开/折叠指定分类组
    function toggleCategoryExpand(groupKey) {
        if (expandedGroups.has(groupKey)) {
            expandedGroups.delete(groupKey);
        } else {
            expandedGroups.add(groupKey);
        }
        loadLibraryPage();
    }

    // 创建新分类 (+号直接触发加分类)
    function promptCreateCategory(kind = 'custom') {
        const sectionName = kind === 'fav' ? "收藏歌单" : "我的歌单";
        const name = prompt(`【${sectionName}】请输入新分类名称 (例如: 华语流行 / 摇滚 / 车载):`);
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        window.StorageManager.addCategory(kind, trimmed);
        expandedGroups.add(`${kind}_${trimmed}`);
        showToast(`已成功创建分类【${trimmed}】`);
        loadLibraryPage();
    }

    // 编辑分类名称
    function promptEditCategory(kind, catName) {
        const titleMsg = catName === "未分类"
            ? "请输入新的分类名称 (将把未分类重命名为新分类):"
            : `修改分类【${catName}】名称:`;
        const newName = prompt(titleMsg, catName === "未分类" ? "" : catName);
        if (newName && newName.trim() && newName.trim() !== catName) {
            window.StorageManager.renameCategory(kind, catName, newName.trim());
            expandedGroups.delete(`${kind}_${catName}`);
            expandedGroups.add(`${kind}_${newName.trim()}`);
            showToast(`分类已修改为【${newName.trim()}】`);
            loadLibraryPage();
        }
    }

    // 删除分类
    function promptDeleteCategory(kind, catName) {
        if (catName === "未分类") {
            if (!confirm(`确定要清空“未分类”下的所有歌单吗？`)) return;
            window.StorageManager.deleteCategory(kind, "未分类");
            showToast(`已清空“未分类”下的歌单`);
            loadLibraryPage();
            return;
        }
        if (!confirm(`确定要删除分类【${catName}】吗？分类下的歌单将自动归入未分类。`)) return;
        window.StorageManager.deleteCategory(kind, catName);
        expandedGroups.delete(`${kind}_${catName}`);
        expandedGroups.add(`${kind}_未分类`);
        showToast(`已删除分类【${catName}】，歌单已移回未分类`);
        loadLibraryPage();
    }

    // 编辑歌单 (直接修改歌单名称，直达高效，无冗余选项)
    function promptEditPlaylist(kind, id) {
        if (kind === 'custom') {
            const customs = window.StorageManager.getCustomPlaylists();
            const pl = customs.find(c => c.id === id);
            if (!pl) return;
            const newName = prompt("请输入新的歌单名称:", pl.title);
            if (newName && newName.trim() && newName.trim() !== pl.title) {
                window.StorageManager.renameCustomPlaylist(id, newName.trim());
                showToast(`歌单已重命名为《${newName.trim()}》`);
                loadLibraryPage();
            }
        } else {
            const favs = window.StorageManager.getFavPlaylists();
            const pl = favs.find(f => f.id === id);
            if (!pl) return;
            const oldName = pl.name || pl.title || "";
            const newName = prompt("请输入收藏歌单新名称:", oldName);
            if (newName && newName.trim() && newName.trim() !== oldName) {
                window.StorageManager.renameFavPlaylist(id, newName.trim());
                showToast(`收藏歌单已重命名为《${newName.trim()}》`);
                loadLibraryPage();
            }
        }
    }

    // 删除歌单
    function deleteLibraryItem(kind, id) {
        if (kind === 'fav') {
            const favs = window.StorageManager.getFavPlaylists();
            const target = favs.find(f => f.id === id);
            if (!confirm(`确定要取消收藏歌单《${target ? target.name || target.title : ''}》吗？`)) return;
            window.StorageManager.toggleFavPlaylist({ id });
            showToast(`已取消收藏《${target ? target.name || target.title : ''}》`);
            loadLibraryPage();
        } else {
            const customs = window.StorageManager.getCustomPlaylists();
            const target = customs.find(c => c.id === id);
            if (!confirm(`确定要彻底删除自建歌单《${target ? target.title : ''}》吗？`)) return;
            window.StorageManager.deleteCustomPlaylist(id);
            showToast(`已删除歌单《${target ? target.title : ''}》`);
            loadLibraryPage();
        }
    }

    function promptCreateCustomPlaylist(defaultCat = "未分类") {
        const name = prompt("请输入新歌单名称:", "我的新歌单");
        if (!name || !name.trim()) return;
        const newPl = window.StorageManager.createCustomPlaylist(name, defaultCat);
        if (newPl) {
            expandedGroups.add(`custom_${defaultCat}`);
            showToast(`成功创建自建歌单《${newPl.title}》！`);
            loadLibraryPage();
        }
    }

    // 备份与恢复
    function exportBackup() {
        const res = window.StorageManager.exportBackup();
        showToast(`已导出备份《${res.fileName}》，共 ${res.customsCount} 个自建歌单！`);
    }

    function triggerImportBackup() {
        let input = document.getElementById("amusicBackupFileInput");
        if (!input) {
            input = document.createElement("input");
            input.type = "file";
            input.id = "amusicBackupFileInput";
            input.accept = ".json,application/json";
            input.style.display = "none";
            document.body.appendChild(input);
            input.addEventListener("change", (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const text = evt.target.result;
                    const res = window.StorageManager.importBackup(text);
                    if (res.ok) {
                        showToast(`恢复成功！已还原 ${res.customCount} 个自建歌单与 ${res.favCount} 个收藏！`);
                        loadLibraryPage();
                    } else {
                        alert("导入失败: " + res.error);
                    }
                };
                reader.readAsText(file);
                input.value = "";
            });
        }
        input.click();
    }

    // 4. 全局搜索
    async function handleSearch() {
        const query = searchInput ? searchInput.value.trim() : "";
        if (!query) {
            loadNewPage();
            if (clearBtn) clearBtn.style.display = "none";
            return;
        }

        openDrawer();
        document.querySelectorAll(".main-tab-btn").forEach(btn => btn.classList.remove("active"));
        if (categoryFilterBar) categoryFilterBar.style.display = "none";
        if (clearBtn) clearBtn.style.display = "inline-block";

        listPanelTitle.innerText = `搜索: "${query}"`;
        playlistListEl.innerHTML = `<div class="loading-state">正在检索 Apple 数据库中包含 "${escapeHtml(query)}" 的歌单与专辑...</div>`;
        itemCountBadge.innerText = "...";

        try {
            const encoded = encodeURIComponent(query);
            const data = await apiRequest(`search?types=playlists,albums&term=${encoded}&limit=25`);
            const playlists = data?.results?.playlists?.data || [];
            const albums = data?.results?.albums?.data || [];
            const combined = [...playlists, ...albums];

            itemCountBadge.innerText = `${combined.length} 结果`;
            playlistListEl.innerHTML = "";
            if (combined.length === 0) {
                playlistListEl.innerHTML = '<div class="loading-state">未找到匹配的歌单或专辑。</div>';
                return;
            }

            combined.forEach(item => {
                const card = createPlaylistCard(item);
                playlistListEl.appendChild(card);
            });
        } catch (err) {
            playlistListEl.innerHTML = `<div class="loading-state">❌ 检索失败: ${err.message}</div>`;
            itemCountBadge.innerText = "0";
        }
    }

    function clearSearch() {
        if (searchInput) searchInput.value = "";
        if (clearBtn) clearBtn.style.display = "none";
        loadNewPage();
    }

    // 辅助卡片构造器
    function createPlaylistCard(item) {
        const isCurated = !!item.isCurated || item.type === "curated" || item.kind === "curated" || (item.tracks && item.tracks.length > 0);
        const kind = item.kind || item.type || (item.attributes ? (item.type === "albums" ? "album" : "playlist") : "playlist");
        const isAlbum = kind === "album" || kind === "albums";
        const typeLabel = isCurated ? "[精选歌单]" : (isAlbum ? "[专辑]" : "[歌单]");
        const tagColor = isCurated ? "var(--accent-apple, #ff7588)" : (isAlbum ? "#e3b341" : "#58a6ff");

        const name = item.title || item.name || item.attributes?.name || "未知标题";
        const curator = item.curator || item.subtitle || item.attributes?.curatorName || item.attributes?.artistName || "Apple Music";
        const desc = item.desc || item.attributes?.description?.short || item.heading || "";
        const trackCount = item.trackCount || (item.tracks ? item.tracks.length : "");
        const date = item.attributes?.lastModifiedDate ? item.attributes.lastModifiedDate.split("T")[0] : (item.attributes?.releaseDate || "");
        const sf = getStorefront();
        const url = item.url || item.attributes?.url || `https://music.apple.com/${sf}/${isAlbum ? 'album' : 'playlist'}/${item.id || ''}`;

        const card = document.createElement("div");
        card.className = "playlist-card";
        if (item.id) card.id = `card-${item.id}`;
        card.innerHTML = `
            <div class="playlist-title-row">
                <span class="playlist-name">
                    <span style="color:${tagColor}; font-size:9.5px; font-weight:normal;">${typeLabel}</span> 
                    ${escapeHtml(name)}
                </span>
                <span class="playlist-curator">${escapeHtml(curator)}</span>
            </div>
            ${desc ? `<div class="playlist-desc" style="font-size:10px; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(desc)}</div>` : ''}
            <div class="playlist-meta-row">
                <span>${trackCount ? '🎵 ' + trackCount + ' 首' : (date ? '📅 ' + date : '🔗 官方精选')}</span>
                ${item.id ? `
                    <button class="btn-card-fav" onclick="event.stopPropagation(); window.LeftPanel.promptFavCard('${escapeHtml(item.id)}', '${escapeHtml(name)}', '${escapeHtml(curator)}', '${escapeHtml(url)}', '${trackCount}')" title="收藏到分类">⭐</button>
                ` : ''}
            </div>
        `;

        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            closeDrawer();

            const isCuratedCollection = isCurated || (!item.id && (item.tracks || item.roomUrl));
            if (isCuratedCollection && window.RightPanel.selectCuratedCollection) {
                window.RightPanel.selectCuratedCollection(name, curator, url, item.roomUrl, item.tracks);
            } else if (item.id) {
                const autoType = String(item.id).startsWith("pl.") ? "playlist" : (/^\d+$/.test(String(item.id)) ? "album" : (isAlbum ? "album" : "playlist"));
                window.RightPanel.selectPlaylist(item.id, autoType, name, curator, url);
            } else if (item.tracks && window.RightPanel.selectCuratedCollection) {
                window.RightPanel.selectCuratedCollection(name, curator, url, item.roomUrl, item.tracks);
            }
        });

        return card;
    }

    function switchTabUI(tabKey, title) {
        currentMainTab = tabKey;
        document.querySelectorAll(".main-tab-btn").forEach(btn => btn.classList.remove("active"));
        const btn = document.getElementById(
            tabKey === "new" ? "btnTabNew" :
            tabKey === "categories" ? "btnTabCategories" : "btnTabLibrary"
        );
        if (btn) btn.classList.add("active");
        if (listPanelTitle) listPanelTitle.innerText = title;
    }

    // 本地存储读写委托至 StorageManager 中枢
    function getFavPlaylists() {
        return window.StorageManager.getFavPlaylists();
    }
    function saveFavPlaylists(list) {
        return window.StorageManager.saveFavPlaylists(list);
    }
    function getCustomPlaylists() {
        return window.StorageManager.getCustomPlaylists();
    }
    function saveCustomPlaylists(list) {
        return window.StorageManager.saveCustomPlaylists(list);
    }

    function promptFavCard(id, name, curator, url, trackCount) {
        if (!id) return;
        const plData = {
            id,
            type: "playlist",
            name,
            title: name,
            curator: curator || "Apple Music",
            url: url || "",
            trackCount: parseInt(trackCount, 10) || 0
        };
        window.Shell.openAddToFavModal(plData);
    }

    return {
        init,
        toggleDrawer,
        openDrawer,
        closeDrawer,
        switchMainTab,
        loadNewPage,
        loadSearchPage,
        loadLibraryPage,
        handleSearch,
        clearSearch,
        promptFavCard,
        promptCreateCategory,
        promptEditCategory,
        promptDeleteCategory,
        promptEditPlaylist,
        deleteLibraryItem,
        promptCreateCustomPlaylist,
        exportBackup,
        triggerImportBackup,
        getFavPlaylists,
        saveFavPlaylists,
        getCustomPlaylists,
        saveCustomPlaylists
    };
})();
