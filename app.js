// Amusic - Apple Music 纯文本数据库浏览器核心逻辑
const APPLE_MUSIC_API = "/api/apple/v1/catalog";

// 提取自 Apple Music 官方 Web 播放器的公共只读访客 Token (有效期至 2027 年)
const DEFAULT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";

let currentStorefront = "cn";
let currentPlaylistData = null;
let currentTracks = [];
let isViewingCustomPlaylist = false;
let currentCustomPlaylistId = null;
let pendingTrackToAdd = null;

// DOM 元素引用
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const clearBtn = document.getElementById("clearBtn");
const storefrontSelect = document.getElementById("storefrontSelect");
const playlistListEl = document.getElementById("playlistList");
const listPanelTitle = document.getElementById("listPanelTitle");
const itemCountBadge = document.getElementById("itemCountBadge");
const statusText = document.getElementById("statusText");
const speedMetric = document.getElementById("speedMetric");
const detailTitle = document.getElementById("detailTitle");
const detailSubtitle = document.getElementById("detailSubtitle");
const detailActions = document.getElementById("detailActions");
const detailBody = document.getElementById("detailBody");
const btnFavCurrent = document.getElementById("btnFavCurrent");
const toastEl = document.getElementById("toast");

// 左侧抽屉元素
const sidebarDrawer = document.getElementById("sidebarDrawer");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const favCountBadge = document.getElementById("favCountBadge");
const customCountBadge = document.getElementById("customCountBadge");
const categoryFilterBar = document.getElementById("categoryFilterBar");

// 分类筛选状态
let currentFavCategory = "全部";
let currentCustomCategory = "全部";

// 手机端单栏联动：切换到曲目详情视图
function mobileShowDetail() {
    const main = document.getElementById("mainLayout");
    if (main) main.classList.add("mobile-detail-active");
}

// 手机端返回歌单列表视图
function mobileBackToList() {
    const main = document.getElementById("mainLayout");
    if (main) main.classList.remove("mobile-detail-active");
}

// 关闭所有底部抽屉与遮罩
function closeAllDrawers() {
    document.getElementById("queueDrawer")?.classList.remove("open");
    document.getElementById("btnQueueModal")?.classList.remove("btn-nav-active");
    document.getElementById("sourceDrawer")?.classList.remove("open");
    document.getElementById("btnSourceModal")?.classList.remove("btn-nav-active");
    document.getElementById("drawerBackdrop")?.classList.remove("open");
}

// 初始化
window.addEventListener("DOMContentLoaded", () => {
    storefrontSelect.addEventListener("change", (e) => {
        currentStorefront = e.target.value;
        const query = searchInput.value.trim();
        if (query) {
            handleSearch();
        } else {
            loadNewPage();
        }
    });

    updateBadgeCounts();

    // 默认加载官方最新发布 (/new)
    loadNewPage();
});

// ========================================================
// 通用 Apple Music API 请求函数
async function apiRequest(endpoint) {
    const startTime = performance.now();
    statusText.innerText = `正在向 Apple 官方服务器请求: ${endpoint.split("?")[0]} ...`;
    speedMetric.innerText = "";

    try {
        const response = await fetch(`${APPLE_MUSIC_API}/${currentStorefront}/${endpoint}`);
        const duration = Math.round(performance.now() - startTime);

        if (!response.ok) {
            throw new Error(`Apple API 响应异常: HTTP ${response.status}`);
        }

        const data = await response.json();
        statusText.innerText = "Apple 数据库连接正常 (纯文本传输，0 图片开销)";
        speedMetric.innerText = `⚡ ${duration} ms`;
        return data;
    } catch (err) {
        const duration = Math.round(performance.now() - startTime);
        statusText.innerText = `请求失败: ${err.message}`;
        speedMetric.innerText = `❌ ${duration} ms`;
        console.error("Apple Music API Error:", err);
        throw err;
    }
}

// 抽屉导航控制
// ========================================================
function toggleSidebar() {
    sidebarDrawer.classList.toggle("open");
    sidebarOverlay.classList.toggle("open");
}

function closeSidebar() {
    sidebarDrawer.classList.remove("open");
    sidebarOverlay.classList.remove("open");
}

function setActiveNav(navId) {
    document.querySelectorAll(".sidebar-nav-item").forEach(el => el.classList.remove("active"));
    document.getElementById(navId)?.classList.add("active");
}

// ========================================================
// 本地存储：收藏歌单 (官方镜像) & 自建歌单
// ========================================================
function getFavPlaylists() {
    try {
        return JSON.parse(localStorage.getItem("amusic_fav_playlists") || "[]");
    } catch (e) {
        return [];
    }
}

function saveFavPlaylists(list) {
    localStorage.setItem("amusic_fav_playlists", JSON.stringify(list));
    updateBadgeCounts();
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
    updateBadgeCounts();
}

function updateBadgeCounts() {
    if (favCountBadge) favCountBadge.innerText = getFavPlaylists().length;
    if (customCountBadge) customCountBadge.innerText = getCustomPlaylists().length;
}

// 抓取并加载 music.apple.com/new 页面全量板块
async function loadNewPage() {
    setActiveNav("btnNavNew");
    if (categoryFilterBar) categoryFilterBar.style.display = "none";
    mobileBackToList();
    listPanelTitle.innerText = "Apple 官方最新发布 (/new)";
    playlistListEl.innerHTML = '<div class="loading-state">正在深度抓取 Apple 官方最新发布板块 (/new)...</div>';
    itemCountBadge.innerText = "...";
    statusText.innerText = `正在抓取 music.apple.com/${currentStorefront}/new 纯文本板块数据...`;
    const startTime = performance.now();

    try {
        const response = await fetch(`/api/apple_new?storefront=${currentStorefront}`);
        const duration = Math.round(performance.now() - startTime);
        
        if (!response.ok) {
            throw new Error(`抓取异常: HTTP ${response.status}`);
        }

        const data = await response.json();
        const sections = data?.sections || [];
        statusText.innerText = `music.apple.com/new 抓取完成 (共 ${sections.length} 个板块，0 图片开销)`;
        speedMetric.innerText = `⚡ ${duration} ms`;

        renderNewSections(sections);
    } catch (err) {
        const duration = Math.round(performance.now() - startTime);
        playlistListEl.innerHTML = `<div class="loading-state">❌ 抓取 /new 页面失败: ${err.message}</div>`;
        itemCountBadge.innerText = "0";
        statusText.innerText = `抓取失败: ${err.message}`;
        speedMetric.innerText = `❌ ${duration} ms`;
    }
}

