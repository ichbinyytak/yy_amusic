// Amusic - Apple Music 纯文本数据库浏览器核心逻辑
const APPLE_MUSIC_API = "/api/apple/v1/catalog";

// 提取自 Apple Music 官方 Web 播放器的公共只读访客 Token (有效期至 2027 年)
const DEFAULT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6IldlYlBsYXlLaWQifQ.eyJpc3MiOiJBTVBXZWJQbGF5IiwiaWF0IjoxNzkyNzgwNTM0LCJleHAiOjE3OTg4Mjg1MzQsInJvb3RfaHR0cHNfb3JpZ2luIjpbImFwcGxlLmNvbSJdfQ.wcf_7U-zcgUjY2L8d4HWFkdxP1YSJCkkqEpEtVPKpRARrlaag0DHyIpRcoUEWZU8kJlvx5Q7ZNp04OabfuiuAw";

let currentStorefront = "cn";
let currentPlaylistData = null;
let currentTracks = [];

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
const toastEl = document.getElementById("toast");

// 初始化
window.addEventListener("DOMContentLoaded", () => {
    storefrontSelect.addEventListener("change", (e) => {
        currentStorefront = e.target.value;
        const query = searchInput.value.trim();
        if (query) {
            handleSearch();
        } else {
            loadCharts();
        }
    });

    // 默认加载官方榜单
    loadCharts();
});

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

// 加载官方榜单歌单
async function loadCharts() {
    listPanelTitle.innerText = "官方精选 & 热门歌单";
    playlistListEl.innerHTML = '<div class="loading-state">正在拉取 Apple 官方榜单数据...</div>';
    itemCountBadge.innerText = "...";

    try {
        const data = await apiRequest("charts?types=playlists&limit=25");
        const playlists = data?.results?.playlists?.[0]?.data || [];
        renderPlaylistCards(playlists);
    } catch (err) {
        playlistListEl.innerHTML = `<div class="loading-state">❌ 获取榜单失败: ${err.message}</div>`;
        itemCountBadge.innerText = "0";
    }
}

// 搜索歌单与专辑
async function handleSearch() {
    const query = searchInput.value.trim();
    if (!query) {
        loadCharts();
        clearBtn.style.display = "none";
        return;
    }

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

function quickSearch(tag) {
    searchInput.value = tag;
    handleSearch();
}

function clearSearch() {
    searchInput.value = "";
    clearBtn.style.display = "none";
    loadCharts();
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
                <span class="playlist-name"><span style="color:var(--accent); font-weight:normal; font-size:12px;">${typeLabel}</span> ${escapeHtml(name)}</span>
                <span class="playlist-curator">${escapeHtml(curator)}</span>
            </div>
            <div class="playlist-desc">${escapeHtml(desc)}</div>
            <div class="playlist-meta-row">
                <span>${date ? '📅 ' + date : ''}</span>
                <button class="btn-mini-action" onclick="event.stopPropagation(); copyUrl('${url}')" title="直接复制该歌单链接">📋 复制链接</button>
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
    currentPlaylistData = { id, type, name, curator, url };
    currentTracks = [];

    detailTitle.innerText = name;
    detailSubtitle.innerText = `${curator} • 正在获取曲目清单...`;
    detailActions.style.display = "none";
    detailBody.innerHTML = '<div class="loading-state">正在向 Apple 数据库解析曲目列表...</div>';

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

// 渲染曲目表格
function renderTracklist(tracks) {
    if (!tracks || tracks.length === 0) {
        detailBody.innerHTML = '<div class="loading-state">该歌单暂无可公开查看的曲目。</div>';
        return;
    }

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

    tracks.forEach((t) => {
        const durationStr = formatDuration(t.durationMillis);
        const copyText = `${t.name} - ${t.artist}`;
        html += `
            <tr>
                <td class="track-index">${t.index}</td>
                <td class="track-name">${escapeHtml(t.name)}</td>
                <td class="track-artist">${escapeHtml(t.artist)}</td>
                <td class="track-duration">${durationStr}</td>
                <td class="track-action">
                    <button class="btn-copy-song" onclick="copySongText('${escapeJsString(copyText)}')" title="复制歌名与歌手">复制</button>
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

// 复制单个歌单官方直链
function copyPlaylistUrl() {
    if (currentPlaylistData?.url) {
        copyUrl(currentPlaylistData.url);
    }
}

// 复制整份歌单纯文本 (每行：歌名 - 歌手，可直接贴入播放器或做导入)
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

function copyUrl(url) {
    navigator.clipboard.writeText(url).then(() => {
        showToast("已复制 Apple Music 官方直链！可直接去 YY-music 导入");
    }).catch(() => {
        fallbackCopy(url);
        showToast("已复制链接！");
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
