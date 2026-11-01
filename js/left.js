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
                renderNewSections(sections);
            },
            onUpdated: (data) => {
                const sections = data?.sections || [];
                renderNewSections(sections);
            },
            onError: (err) => {
                playlistListEl.innerHTML = `<div class="loading-state">❌ 获取 /new 页面失败: ${err.message}</div>`;
                itemCountBadge.innerText = "0";
            }
        });
    }

    function renderNewSections(sections, backToCategories = false) {
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
            divBack.className = "section-divider";
            divBack.style.cursor = "pointer";
            divBack.style.color = "var(--accent)";
            divBack.innerHTML = `<span>‹ 返回全部分类专区</span><span class="section-count">返回</span>`;
            divBack.onclick = () => renderSearchCategories(cachedCategories);
            playlistListEl.appendChild(divBack);
        }

        sections.forEach(sec => {
            const secTitle = sec.title || "推荐板块";
            const secItems = sec.items || [];
            if (secItems.length === 0) return;

            const div = document.createElement("div");
            div.className = "section-divider";
            div.innerHTML = `<span>${escapeHtml(secTitle)}</span><span class="section-count">${secItems.length} 个</span>`;
            playlistListEl.appendChild(div);

            secItems.forEach(item => {
                const card = createPlaylistCard(item);
                playlistListEl.appendChild(card);
            });
        });
    }

    // 2. 类别探索 (/search 50+ 专区)
    function loadSearchPage() {
        switchTabUI("categories", "类别探索");
        if (categoryFilterBar) categoryFilterBar.style.display = "none";

        const sf = getStorefront();
        const cacheKey = `search_categories_${sf}`;
        swrFetch(`/api/apple_search_page?storefront=${sf}`, cacheKey, {
            showLoading: () => {
                playlistListEl.innerHTML = '<div class="loading-state">正在获取 Apple 官方全部分类专区...</div>';
                itemCountBadge.innerText = "...";
            },
            onCached: (data) => {
                const categories = data?.categories || [];
                renderSearchCategories(categories);
            },
            onUpdated: (data) => {
                const categories = data?.categories || [];
                renderSearchCategories(categories);
            },
            onError: (err) => {
                playlistListEl.innerHTML = `<div class="loading-state">❌ 获取分类失败: ${err.message}</div>`;
                itemCountBadge.innerText = "0";
            }
        });
    }

    function renderSearchCategories(categories) {
        cachedCategories = categories || [];
        playlistListEl.innerHTML = "";
        if (cachedCategories.length === 0) {
            playlistListEl.innerHTML = '<div class="loading-state">暂无可探索分类专区。</div>';
            itemCountBadge.innerText = "0";
            return;
        }

        itemCountBadge.innerText = `${cachedCategories.length} 个专区`;

        const divHeader = document.createElement("div");
        divHeader.className = "section-divider";
        divHeader.innerHTML = `<span>📂 Apple 官方 50 大音乐专区</span><span class="section-count">${cachedCategories.length} 个</span>`;
        playlistListEl.appendChild(divHeader);

        cachedCategories.forEach(cat => {
            const card = document.createElement("div");
            card.className = "playlist-card";
            card.innerHTML = `
                <div class="playlist-title-row">
                    <span class="playlist-name">🏷️ ${escapeHtml(cat.title)}</span>
                    <span class="playlist-curator">Apple 专区 ›</span>
                </div>
                <div class="playlist-meta-row">
                    <span>${cat.id ? '专区 ID: ' + escapeHtml(cat.id) : '官方精选收录'}</span>
                </div>
            `;
            card.addEventListener("click", () => openCategoryPlaylists(cat));
            playlistListEl.appendChild(card);
        });
    }

    async function openCategoryPlaylists(cat) {
        listPanelTitle.innerText = `专区: ${cat.title}`;
        playlistListEl.innerHTML = `<div class="loading-state">正在加载【${escapeHtml(cat.title)}】官方歌单...</div>`;
        itemCountBadge.innerText = "...";

        const sf = getStorefront();
        const cacheKey = `cat_playlists_${sf}_${cat.id || encodeURIComponent(cat.title)}`;
        const curatorUrl = cat.url || `https://music.apple.com/${sf}/curator/${encodeURIComponent(cat.title)}/${cat.id}`;

        swrFetch(`/api/apple_curator_page?url=${encodeURIComponent(curatorUrl)}`, cacheKey, {
            showLoading: () => {
                playlistListEl.innerHTML = `<div class="loading-state">正在加载【${escapeHtml(cat.title)}】官方歌单...</div>`;
            },
            onCached: (data) => {
                const sections = data?.sections || [];
                renderNewSections(sections, true);
            },
            onUpdated: (data) => {
                const sections = data?.sections || [];
                renderNewSections(sections, true);
            },
            onError: (err) => {
                playlistListEl.innerHTML = `
                    <div class="placeholder-box" style="padding: 20px 10px;">
                        <p>❌ 加载专区失败: ${escapeHtml(err.message)}</p>
                        <button class="btn btn-sm btn-outline" onclick="window.LeftPanel.loadSearchPage()" style="margin-top: 8px;">‹ 返回专区列表</button>
                    </div>
                `;
            }
        });
    }

    // 3. 我的音乐库 (方案 A 并列展示：收藏歌单 + 自建歌单 + 胶囊筛选)
    function loadLibraryPage(filter = currentLibraryFilter) {
        currentLibraryFilter = filter;
        switchTabUI("library", "我的音乐库");

        const favs = getFavPlaylists().map(f => ({ ...f, _kind: 'fav' }));
        const customs = getCustomPlaylists().map(c => ({ ...c, _kind: 'custom', name: c.title }));
        const all = [...favs, ...customs];

        itemCountBadge.innerText = `${all.length} 歌单`;

        if (all.length === 0) {
            if (categoryFilterBar) categoryFilterBar.style.display = "none";
            playlistListEl.innerHTML = `
                <div class="placeholder-box">
                    <p>音乐库暂无歌单</p>
                    <p class="muted">在右侧曲目表中点击【⭐ 收藏歌单】，或在此处点击新建自建歌单。</p>
                    <button class="btn btn-sm btn-primary" onclick="window.LeftPanel.promptCreateCustomPlaylist()" style="margin-top: 8px;">➕ 新建自建歌单</button>
                </div>
            `;
            return;
        }

        renderLibraryFilterBar(favs, customs);

        let filtered = all;
        if (currentLibraryFilter === "fav") {
            filtered = all.filter(item => item._kind === 'fav');
        } else if (currentLibraryFilter === "custom") {
            filtered = all.filter(item => item._kind === 'custom');
        } else if (currentLibraryFilter !== "全部") {
            filtered = all.filter(item => (item.category || "默认") === currentLibraryFilter);
        }

        playlistListEl.innerHTML = "";
        if (filtered.length === 0) {
            playlistListEl.innerHTML = `
                <div class="placeholder-box">
                    <p>分类【${escapeHtml(currentLibraryFilter)}】下暂无歌单</p>
                    <button class="btn btn-sm btn-outline" onclick="window.LeftPanel.selectLibraryFilter('全部')" style="margin-top: 8px;">查看全部歌单</button>
                </div>
            `;
            return;
        }

        filtered.forEach((item) => {
            const card = document.createElement("div");
            card.className = "playlist-card";
            const isFav = item._kind === 'fav';
            const catName = item.category || "默认";
            const trackCount = isFav ? (item.trackCount || '?') : ((item.tracks || []).length);
            const subLabel = isFav ? `⭐ 收藏 • ${escapeHtml(item.curator || 'Apple 官方')}` : `🎵 自建歌单`;

            card.innerHTML = `
                <div class="playlist-title-row">
                    <span class="playlist-name">${escapeHtml(item.name || item.title)}</span>
                    <span class="playlist-curator">${subLabel}</span>
                </div>
                <div class="playlist-meta-row">
                    <span class="cat-badge" onclick="event.stopPropagation(); window.LeftPanel.promptChangeCategory('${item._kind}', '${escapeHtml(item.id)}')" title="点击修改所属分类">🏷️ ${escapeHtml(catName)}</span>
                    <span class="meta-tag">共 ${trackCount} 首</span>
                    <button class="btn-card-del" onclick="event.stopPropagation(); window.LeftPanel.deleteLibraryItem('${item._kind}', '${escapeHtml(item.id)}')" title="${isFav ? '取消收藏' : '删除歌单'}">🗑️</button>
                </div>
            `;

            card.addEventListener("click", () => {
                document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
                card.classList.add("active");
                closeDrawer();
                if (isFav) {
                    window.RightPanel.selectPlaylist(item.id, item.type || "playlist", item.name || item.title, item.curator, item.url);
                } else {
                    window.RightPanel.selectCustomPlaylist(item.id);
                }
            });

            playlistListEl.appendChild(card);
        });
    }

    function renderLibraryFilterBar(favs, customs) {
        if (!categoryFilterBar) return;
        categoryFilterBar.style.display = "flex";

        const all = [...favs, ...customs];
        const customCats = Array.from(new Set(all.map(item => item.category || "默认")));

        let html = `
            <span class="cat-pill ${currentLibraryFilter === '全部' ? 'active' : ''}" onclick="window.LeftPanel.selectLibraryFilter('全部')">全部 (${all.length})</span>
            <span class="cat-pill ${currentLibraryFilter === 'fav' ? 'active' : ''}" onclick="window.LeftPanel.selectLibraryFilter('fav')">⭐ 收藏 (${favs.length})</span>
            <span class="cat-pill ${currentLibraryFilter === 'custom' ? 'active' : ''}" onclick="window.LeftPanel.selectLibraryFilter('custom')">🎵 自建 (${customs.length})</span>
        `;

        customCats.forEach(cat => {
            if (cat !== '默认') {
                const count = all.filter(item => (item.category || "默认") === cat).length;
                const isActive = currentLibraryFilter === cat;
                html += `<span class="cat-pill ${isActive ? 'active' : ''}" onclick="window.LeftPanel.selectLibraryFilter('${escapeHtml(cat)}')">🏷️ ${escapeHtml(cat)} (${count})</span>`;
            }
        });

        html += `<span class="cat-pill" onclick="window.LeftPanel.promptCreateCategory()" title="新建自定义分类">➕ 分类</span>`;
        html += `<button class="btn-add-playlist-pill" onclick="window.LeftPanel.promptCreateCustomPlaylist()" title="新建自建歌单">➕ 新建自建歌单</button>`;

        categoryFilterBar.innerHTML = html;
    }

    function selectLibraryFilter(filter) {
        currentLibraryFilter = filter;
        loadLibraryPage();
    }

    function deleteLibraryItem(kind, id) {
        if (kind === 'fav') {
            if (!confirm("确定要取消收藏此歌单吗？")) return;
            let favs = getFavPlaylists();
            const target = favs.find(f => f.id === id);
            favs = favs.filter(f => f.id !== id);
            saveFavPlaylists(favs);
            showToast(`已移除收藏歌单《${target ? target.name || target.title : ''}》`);
            loadLibraryPage();
        } else {
            if (!confirm("确定要删除此自建歌单吗？")) return;
            let customs = getCustomPlaylists();
            const target = customs.find(c => c.id === id);
            customs = customs.filter(c => c.id !== id);
            saveCustomPlaylists(customs);
            showToast(`歌单《${target ? target.title : ''}》已删除`);
            loadLibraryPage();
        }
    }

    function promptCreateCategory() {
        const name = prompt("请输入新分类名称 (例如: 华语流行 / 摇滚 / 车载 / 睡眠 / 工作):");
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        currentLibraryFilter = trimmed;
        loadLibraryPage(trimmed);
        showToast(`已切换至新分类: ${trimmed}`);
    }

    function promptChangeCategory(type, id) {
        const isFav = type === 'fav';
        const list = isFav ? getFavPlaylists() : getCustomPlaylists();
        const target = list.find(item => item.id === id);
        if (!target) return;
        const oldCat = target.category || "默认";
        const newCat = prompt(`修改歌单【${target.name || target.title}】所属分类:`, oldCat);
        if (newCat === null) return;
        target.category = newCat.trim() || "默认";
        if (isFav) {
            saveFavPlaylists(list);
        } else {
            saveCustomPlaylists(list);
        }
        loadLibraryPage();
        showToast(`已移动到分类: ${target.category}`);
    }

    function promptCreateCustomPlaylist() {
        const name = prompt("请输入新歌单名称:", "我的精选歌单");
        if (!name || !name.trim()) return;
        const customs = getCustomPlaylists();
        const defaultCat = currentLibraryFilter !== "全部" && currentLibraryFilter !== "fav" && currentLibraryFilter !== "custom"
            ? currentLibraryFilter
            : "默认";

        const newPl = {
            id: "custom_" + Date.now(),
            title: name.trim(),
            category: defaultCat,
            createdAt: new Date().toLocaleDateString(),
            tracks: []
        };
        customs.unshift(newPl);
        saveCustomPlaylists(customs);
        showToast(`成功创建歌单《${newPl.title}》！`);
        loadLibraryPage();
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
        const isCurated = !!item.isCurated;
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
            </div>
        `;

        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            closeDrawer();

            if (isCurated && window.RightPanel.selectCuratedCollection) {
                window.RightPanel.selectCuratedCollection(name, curator, url, item.roomUrl, item.tracks);
            } else if (item.id) {
                window.RightPanel.selectPlaylist(item.id, isAlbum ? "album" : "playlist", name, curator, url);
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

    // 本地存储读写
    function getFavPlaylists() {
        try {
            return JSON.parse(localStorage.getItem("amusic_fav_playlists") || "[]");
        } catch (e) {
            return [];
        }
    }
    function saveFavPlaylists(list) {
        localStorage.setItem("amusic_fav_playlists", JSON.stringify(list));
    }
    function getCustomPlaylists() {
        try {
            return JSON.parse(localStorage.getItem("amusic_custom_playlists") || "[]");
        } catch (e) {
            return [];
        }
    }
    function saveCustomPlaylists(list) {
        localStorage.setItem("amusic_custom_playlists", JSON.stringify(list));
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
        selectLibraryFilter,
        deleteLibraryItem,
        promptCreateCategory,
        promptChangeCategory,
        promptCreateCustomPlaylist,
        getFavPlaylists,
        saveFavPlaylists,
        getCustomPlaylists,
        saveCustomPlaylists
    };
})();