// 抓取并加载 music.apple.com/search 类别浏览全部分类专区
async function loadSearchPage() {
    setActiveNav("btnNavSearchPage");
    if (categoryFilterBar) categoryFilterBar.style.display = "none";
    mobileBackToList();
    listPanelTitle.innerText = "类别浏览与探索 (music.apple.com/search)";
    playlistListEl.innerHTML = '<div class="loading-state">正在抓取 Apple 官方全部分类与专区列表 (/search)...</div>';
    itemCountBadge.innerText = "...";
    statusText.innerText = `正在抓取 music.apple.com/${currentStorefront}/search 纯文本分类数据...`;
    const startTime = performance.now();

    try {
        const response = await fetch(`/api/apple_search_page?storefront=${currentStorefront}`);
        const duration = Math.round(performance.now() - startTime);

        if (!response.ok) {
            throw new Error(`抓取异常: HTTP ${response.status}`);
        }

        const data = await response.json();
        const categories = data?.categories || [];
        statusText.innerText = `music.apple.com/search 抓取完成 (共 ${categories.length} 个官方分类专区，0 图片开销)`;
        speedMetric.innerText = `⚡ ${duration} ms`;

        renderSearchCategories(categories);
    } catch (err) {
        const duration = Math.round(performance.now() - startTime);
        playlistListEl.innerHTML = `<div class="loading-state">❌ 抓取 /search 分类失败: ${err.message}</div>`;
        itemCountBadge.innerText = "0";
        statusText.innerText = `抓取失败: ${err.message}`;
        speedMetric.innerText = `❌ ${duration} ms`;
    }
}

let cachedCategories = [];

// 渲染 /search 的 50 个分类专区
function renderSearchCategories(categories) {
    cachedCategories = categories || [];
    listPanelTitle.innerText = "类别浏览与探索 (music.apple.com/search)";

    if (!categories || categories.length === 0) {
        playlistListEl.innerHTML = '<div class="loading-state">未抓取到分类数据。</div>';
        itemCountBadge.innerText = "0";
        return;
    }

    itemCountBadge.innerText = `${categories.length} 个官方专区`;
    playlistListEl.innerHTML = "";

    const divHeader = document.createElement("div");
    divHeader.className = "section-divider";
    divHeader.innerHTML = `
        <span>📂 Apple 官方 50 大音乐专区 (点击进入歌单池)</span>
        <span class="section-count">${categories.length} 个</span>
    `;
    playlistListEl.appendChild(divHeader);

    categories.forEach((cat) => {
        const card = document.createElement("div");
        card.className = "playlist-card";
        card.innerHTML = `
            <div class="playlist-title-row">
                <span class="playlist-name">
                    <span style="color:#79c0ff; font-weight:normal; font-size:10px;">[专区]</span> 
                    ${escapeHtml(cat.title)}
                </span>
                <span class="playlist-curator">Apple Music 官方</span>
            </div>
            <div class="playlist-desc">点击立即查看【${escapeHtml(cat.title)}】专区收录的所有官方精选歌单与专辑</div>
            <div class="playlist-meta-row">
                <span>专区 ID: ${escapeHtml(cat.id)}</span>
            </div>
        `;

        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            openCategoryPlaylists(cat);
        });

        playlistListEl.appendChild(card);
    });
}

// 点击某个分类专区（如“国语流行”或“摇滚”），加载该专区的全部官方歌单
async function openCategoryPlaylists(cat) {
    listPanelTitle.innerText = `【${cat.title}】官方专区`;
    playlistListEl.innerHTML = `<div class="loading-state">正在深度抓取 Apple【${escapeHtml(cat.title)}】官方主页全量板块...</div>`;
    itemCountBadge.innerText = "...";
    statusText.innerText = `正在抓取 ${cat.url || cat.title} 官方全量板块...`;
    const startTime = performance.now();

    try {
        // 1. 如果该专区有完整的官方主页链接 (如 curator 页面)，直接深度抓取官方真实板块！
        // 确保展示的“焦点推荐、歌单、年度热门、年代作品、明星曲目单、经典专辑”与官网 100% 相同！
        if (cat.url && (cat.url.includes("/curator/") || cat.url.includes("/apple-curator/"))) {
            const resp = await fetch(`/api/apple_curator_page?url=${encodeURIComponent(cat.url)}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.sections && data.sections.length > 0) {
                    const duration = Math.round(performance.now() - startTime);
                    statusText.innerText = `已载入【${cat.title}】官方主页 ${data.sections.length} 个真实板块 (0 图片开销)`;
                    speedMetric.innerText = `⚡ ${duration} ms`;
                    renderNewSections(data.sections, true);
                    return;
                }
            }
        }

        // 2. 兜底回退：通过 apple-curators API 与专区搜索
        let playlists = [];
        try {
            const curData = await apiRequest(`apple-curators/${cat.id}/playlists?limit=10`);
            if (curData?.data && curData.data.length > 0) {
                playlists = curData.data;
            }
        } catch (e) {
            console.log("Curator 接口未直接支持该专区 ID，准备执行全库搜索补充", e);
        }

        if (playlists.length < 5) {
            try {
                const searchData = await apiRequest(`search?types=playlists,albums&term=${encodeURIComponent(cat.title)}&limit=25`);
                const pList = searchData?.results?.playlists?.data || [];
                const aList = searchData?.results?.albums?.data || [];
                const combined = [...pList, ...aList];

                const existingIds = new Set(playlists.map(p => p.id));
                combined.forEach(item => {
                    if (!existingIds.has(item.id)) {
                        playlists.push(item);
                    }
                });
            } catch (errSearch) {
                console.warn("补充专区搜索失败:", errSearch);
            }
        }

        const duration = Math.round(performance.now() - startTime);
        statusText.innerText = `已载入【${cat.title}】专区 ${playlists.length} 个歌单与专辑`;
        speedMetric.innerText = `⚡ ${duration} ms`;

        renderPlaylistCards(playlists);

        // 在顶部加入“‹ 返回 50 大分类专区”导航栏
        const divBack = document.createElement("div");
        divBack.className = "section-divider";
        divBack.style.cursor = "pointer";
        divBack.style.color = "#79c0ff";
        divBack.style.backgroundColor = "rgba(88, 166, 255, 0.12)";
        divBack.innerHTML = `
            <span>‹ 返回 50 大分类专区列表</span>
            <span class="section-count">当前共 ${playlists.length} 个歌单/专辑</span>
        `;
        divBack.onclick = () => renderSearchCategories(cachedCategories);
        playlistListEl.prepend(divBack);

    } catch (err) {
        playlistListEl.innerHTML = `
            <div class="loading-state">
                <p>❌ 加载【${escapeHtml(cat.title)}】歌单失败: ${err.message}</p>
                <button class="btn btn-secondary" onclick="renderSearchCategories(cachedCategories)" style="margin-top:10px;">‹ 返回分类列表</button>
            </div>
        `;
        itemCountBadge.innerText = "0";
    }
}

// 渲染多板块结构化列表 (全歌单/专辑模式，无散装单曲)
function renderNewSections(sections, backToCategories = false) {
    if (!sections || sections.length === 0) {
        playlistListEl.innerHTML = '<div class="loading-state">未抓取到板块数据。</div>';
        itemCountBadge.innerText = "0";
        return;
    }

    let totalItems = 0;
    sections.forEach(s => totalItems += (s.items?.length || 0));
    itemCountBadge.innerText = `${sections.length} 板块 / ${totalItems} 个歌单与专辑`;

    playlistListEl.innerHTML = "";

    // 如果需要返回分类列表
    if (backToCategories) {
        const divBack = document.createElement("div");
        divBack.className = "section-divider";
        divBack.style.cursor = "pointer";
        divBack.style.color = "#79c0ff";
        divBack.style.backgroundColor = "rgba(88, 166, 255, 0.12)";
        divBack.innerHTML = `
            <span>‹ 返回 50 大分类专区列表</span>
            <span class="section-count">共 ${sections.length} 个官方板块</span>
        `;
        divBack.onclick = () => renderSearchCategories(cachedCategories);
        playlistListEl.appendChild(divBack);
    }

    sections.forEach((sec) => {
        // 板块吸顶分界线
        const divHeader = document.createElement("div");
        divHeader.className = "section-divider";
        divHeader.innerHTML = `
            <span>${escapeHtml(sec.title)}</span>
            <span class="section-count">${sec.items.length} 个</span>
        `;
        playlistListEl.appendChild(divHeader);

        // 板块内部项目 (全部为歌单或专辑实体)
        sec.items.forEach((item) => {
            const isCurated = !!item.isCurated;
            const kind = item.kind || "playlist";
            let typeLabel = isCurated ? "[精选歌单]" : (kind === "album" ? "[专辑]" : "[歌单]");
            let tagColor = isCurated ? "#ff7588" : (kind === "album" ? "#e3b341" : "#58a6ff");

            const card = document.createElement("div");
            card.className = "playlist-card";
            card.innerHTML = `
                <div class="playlist-title-row">
                    <span class="playlist-name">
                        <span style="color:${tagColor}; font-weight:normal; font-size:10px;">${typeLabel}</span> 
                        ${escapeHtml(item.title)}
                    </span>
                    <span class="playlist-curator">${escapeHtml(item.curator || item.subtitle || 'Apple Music')}</span>
                </div>
                <div class="playlist-desc">${escapeHtml(item.desc || '')}</div>
                <div class="playlist-meta-row">
                    <span>${item.trackCount ? '🎵 ' + item.trackCount + ' 首' : (item.url ? '<span title="官方精选">🔗</span>' : '')}</span>
                </div>
            `;

            card.addEventListener("click", () => {
                document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
                card.classList.add("active");

                if (isCurated) {
                    selectCuratedCollection(item.title, item.curator, item.url, item.roomUrl, item.tracks);
                } else {
                    selectPlaylist(item.id, kind, item.title, item.curator || item.subtitle, item.url);
                }
            });

            playlistListEl.appendChild(card);
        });
    });
}

// 点击官方合集歌单 (如“新歌精选”、“正在流行中”)
async function selectCuratedCollection(title, curator, url, roomUrl, fallbackTracks) {
    currentPlaylistData = { id: "", type: "playlist", name: title, curator: curator, url: url };
    currentTracks = fallbackTracks || [];

    mobileShowDetail();

    detailTitle.innerText = title;
    detailSubtitle.innerText = `${curator} • 官方精选 (共 ${currentTracks.length} 首)`;
    detailActions.style.display = "flex";
    renderTracklist(currentTracks);

    // 如果包含官方 Room 专题页，自动在后台拉取完整的 100 首曲目
    if (roomUrl) {
        try {
            statusText.innerText = `正在从 Apple 专题拉取《${title}》完整曲目...`;
            const resp = await fetch(`/api/apple_room?url=${encodeURIComponent(roomUrl)}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.tracks && data.tracks.length > 0) {
                    currentTracks = data.tracks;
                    detailSubtitle.innerText = `${curator} • 官方完整专题 (共 ${currentTracks.length} 首)`;
                    statusText.innerText = `已载入《${title}》全部 ${currentTracks.length} 首曲目`;
                    renderTracklist(currentTracks);
                }
            }
        } catch (e) {
            console.warn("加载 room 详情失败，保持精选列表", e);
        }
    }
}

// 搜索歌单与专辑
async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) {
        loadNewPage();
        clearBtn.style.display = "none";
        return;
    }

    setActiveNav("");
    if (categoryFilterBar) categoryFilterBar.style.display = "none";
    mobileBackToList();
    clearBtn.style.display = "inline-block";
    listPanelTitle.innerText = `搜索结果: "${query}"`;
    playlistListEl.innerHTML = `<div class="loading-state">正在检索数据库中包含 "${escapeHtml(query)}" 的歌单与专辑...</div>`;
    itemCountBadge.innerText = "...";

    try {
        const encoded = encodeURIComponent(query);
        const data = await apiRequest(`search?types=playlists,albums&term=${encoded}&limit=25`);
        
        const playlists = data?.results?.playlists?.data || [];
        const albums = data?.results?.albums?.data || [];
        
        // 合并展示，歌单优先，随后专辑
        const combined = [...playlists, ...albums];
        renderPlaylistCards(combined);
    } catch (err) {
        playlistListEl.innerHTML = `<div class="loading-state">❌ 检索失败: ${err.message}</div>`;
        itemCountBadge.innerText = "0";
    }
}

function handleSearchKeyDown(event) {
    if (event.key === "Enter") {
        handleSearch();
    }
}

function clearSearch() {
    searchInput.value = "";
    clearBtn.style.display = "none";
    loadNewPage();
}

// 渲染左侧歌单卡片列表
function renderPlaylistCards(items) {
    itemCountBadge.innerText = items.length;

    if (!items || items.length === 0) {
        playlistListEl.innerHTML = '<div class="loading-state">未在 Apple 数据库中找到相关内容。</div>';
        return;
    }

    playlistListEl.innerHTML = "";

    items.forEach((item) => {
        const attr = item.attributes;
        const isAlbum = item.type === "albums";
        const typeLabel = isAlbum ? "[专辑]" : "[歌单]";
        const name = attr?.name || "未知标题";
        const curator = attr?.curatorName || attr?.artistName || "Apple Music 编辑";
        const desc = attr?.description?.short || attr?.description?.standard || attr?.recordLabel || "官方精选收录";
        const date = attr?.lastModifiedDate ? attr.lastModifiedDate.split("T")[0] : (attr?.releaseDate || "");
        const url = attr?.url || `https://music.apple.com/${currentStorefront}/${isAlbum ? 'album' : 'playlist'}/${item.id}`;

        const card = document.createElement("div");
        card.className = "playlist-card";
        card.id = `card-${item.id}`;
        card.innerHTML = `
            <div class="playlist-title-row">
                <span class="playlist-name"><span style="color:var(--accent); font-weight:normal; font-size:10px;">${typeLabel}</span> ${escapeHtml(name)}</span>
                <span class="playlist-curator">${escapeHtml(curator)}</span>
            </div>
            <div class="playlist-desc">${escapeHtml(desc)}</div>
            <div class="playlist-meta-row">
                <span>${date ? '📅 ' + date : '🔗 官方专辑'}</span>
            </div>
        `;

        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            selectPlaylist(item.id, isAlbum ? "album" : "playlist", name, curator, url);
        });

        playlistListEl.appendChild(card);
    });
}

// 点击歌单，查看详细曲目
async function selectPlaylist(id, type, name, curator, url) {
    isViewingCustomPlaylist = false;
    currentCustomPlaylistId = null;
    currentPlaylistData = { id, type, name, curator, url };
    currentTracks = [];

    mobileShowDetail();

    detailTitle.innerText = name;
    detailSubtitle.innerText = `${curator} • 正在获取曲目清单...`;
    detailActions.style.display = "none";
    detailBody.innerHTML = '<div class="loading-state">正在向 Apple 数据库解析曲目列表...</div>';

    updateFavButtonStatus();

    try {
        const endpoint = `${type}s/${id}`;
        const data = await apiRequest(endpoint);
        const item = data?.data?.[0];
        const tracks = item?.relationships?.tracks?.data || [];

        currentTracks = tracks.map((t, idx) => {
            const attr = t.attributes;
            return {
                index: idx + 1,
                name: attr?.name || "未知曲目",
                artist: attr?.artistName || "未知歌手",
                album: attr?.albumName || name,
                durationMillis: attr?.durationInMillis || 0,
                isrc: attr?.isrc || "",
                url: attr?.url || ""
            };
        });

        detailSubtitle.innerText = `${curator} • 共 ${currentTracks.length} 首歌曲`;
        detailActions.style.display = "flex";
        renderTracklist(currentTracks);
    } catch (err) {
        detailBody.innerHTML = `<div class="loading-state">❌ 获取歌曲详情失败: ${err.message}</div>`;
        detailSubtitle.innerText = "获取曲目清单失败";
    }
}

// 检查并更新当前歌单的“收藏”状态
function updateFavButtonStatus() {
    if (!btnFavCurrent) return;
    if (isViewingCustomPlaylist || !currentPlaylistData?.id) {
        btnFavCurrent.style.display = "none";
        return;
    }
    btnFavCurrent.style.display = "inline-flex";
    btnFavCurrent.innerText = "⭐";
    const favs = getFavPlaylists();
    const isFav = favs.some(f => f.id === currentPlaylistData.id);
    if (isFav) {
        btnFavCurrent.title = "已收藏 (点击取消收藏)";
        btnFavCurrent.classList.add("btn-nav-active");
    } else {
        btnFavCurrent.title = "收藏此歌单";
        btnFavCurrent.classList.remove("btn-nav-active");
    }
}

// 收藏 / 取消收藏当前官方歌单 (歌单名为复制)
function toggleFavCurrentPlaylist() {
    if (!currentPlaylistData || isViewingCustomPlaylist) return;
    let favs = getFavPlaylists();
    const existingIdx = favs.findIndex(f => f.id === currentPlaylistData.id);

    if (existingIdx >= 0) {
        favs.splice(existingIdx, 1);
        saveFavPlaylists(favs);
        updateFavButtonStatus();
        showToast(`已取消收藏歌单《${currentPlaylistData.name}》`);
    } else {
        const defaultCat = currentFavCategory !== "全部" ? currentFavCategory : "默认";
        const newFav = {
            id: currentPlaylistData.id,
            type: currentPlaylistData.type || "playlist",
            name: currentPlaylistData.name,
            title: currentPlaylistData.name,
            curator: currentPlaylistData.curator || "Apple Music",
            category: defaultCat,
            url: currentPlaylistData.url || "",
            trackCount: currentTracks.length,
            savedAt: new Date().toLocaleDateString()
        };
        favs.unshift(newFav);
        saveFavPlaylists(favs);
        updateFavButtonStatus();
        showToast(`已收藏歌单《${currentPlaylistData.name}》到我的歌单库！`);
    }
}

// 统一分类筛选条渲染器
function renderCategoryFilterBar(type, list) {
    if (!categoryFilterBar) return;
    categoryFilterBar.style.display = "flex";
    
    // 提取全部已知分类
    const distinctCats = ["全部", ...Array.from(new Set(list.map(item => item.category || "默认")))];
    const currentCat = type === 'fav' ? currentFavCategory : currentCustomCategory;
    if (!distinctCats.includes(currentCat)) {
        if (type === 'fav') currentFavCategory = "全部";
        else currentCustomCategory = "全部";
    }

    let html = '';
    distinctCats.forEach(cat => {
        const isActive = cat === (type === 'fav' ? currentFavCategory : currentCustomCategory);
        html += `<span class="cat-pill ${isActive ? 'active' : ''}" onclick="selectCategoryFilter('${type}', '${escapeHtml(cat)}')">${escapeHtml(cat)}</span>`;
    });
    html += `<span class="cat-pill cat-pill-add" onclick="promptCreateCategory('${type}')">➕ 新建分类</span>`;

    categoryFilterBar.innerHTML = html;
}

function selectCategoryFilter(type, cat) {
    if (type === 'fav') {
        currentFavCategory = cat;
        loadFavPlaylists();
    } else {
        currentCustomCategory = cat;
        loadCustomPlaylists();
    }
}

function promptCreateCategory(type) {
    const name = prompt("请输入新分类名称 (例如: 华语流行 / 摇滚 / 车载 / 睡眠 / 工作):");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (type === 'fav') {
        currentFavCategory = trimmed;
        loadFavPlaylists();
    } else {
        currentCustomCategory = trimmed;
        loadCustomPlaylists();
    }
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
        loadFavPlaylists();
    } else {
        saveCustomPlaylists(list);
        loadCustomPlaylists();
    }
    showToast(`已移动到分类: ${target.category}`);
}

// 浏览“⭐ 收藏的歌单”
function loadFavPlaylists() {
    setActiveNav("btnNavFav");
    mobileBackToList();
    listPanelTitle.innerText = "⭐ 收藏的歌单";
    const favs = getFavPlaylists();
    itemCountBadge.innerText = favs.length;
    statusText.innerText = `当前已收藏 ${favs.length} 个官方歌单`;

    if (favs.length === 0) {
        if (categoryFilterBar) categoryFilterBar.style.display = "none";
        playlistListEl.innerHTML = `
            <div class="placeholder-box" style="padding: 40px 20px;">
                <p>暂无收藏的歌单</p>
                <p class="muted">在浏览 Apple 官方歌单时，点击右上角【⭐ 收藏歌单】即可保存于此。</p>
            </div>
        `;
        return;
    }

    renderCategoryFilterBar('fav', favs);

    const filteredFavs = currentFavCategory === "全部" 
        ? favs 
        : favs.filter(f => (f.category || "默认") === currentFavCategory);

    playlistListEl.innerHTML = "";
    if (filteredFavs.length === 0) {
        playlistListEl.innerHTML = `
            <div class="placeholder-box" style="padding: 30px 16px;">
                <p>分类【${escapeHtml(currentFavCategory)}】下暂无收藏歌单</p>
                <button class="btn btn-sm btn-outline" onclick="currentFavCategory='全部'; loadFavPlaylists();" style="margin-top: 10px;">查看全部分类</button>
            </div>
        `;
        return;
    }

    filteredFavs.forEach((item) => {
        const card = document.createElement("div");
        card.className = "playlist-card";
        const catName = item.category || "默认";
        card.innerHTML = `
            <div class="playlist-title-row">
                <span class="playlist-name">${escapeHtml(item.name || item.title)}</span>
                <span class="playlist-curator">${escapeHtml(item.curator)}</span>
            </div>
            <div class="playlist-meta-row">
                <span class="cat-badge" onclick="event.stopPropagation(); promptChangeCategory('fav', '${escapeHtml(item.id)}')" title="点击修改分类">🏷️ ${escapeHtml(catName)}</span>
                <span class="meta-tag">共 ${item.trackCount || '?'} 首</span>
                <span class="meta-tag" style="margin-left: 4px;">${item.savedAt || ''}</span>
                <button class="btn-card-del" onclick="event.stopPropagation(); removeFavPlaylist('${escapeHtml(item.id)}')" title="取消收藏">🗑️</button>
            </div>
        `;
        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            selectPlaylist(item.id, item.type || "playlist", item.name || item.title, item.curator, item.url);
        });
        playlistListEl.appendChild(card);
    });
}

// 取消收藏歌单
function removeFavPlaylist(id) {
    if (!confirm("确定要取消收藏此歌单吗？")) return;
    let favs = getFavPlaylists();
    const target = favs.find(f => f.id === id);
    favs = favs.filter(f => f.id !== id);
    saveFavPlaylists(favs);
    updateFavButtonStatus();
    showToast(`已移除收藏歌单《${target ? target.name || target.title : ''}》`);
    loadFavPlaylists();
}

// 浏览“🎵 我的自建歌单”
function loadCustomPlaylists() {
    setActiveNav("btnNavCustom");
    mobileBackToList();
    listPanelTitle.innerText = "🎵 我的自建歌单";
    const customs = getCustomPlaylists();
    itemCountBadge.innerText = customs.length;
    statusText.innerText = `本地自建歌单共 ${customs.length} 个`;

    if (customs.length === 0) {
        if (categoryFilterBar) categoryFilterBar.style.display = "none";
        playlistListEl.innerHTML = `
            <div class="placeholder-box" style="padding: 40px 20px;">
                <p>暂无自建歌单</p>
                <p class="muted">在右侧曲目表中点击【➕ 加入歌单】，或点击抽屉中的【➕ 新建】创建自建歌单。</p>
                <button class="btn btn-sm btn-primary" onclick="promptCreateCustomPlaylist()" style="margin-top: 12px;">➕ 立即新建歌单</button>
            </div>
        `;
        return;
    }

    renderCategoryFilterBar('custom', customs);

    const filteredCustoms = currentCustomCategory === "全部" 
        ? customs 
        : customs.filter(c => (c.category || "默认") === currentCustomCategory);

    playlistListEl.innerHTML = "";
    if (filteredCustoms.length === 0) {
        playlistListEl.innerHTML = `
            <div class="placeholder-box" style="padding: 30px 16px;">
                <p>分类【${escapeHtml(currentCustomCategory)}】下暂无自建歌单</p>
                <button class="btn btn-sm btn-outline" onclick="currentCustomCategory='全部'; loadCustomPlaylists();" style="margin-top: 10px;">查看全部分类</button>
            </div>
        `;
        return;
    }

    filteredCustoms.forEach((pl) => {
        const card = document.createElement("div");
        card.className = "playlist-card";
        const trackCount = (pl.tracks || []).length;
        const catName = pl.category || "默认";
        card.innerHTML = `
            <div class="playlist-title-row">
                <span class="playlist-name">${escapeHtml(pl.title)}</span>
                <span class="playlist-curator">自建歌单</span>
            </div>
            <div class="playlist-meta-row">
                <span class="cat-badge" onclick="event.stopPropagation(); promptChangeCategory('custom', '${escapeHtml(pl.id)}')" title="点击修改分类">🏷️ ${escapeHtml(catName)}</span>
                <span class="meta-tag">共 ${trackCount} 首</span>
                <span class="meta-tag" style="margin-left: 4px;">${pl.createdAt || ''}</span>
                <button class="btn-card-del" onclick="event.stopPropagation(); deleteCustomPlaylist('${escapeHtml(pl.id)}')" title="删除歌单">🗑️</button>
            </div>
        `;
        card.addEventListener("click", () => {
            document.querySelectorAll(".playlist-card").forEach(c => c.classList.remove("active"));
            card.classList.add("active");
            selectCustomPlaylist(pl.id);
        });
        playlistListEl.appendChild(card);
    });
}

// 选中并展示自建歌单
function selectCustomPlaylist(playlistId) {
    const customs = getCustomPlaylists();
    const pl = customs.find(c => c.id === playlistId);
    if (!pl) return;

    isViewingCustomPlaylist = true;
    currentCustomPlaylistId = playlistId;
    currentPlaylistData = { id: pl.id, name: pl.title, title: pl.title, curator: "我的自建歌单" };
    currentTracks = pl.tracks || [];

    mobileShowDetail();

    detailTitle.innerText = pl.title;
    detailSubtitle.innerText = `我的自建歌单 • 共 ${currentTracks.length} 首歌曲`;
    updateFavButtonStatus();
    detailActions.style.display = "flex";

    renderTracklist(currentTracks);
}

// 快速创建自建歌单
function promptCreateCustomPlaylist() {
    const name = prompt("请输入新歌单名称:", "我的精选歌单");
    if (!name || !name.trim()) return;
    const customs = getCustomPlaylists();
    const defaultCat = currentCustomCategory !== "全部" ? currentCustomCategory : "默认";
    const newPl = {
        id: "custom_" + Date.now(),
        title: name.trim(),
        category: defaultCat,
        createdAt: new Date().toLocaleDateString(),
        tracks: []
    };
    customs.unshift(newPl);
    saveCustomPlaylists(customs);
    showToast(`歌单《${newPl.title}》创建成功！`);
    loadCustomPlaylists();
}

// 删除自建歌单
function deleteCustomPlaylist(playlistId) {
    if (!confirm("确定要删除此自建歌单吗？")) return;
    let customs = getCustomPlaylists();
    const target = customs.find(c => c.id === playlistId);
    customs = customs.filter(c => c.id !== playlistId);
    saveCustomPlaylists(customs);
    showToast(`歌单《${target ? target.title : ''}》已删除`);
    loadCustomPlaylists();
    if (currentCustomPlaylistId === playlistId) {
        detailActions.style.display = "none";
        detailBody.innerHTML = '<div class="loading-state">歌单已删除。请在左侧选择其他歌单。</div>';
    }
}

// 从自建歌单中移除某首歌曲
function removeSongFromCustom(idx) {
    if (!isViewingCustomPlaylist || !currentCustomPlaylistId) return;
    let customs = getCustomPlaylists();
    const pl = customs.find(c => c.id === currentCustomPlaylistId);
    if (!pl) return;

    const removed = pl.tracks.splice(idx, 1)[0];
    saveCustomPlaylists(customs);
    currentTracks = pl.tracks;
    detailSubtitle.innerText = `我的自建歌单 • 共 ${currentTracks.length} 首歌曲`;
    renderTracklist(currentTracks);
    showToast(`已从歌单移除: ${removed?.name || '歌曲'}`);
}

// ========================================================
// 弹窗：将单曲添加到自建歌单 (不可加到官方收藏歌单)
// ========================================================
function openAddToPlaylistModal(trackIdx) {
    const song = currentTracks[trackIdx];
    if (!song) return;
    pendingTrackToAdd = song;

    const modal = document.getElementById("addToPlaylistModal");
    const infoEl = document.getElementById("addToSongInfo");
    const choiceList = document.getElementById("playlistChoiceList");
    const input = document.getElementById("newPlaylistInput");

    infoEl.innerText = `🎵 ${song.name} - ${song.artist}`;
    input.value = "";

    const customs = getCustomPlaylists();
    if (customs.length === 0) {
        choiceList.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 12px;">暂无自建歌单，请在下方直接输入名称新建并加入</div>';
    } else {
        let html = '';
        customs.forEach(pl => {
            const hasSong = (pl.tracks || []).some(t => t.name === song.name && t.artist === song.artist);
            html += `
                <div class="playlist-choice-item" onclick="addTrackToExistingPlaylist('${pl.id}')">
                    <div>
                        <strong>${escapeHtml(pl.title)}</strong>
                        <span style="font-size: 11px; color: var(--text-muted); margin-left: 8px;">(${pl.tracks?.length || 0}首)</span>
                    </div>
                    <span style="font-size: 12px; color: ${hasSong ? '#e3b341' : 'var(--accent)'};">
                        ${hasSong ? '已在歌单' : '➕ 加入'}
                    </span>
                </div>
            `;
        });
        choiceList.innerHTML = html;
    }

    modal.classList.add("open");
}

function closeAddToPlaylistModal() {
    document.getElementById("addToPlaylistModal").classList.remove("open");
    pendingTrackToAdd = null;
}

function addTrackToExistingPlaylist(playlistId) {
    if (!pendingTrackToAdd) return;
    let customs = getCustomPlaylists();
    const pl = customs.find(c => c.id === playlistId);
    if (!pl) return;

    if (!pl.tracks) pl.tracks = [];
    const already = pl.tracks.some(t => t.name === pendingTrackToAdd.name && t.artist === pendingTrackToAdd.artist);
    if (already) {
        showToast(`《${pendingTrackToAdd.name}》已存在于《${pl.title}》中`);
        closeAddToPlaylistModal();
        return;
    }

    pl.tracks.push({
        index: pl.tracks.length + 1,
        name: pendingTrackToAdd.name,
        title: pendingTrackToAdd.name,
        artist: pendingTrackToAdd.artist,
        album: pendingTrackToAdd.album || "",
        durationMillis: pendingTrackToAdd.durationMillis || 0
    });

    saveCustomPlaylists(customs);
    showToast(`已成功将《${pendingTrackToAdd.name}》加入《${pl.title}》！`);
    closeAddToPlaylistModal();

    // 如果当前正处于该自建歌单详情页，实时刷新
    if (isViewingCustomPlaylist && currentCustomPlaylistId === playlistId) {
        selectCustomPlaylist(playlistId);
    }
}

function confirmCreateAndAdd() {
    const input = document.getElementById("newPlaylistInput");
    const name = input.value.trim();
    if (!name) {
        showToast("请输入歌单名称");
        return;
    }
    if (!pendingTrackToAdd) return;

    let customs = getCustomPlaylists();
    const newPl = {
        id: "custom_" + Date.now(),
        title: name,
        createdAt: new Date().toLocaleDateString(),
        tracks: [{
            index: 1,
            name: pendingTrackToAdd.name,
            title: pendingTrackToAdd.name,
            artist: pendingTrackToAdd.artist,
            album: pendingTrackToAdd.album || "",
            durationMillis: pendingTrackToAdd.durationMillis || 0
        }]
    };

    customs.unshift(newPl);
    saveCustomPlaylists(customs);
    showToast(`已新建歌单《${name}》并加入歌曲！`);
    closeAddToPlaylistModal();

    if (document.getElementById("btnNavCustom")?.classList.contains("active")) {
        loadCustomPlaylists();
    }
}

function handleNewPlaylistKeyDown(e) {
    if (e.key === "Enter") {
        confirmCreateAndAdd();
    }
}

// 渲染曲目表格 (包含 ▶ 播放、➕ 加入歌单、复制 与 移除)
function renderTracklist(tracks) {
    if (!tracks || tracks.length === 0) {
        detailBody.innerHTML = '<div class="loading-state">该歌单暂无曲目。</div>';
        return;
    }

    const curPlayingSong = window.player && window.player.playlist[window.player.currentIndex];

    let html = `
        <table class="track-table">
            <thead>
                <tr>
                    <th class="track-index">#</th>
                    <th>歌曲名称</th>
                    <th>歌手</th>
                    <th class="track-duration">时长</th>
                    <th class="track-action">操作</th>
                </tr>
            </thead>
            <tbody>
    `;

    tracks.forEach((t, idx) => {
        const durationStr = formatDuration(t.durationMillis);
        const copyText = `${t.name} - ${t.artist}`;
        const isPlayingThis = curPlayingSong && (curPlayingSong.title === t.name || curPlayingSong.name === t.name) && (curPlayingSong.artist === t.artist);
        const rowClass = isPlayingThis ? 'track-row-playing' : '';

        html += `
            <tr class="${rowClass}" id="track-row-${idx}">
                <td class="track-index">${isPlayingThis ? '🔊' : (t.index || idx + 1)}</td>
                <td class="track-name">${escapeHtml(t.name)}</td>
                <td class="track-artist">${escapeHtml(t.artist)}</td>
                <td class="track-duration">${durationStr}</td>
                <td class="track-action">
                    <button class="btn-play-song" onclick="playSong(${idx})" title="立即播放此歌曲">▶</button>
                    <button class="btn-add-to-pl" onclick="openAddToPlaylistModal(${idx})" title="加入我的自建歌单">➕</button>
                    ${isViewingCustomPlaylist ? `<button class="btn-remove-song" onclick="removeSongFromCustom(${idx})" title="从歌单移除">✕</button>` : ''}
                </td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    detailBody.innerHTML = html;
}

// 播放当前展示歌单内的全部曲目
function playCurrentAll() {
    if (!currentTracks || currentTracks.length === 0) {
        showToast("当前歌单暂无可播放曲目");
        return;
    }
    if (window.player) {
        window.player.playTracklist(currentTracks, 0);
        showToast(`已开始播放当前歌单全部 ${currentTracks.length} 首歌曲`);
    }
}

// 点击单曲“播放”按钮
function playSong(idx) {
    if (!currentTracks || !currentTracks[idx]) return;
    if (window.player) {
        window.player.playTracklist(currentTracks, idx);
    }
}

// 复制整份歌单纯文本 (每行：歌名 - 歌手)
function copyTracklistText() {
    if (!currentTracks || currentTracks.length === 0) {
        showToast("暂无曲目可复制");
        return;
    }

    const lines = currentTracks.map(t => `${t.name} - ${t.artist}`);
    const text = lines.join("\n");
    
    navigator.clipboard.writeText(text).then(() => {
        showToast(`已成功复制 ${currentTracks.length} 首歌曲纯文本！`);
    }).catch(err => {
        fallbackCopy(text);
        showToast(`已复制 ${currentTracks.length} 首歌曲文本`);
    });
}

function copySongText(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(`已复制: ${text}`);
    }).catch(() => {
        fallbackCopy(text);
        showToast(`已复制: ${text}`);
    });
}

function fallbackCopy(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
}

function showToast(msg) {
    toastEl.innerText = msg;
    toastEl.classList.add("show");
    setTimeout(() => {
        toastEl.classList.remove("show");
    }, 2500);
}

function formatDuration(millis) {
    if (!millis) return "--:--";
    const totalSeconds = Math.floor(millis / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function escapeJsString(str) {
    if (!str) return "";
    return String(str)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

/* ========================================================
   音频播放控制器与 UI 联动引擎 (对接 music_underlying)
   ======================================================== */

// DOM 元素引用
const playerTitle = document.getElementById("playerTitle");
const playerArtist = document.getElementById("playerArtist");
const playerStatusIcon = document.getElementById("playerStatusIcon");
const btnPlayPause = document.getElementById("btnPlayPause");
const btnMode = document.getElementById("btnMode");
const playerCurTime = document.getElementById("playerCurTime");
const playerTotalTime = document.getElementById("playerTotalTime");
const progressBarFill = document.getElementById("progressBarFill");
const volumeSlider = document.getElementById("volumeSlider");
const volumeIcon = document.getElementById("volumeIcon");
const queueCountEl = document.getElementById("queueCount");
const queueListBody = document.getElementById("queueListBody");
const sourcesListBody = document.getElementById("sourcesListBody");

// 独立歌词栏元素
const lyricDock = document.getElementById("lyricDock");
const lyricCurrentLine = document.getElementById("lyricCurrentLine");
const lyricNextLine = document.getElementById("lyricNextLine");
const lyricLinesWrapper = document.getElementById("lyricLinesWrapper");

let isLyricExpanded = false;
let lastLyricIdx = -1;
let currentSongLyricLines = [];

// 初始化全局 Player 实例
window.player = new MusicPlayer();

// 字节大小格式化
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return "";
    if (bytes >= 1048576) {
        return (bytes / 1048576).toFixed(1) + " MB";
    }
    return (bytes / 1024).toFixed(0) + " KB";
}

// 绑定播放器事件
window.player.on('trackChange', ({ index, song }) => {
    const title = song.title || song.name || "未知歌曲";
    const artist = song.artist || "未知歌手";
    const album = song.album || "";

    // 第1行显示歌手与歌曲名，第2行显示歌曲信息（专辑或精选信息，不显示底层音源）
    playerTitle.innerText = `${artist} - ${title}`;
    playerArtist.innerText = album ? `专辑: ${album}` : "Apple Music 精选曲目";

    playerStatusIcon.innerText = "⏳";
    playerStatusIcon.classList.remove("playing");
    renderQueueList();

    // 重新高亮当前查看歌单中的曲目
    if (currentTracks && currentTracks.length > 0) {
        renderTracklist(currentTracks);
    }
});

window.player.on('stateChange', ({ isPlaying, isResolving, song, sourceName, costMs, bytes, error }) => {
    btnPlayPause.innerText = isPlaying ? "⏸" : "▶";

    if (isResolving) {
        playerStatusIcon.innerText = "⏳";
        playerStatusIcon.classList.remove("playing");
    } else if (isPlaying) {
        playerStatusIcon.innerText = "🎵";
        playerStatusIcon.classList.add("playing");
    } else {
        playerStatusIcon.innerText = "⏸";
        playerStatusIcon.classList.remove("playing");
    }

    if (error) {
        showToast(`播放受阻: ${error}`);
    }
});

window.player.on('timeUpdate', ({ currentTime, duration, percent, formattedCurrent, formattedDuration }) => {
    playerCurTime.innerText = formattedCurrent;
    playerTotalTime.innerText = formattedDuration;
    progressBarFill.style.width = `${percent}%`;
});

// 毫秒级歌词联动
window.player.on('lyricUpdate', ({ index, currentLine, nextLine, allLines }) => {
    lastLyricIdx = index;
    currentSongLyricLines = allLines || [];
    renderLyricsView(currentLine, nextLine);
});

// 歌词视图渲染 (平时 2 行 ⇄ 展开 6 行)
function renderLyricsView(curText, nxtText) {
    if (!isLyricExpanded) {
        // 常驻紧凑 2 行模式
        lyricLinesWrapper.innerHTML = `
            <div class="lyric-line lyric-line-current" id="lyricCurrentLine">${escapeHtml(curText || "♪ 音乐播放中...")}</div>
            <div class="lyric-line lyric-line-next" id="lyricNextLine">${escapeHtml(nxtText || "")}</div>
        `;
    } else {
        // 展开 6 行沉浸模式
        if (!currentSongLyricLines || currentSongLyricLines.length === 0) {
            lyricLinesWrapper.innerHTML = '<div class="lyric-line lyric-line-current">纯音乐或暂无歌词</div>';
            return;
        }

        const cur = lastLyricIdx >= 0 ? lastLyricIdx : 0;
        // 计算前后 6 行窗口: 包含前 2 句、当前句、后 3 句
        const start = Math.max(0, cur - 2);
        const end = Math.min(currentSongLyricLines.length, start + 6);
        const windowLines = currentSongLyricLines.slice(start, end);

        let html = '';
        windowLines.forEach((item, wIdx) => {
            const actualIdx = start + wIdx;
            let cls = 'lyric-line';
            if (actualIdx === cur) {
                cls += ' lyric-line-current';
            } else if (actualIdx < cur) {
                cls += ' lyric-line-prev';
            } else {
                cls += ' lyric-line-next';
            }
            html += `<div class="${cls}">${escapeHtml(item.text)}</div>`;
        });
        lyricLinesWrapper.innerHTML = html;
    }
}

// 展开歌词栏 (拉升显示 6 行)
function expandLyricDock(e) {
    if (isLyricExpanded) return;
    isLyricExpanded = true;
    lyricDock.classList.add("expanded");
    lyricDock.title = "";
    const curLine = (lastLyricIdx >= 0 && currentSongLyricLines[lastLyricIdx]) ? currentSongLyricLines[lastLyricIdx].text : "";
    const nextLine = (lastLyricIdx + 1 < currentSongLyricLines.length) ? currentSongLyricLines[lastLyricIdx + 1].text : "";
    renderLyricsView(curLine, nextLine);
}

// 收回歌词栏 (缩回 2 行)
function collapseLyricDock(e) {
    if (e) e.stopPropagation();
    isLyricExpanded = false;
    lyricDock.classList.remove("expanded");
    lyricDock.title = "点击展开 6 行完整歌词";
    const curLine = (lastLyricIdx >= 0 && currentSongLyricLines[lastLyricIdx]) ? currentSongLyricLines[lastLyricIdx].text : "";
    const nextLine = (lastLyricIdx + 1 < currentSongLyricLines.length) ? currentSongLyricLines[lastLyricIdx + 1].text : "";
    renderLyricsView(curLine, nextLine);
}

window.player.on('playlistChange', ({ playlist }) => {
    queueCountEl.innerText = playlist.length;
    renderQueueList();
});

// 模式切换处理
function handleCycleMode() {
    if (!window.player) return;
    const mode = window.player.cycleMode();
    const info = window.player.getModeLabel();
    btnMode.innerText = info.icon;
    btnMode.title = `播放模式: ${info.label}`;
    showToast(`模式切换: ${info.label}`);
}

// 进度条拖拽/点击
function handleProgressBarClick(e) {
    if (!window.player) return;
    const bar = document.getElementById("progressBarBg");
    const rect = bar.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;
    const pct = Math.max(0, Math.min(1, clickX / width));
    window.player.seek(pct);
}

// 音量控制
let lastNonZeroVolume = 0.8;
function handleVolumeChange(val) {
    const v = val / 100;
    if (window.player) {
        window.player.setVolume(v);
    }
    if (v > 0) lastNonZeroVolume = v;
    updateVolumeIcon(v);
}

function toggleMute() {
    if (!window.player) return;
    const curVol = window.player.getVolume();
    if (curVol > 0) {
        lastNonZeroVolume = curVol;
        window.player.setVolume(0);
        volumeSlider.value = 0;
        updateVolumeIcon(0);
    } else {
        const target = lastNonZeroVolume || 0.8;
        window.player.setVolume(target);
        volumeSlider.value = Math.round(target * 100);
        updateVolumeIcon(target);
    }
}

function updateVolumeIcon(v) {
    if (v === 0) volumeIcon.innerText = "🔇";
    else if (v < 0.5) volumeIcon.innerText = "🔉";
    else volumeIcon.innerText = "🔊";
}

// 播放队列抽屉 (从底部向上平滑拉起)
function toggleQueueModal() {
    const drawer = document.getElementById("queueDrawer");
    if (!drawer) return;
    const isOpen = drawer.classList.toggle("open");
    const btn = document.getElementById("btnQueueModal");
    btn?.classList.toggle("btn-nav-active", isOpen);
    const backdrop = document.getElementById("drawerBackdrop");
    if (isOpen) {
        // 关闭音源抽屉避免遮挡
        const sDrawer = document.getElementById("sourceDrawer");
        if (sDrawer && sDrawer.classList.contains("open")) {
            sDrawer.classList.remove("open");
            document.getElementById("btnSourceModal")?.classList.remove("btn-nav-active");
        }
        backdrop?.classList.add("open");
        renderQueueList();
    } else {
        backdrop?.classList.remove("open");
    }
}

function renderQueueList() {
    if (!window.player) return;
    const list = window.player.playlist || [];
    const curIdx = window.player.currentIndex;

    if (list.length === 0) {
        queueListBody.innerHTML = '<div class="loading-state">当前播放队列为空</div>';
        return;
    }

    let html = '';
    list.forEach((item, idx) => {
        const isActive = idx === curIdx;
        const title = item.title || item.name || "未知歌曲";
        const artist = item.artist || "未知歌手";
        html += `
            <div class="queue-item ${isActive ? 'active' : ''}" onclick="window.player.playIndex(${idx})">
                <div>
                    <span style="font-family: var(--font-mono); margin-right: 8px; opacity: 0.7;">${idx + 1}.</span>
                    <strong>${escapeHtml(title)}</strong>
                    <span style="opacity: 0.7; font-size: 12px; margin-left: 8px;">${escapeHtml(artist)}</span>
                </div>
                <span>${isActive ? '🔊 播放中' : ''}</span>
            </div>
        `;
    });
    queueListBody.innerHTML = html;
}

// 音源管理抽屉 (从底部向上平滑拉起)
function toggleSourceModal() {
    const drawer = document.getElementById("sourceDrawer");
    if (!drawer) return;
    const isOpen = drawer.classList.toggle("open");
    const btn = document.getElementById("btnSourceModal");
    btn?.classList.toggle("btn-nav-active", isOpen);
    const backdrop = document.getElementById("drawerBackdrop");
    if (isOpen) {
        // 关闭队列抽屉避免遮挡
        const qDrawer = document.getElementById("queueDrawer");
        if (qDrawer && qDrawer.classList.contains("open")) {
            qDrawer.classList.remove("open");
            document.getElementById("btnQueueModal")?.classList.remove("btn-nav-active");
        }
        backdrop?.classList.add("open");
        loadSources();
    } else {
        backdrop?.classList.remove("open");
    }
}

async function loadSources() {
    sourcesListBody.innerHTML = '<div class="loading-state">正在获取底层音源队列...</div>';
    try {
        const res = await fetch("/api/sources");
        const list = await res.json();
        renderSourceList(list);
    } catch (err) {
        sourcesListBody.innerHTML = `<div class="loading-state">❌ 获取音源失败: ${err.message}</div>`;
    }
}

async function testSources() {
    const btn = document.getElementById("btnTestSources");
    btn.disabled = true;
    btn.innerText = "⏳ 测速中...";
    sourcesListBody.innerHTML = '<div class="loading-state">⚡ 正在并发就地测速所有 36+ 音源并重排队列...</div>';
    try {
        const res = await fetch("/api/sources/test", { method: "POST" });
        const list = await res.json();
        renderSourceList(list);
        showToast("音源测速完成，已按健康度重新排序！");
    } catch (err) {
        sourcesListBody.innerHTML = `<div class="loading-state">❌ 测速失败: ${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.innerText = "⚡ 测速重排";
    }
}

async function syncSources() {
    const btn = document.getElementById("btnSyncSources");
    btn.disabled = true;
    btn.innerText = "⏳ 同步中...";
    sourcesListBody.innerHTML = '<div class="loading-state">🔄 正在从 lx-hub 同步最新源并测速...</div>';
    try {
        const res = await fetch("/api/sources/sync", { method: "POST" });
        const list = await res.json();
        renderSourceList(list);
        showToast("已成功从 lx-hub 同步并重新排班！");
    } catch (err) {
        sourcesListBody.innerHTML = `<div class="loading-state">❌ 同步失败: ${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.innerText = "🔄 同步源库";
    }
}

function renderSourceList(list) {
    if (!list || list.length === 0) {
        sourcesListBody.innerHTML = '<div class="loading-state">暂无已注册音源</div>';
        return;
    }

    let html = '';
    list.forEach((s, idx) => {
        const isOk = s.status === "ok";
        const statusClass = isOk ? "source-status-ok" : "source-status-failed";
        const latencyText = isOk ? `${s.latency_ms} ms` : "离线/超时";
        html += `
            <div class="source-card">
                <div class="source-card-info">
                    <span style="font-family: var(--font-mono); color: var(--text-muted); width: 24px;">#${idx + 1}</span>
                    <div>
                        <div style="font-weight: 600; font-size: 13px;">${escapeHtml(s.name)}</div>
                        <div style="font-size: 11px; color: var(--text-muted);">
                            平台: ${s.platform.toUpperCase()} • 命中: ${s.success_count || 0} 次 • 连败: ${s.consecutive_fails || 0}
                        </div>
                    </div>
                </div>
                <div class="source-status-badge ${statusClass}">
                    ● ${isOk ? '可用' : '不可用'} (${latencyText})
                </div>
            </div>
        `;
    });
    sourcesListBody.innerHTML = html;
}

function closeModalOnOverlay(e, modalId) {
    if (e.target.id === modalId) {
        document.getElementById(modalId).classList.remove("open");
    }
}
