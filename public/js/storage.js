/**
 * ========================================================
 * 模块：js/storage.js - 用户数据中枢与配置备份还原引擎 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.StorageManager
 * 依赖协同：无外部依赖（浏览器原生 localStorage / CustomEvent），为全站所有模块提供数据中枢支撑
 * --------------------------------------------------------
 * 功能目录：
 *   1. 基础持久化驱动 (安全读写 localStorage，变更广播 amusic-storage-changed)
 *   2. 自建歌单管理 (自建歌单 CRUD、歌曲增删去重、分组归类与改名删除)
 *   3. 收藏官方歌单管理 (官方歌单收藏/取消、分组流动、引导收藏流)
 *   4. 用户历史记忆与偏好 (最后播放歌单状态持久化与恢复)
 *   5. 一键导出备份与导入恢复 (全量 JSON 数据导出、严格格式校验、版本迁移与导入合并)
 * ========================================================
 */

window.StorageManager = (function () {
    'use strict';

    const KEY_CUSTOM = "amusic_custom_playlists";
    const KEY_FAV = "amusic_fav_playlists";
    const KEY_LAST = "amusic_last_playlist";
    const KEY_VOLUME = "amusic_volume";
    const KEY_STOREFRONT = "amusic_storefront";
    const KEY_CAT_CUSTOM = "amusic_categories_custom";
    const KEY_CAT_FAV = "amusic_categories_fav";

    /* ========================================================
     * 区块 1: 基础持久化读写与全站事件广播
     * ======================================================== */

    // 辅助安全读取 JSON
    function getJson(key, defaultVal = []) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : defaultVal;
        } catch (e) {
            console.warn(`[StorageManager] 读取 ${key} 失败:`, e);
            return defaultVal;
        }
    }

    // 辅助安全写入 JSON 并广播变更事件 (支持 silent: true 静默写入)
    function setJson(key, val, eventType = "update", options = {}) {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            if (!options?.silent) {
                window.dispatchEvent(new CustomEvent("amusic-storage-changed", {
                    detail: { key, eventType, data: val }
                }));
                window.EventBus?.emit?.("storageChanged", { key, eventType, data: val });
            }
            return true;
        } catch (e) {
            console.error(`[StorageManager] 写入 ${key} 失败:`, e);
            return false;
        }
    }

    /* ========================================================
     * 区块 2: 自建歌单管理 (CRUD、歌曲收录、分组流动)
     * ======================================================== */

    function getCustomPlaylists() {
        return getJson(KEY_CUSTOM, []);
    }

    function saveCustomPlaylists(list) {
        return setJson(KEY_CUSTOM, list, "custom_playlists");
    }

    const normalizeCategory = (cat) => window.AmusicUtils.normalizeCategory(cat);

    function createCustomPlaylist(title, category = "未分组") {
        if (!title || !title.trim()) return null;
        const list = getCustomPlaylists();
        const trimmed = title.trim();
        let existing = list.find(p => p.title === trimmed);
        if (existing) return existing;

        const newPl = {
            id: `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            title: trimmed,
            category: normalizeCategory(category),
            createdAt: Date.now(),
            tracks: []
        };
        list.unshift(newPl);
        saveCustomPlaylists(list);
        return newPl;
    }

    function deleteCustomPlaylist(id) {
        let list = getCustomPlaylists();
        const initialLen = list.length;
        list = list.filter(p => p.id !== id);
        if (list.length !== initialLen) {
            saveCustomPlaylists(list);
            return true;
        }
        return false;
    }

    function renameCustomPlaylist(id, newTitle) {
        if (!newTitle || !newTitle.trim()) return false;
        const list = getCustomPlaylists();
        const pl = list.find(p => p.id === id);
        if (pl) {
            pl.title = newTitle.trim();
            saveCustomPlaylists(list);
            return true;
        }
        return false;
    }

    function addTrackToCustomPlaylist(playlistId, track) {
        if (!playlistId || !track) return false;
        const list = getCustomPlaylists();
        const pl = list.find(p => p.id === playlistId);
        if (!pl) return false;

        if (!Array.isArray(pl.tracks)) pl.tracks = [];
        // 避免同一歌单内重复加入同名同歌手或同平台同ID的曲目
        const trackPlat = track.platform || "";
        const isDuplicate = pl.tracks.some(t =>
            (t.name === track.name && t.artist === track.artist && (t.platform || "") === trackPlat) ||
            (track.id && t.id && String(t.id) === String(track.id) && (t.platform || "") === trackPlat)
        );
        if (isDuplicate) {
            return { ok: false, duplicate: true };
        }

        pl.tracks.push({
            index: pl.tracks.length + 1,
            name: track.name || track.title || "未知曲目",
            artist: track.artist || "未知歌手",
            album: track.album || (trackPlat === "streetvoice" ? "" : pl.title),
            durationMillis: track.durationMillis || (track.duration ? track.duration * 1000 : 0),
            id: track.id || "",
            platform: trackPlat,
            cover: track.cover || track.artwork || "",
            url: track.url || ""
        });

        saveCustomPlaylists(list);
        return { ok: true, playlist: pl };
    }

    /**
     * 从自建歌单中移除曲目
     * @param {string} playlistId 歌单ID
     * @param {number|number[]|string|object} trackTarget 单个索引、索引数组、歌名或歌曲对象
     * @param {string} [artist] 歌手名（可选，配合歌名匹配）
     */
    function removeTrackFromCustomPlaylist(playlistId, trackTarget, artist) {
        const list = getCustomPlaylists();
        const pl = list.find(p => p.id === playlistId);
        if (!pl || !Array.isArray(pl.tracks)) return false;

        // 1. 单个数字索引
        if (typeof trackTarget === 'number' && trackTarget >= 0 && trackTarget < pl.tracks.length) {
            pl.tracks.splice(trackTarget, 1);
            pl.tracks.forEach((t, idx) => { t.index = idx + 1; });
            saveCustomPlaylists(list);
            return true;
        }

        // 2. 批量数字索引数组
        if (Array.isArray(trackTarget)) {
            const indexSet = new Set(trackTarget.filter(i => typeof i === 'number' && i >= 0 && i < pl.tracks.length));
            if (indexSet.size === 0) return false;
            pl.tracks = pl.tracks.filter((_, idx) => !indexSet.has(idx));
            pl.tracks.forEach((t, idx) => { t.index = idx + 1; });
            saveCustomPlaylists(list);
            return true;
        }

        // 3. 兼容歌名/歌手匹配
        let targetName = "";
        let targetArtist = "";
        if (typeof trackTarget === 'string') {
            targetName = trackTarget.trim().toLowerCase();
            targetArtist = (artist || "").trim().toLowerCase();
        } else if (trackTarget && typeof trackTarget === 'object') {
            targetName = (trackTarget.name || "").trim().toLowerCase();
            targetArtist = (trackTarget.artist || "").trim().toLowerCase();
        }

        if (targetName) {
            const idx = pl.tracks.findIndex(t => {
                const n = (t.name || "").trim().toLowerCase();
                const a = (t.artist || "").trim().toLowerCase();
                if (targetArtist) {
                    return n === targetName && (a === targetArtist || a.includes(targetArtist) || targetArtist.includes(a));
                }
                return n === targetName;
            });
            if (idx !== -1) {
                pl.tracks.splice(idx, 1);
                pl.tracks.forEach((t, i) => { t.index = i + 1; });
                saveCustomPlaylists(list);
                return true;
            }
        }

        return false;
    }

    function changePlaylistCategory(kind, id, newCategory) {
        const cat = normalizeCategory(newCategory);
        if (kind === 'fav') {
            const list = getFavPlaylists();
            const item = list.find(f => f.id === id);
            if (item) { item.category = cat; saveFavPlaylists(list); return true; }
        } else {
            const list = getCustomPlaylists();
            const item = list.find(c => c.id === id);
            if (item) { item.category = cat; saveCustomPlaylists(list); return true; }
        }
        return false;
    }

    function getRegisteredCategories(kind) {
        const key = kind === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
        const saved = getJson(key, []);
        const set = new Set();
        set.add("未分组");
        if (Array.isArray(saved)) {
            saved.forEach(c => {
                const norm = normalizeCategory(c);
                if (norm !== "未分组") {
                    set.add(norm);
                }
            });
        }
        // 自动合并对应歌单中已存在的非空分类
        const plList = kind === 'fav' ? getFavPlaylists() : getCustomPlaylists();
        plList.forEach(p => {
            const cat = normalizeCategory(p.category);
            if (cat !== "未分组") {
                set.add(cat);
            }
        });
        return Array.from(set);
    }

    function getAllCategories() {
        const set = new Set();
        set.add("未分组");
        getRegisteredCategories('custom').forEach(c => set.add(c));
        getRegisteredCategories('fav').forEach(c => set.add(c));
        return Array.from(set);
    }

    function addCategory(kind, name) {
        if (!name || typeof name !== 'string' || !name.trim()) return false;
        const trimmed = name.trim();
        if (trimmed === "未分类" || trimmed === "默认" || trimmed === "未分组") return false;
        const targets = (!kind || kind === 'all') ? ['custom', 'fav'] : [kind];
        targets.forEach(k => {
            const key = k === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
            const saved = getJson(key, []);
            if (!saved.includes(trimmed)) {
                saved.push(trimmed);
                setJson(key, saved);
            }
        });
        return true;
    }

    function renameCategory(kind, oldCat, newCat) {
        if (oldCat === "未分组") {
            return { ok: false, error: "【未分组】不可重命名" };
        }
        if (!newCat || !newCat.trim()) return { ok: false, error: "新分类名不能为空" };
        const targetCat = newCat.trim();
        if (targetCat === "未分组") return { ok: false, error: "不能命名为未分组" };
        if (oldCat === targetCat) return { ok: true };

        const targets = (!kind || kind === 'all') ? ['custom', 'fav'] : [kind];
        targets.forEach(k => {
            const key = k === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
            let cats = getJson(key, []);
            if (!Array.isArray(cats)) cats = [];

            const idx = cats.indexOf(oldCat);
            if (idx !== -1) {
                cats[idx] = targetCat;
            } else if (!cats.includes(targetCat)) {
                cats.push(targetCat);
            }
            setJson(key, cats.filter(c => c !== "未分组"));
        });

        // 同步更新所有关联歌单的 category
        const fList = getFavPlaylists();
        fList.forEach(f => {
            if (normalizeCategory(f.category) === oldCat) f.category = targetCat;
        });
        saveFavPlaylists(fList);

        const cList = getCustomPlaylists();
        cList.forEach(c => {
            if (normalizeCategory(c.category) === oldCat) c.category = targetCat;
        });
        saveCustomPlaylists(cList);

        return { ok: true };
    }

    function deleteCategory(kind, catName) {
        if (!catName || catName === "未分组") {
            return { ok: false, error: "【未分组】为根分类，不能删除" };
        }

        // 默认只能删除空组；若分组内部包含任何歌单或专辑，绝对禁止删除
        const plList = [...getFavPlaylists(), ...getCustomPlaylists()];
        const hasItems = plList.some(p => normalizeCategory(p.category) === catName);
        if (hasItems) {
            return { ok: false, error: "该组内包含歌单，无法删除" };
        }

        const targets = (!kind || kind === 'all') ? ['custom', 'fav'] : [kind];
        targets.forEach(k => {
            const key = k === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
            let cats = getJson(key, []);
            if (Array.isArray(cats)) {
                cats = cats.filter(c => c !== catName);
                setJson(key, cats);
            }
        });
        return { ok: true };
    }

    /* ========================================================
     * 区块 3: 收藏官方歌单管理 (收藏状态、分组归类、流动)
     * ======================================================== */

    function getFavPlaylists() {
        return getJson(KEY_FAV, []);
    }

    function saveFavPlaylists(list) {
        return setJson(KEY_FAV, list, "fav_playlists");
    }

    function isPlaylistFaved(id) {
        if (!id) return false;
        const favs = getFavPlaylists();
        return favs.some(f => f.id === id);
    }

    function favPlaylistWithCategory(playlistData, category = "未分组") {
        if (!playlistData || !playlistData.id) return false;
        const favs = getFavPlaylists();
        const cat = normalizeCategory(category);
        const idx = favs.findIndex(f => f.id === playlistData.id);

        if (idx >= 0) {
            favs[idx].category = cat;
            if (playlistData.name) favs[idx].name = playlistData.name;
            if (playlistData.title) favs[idx].title = playlistData.title;
            if (playlistData.trackCount !== undefined) favs[idx].trackCount = playlistData.trackCount;
            if (playlistData.platform) favs[idx].platform = playlistData.platform;
            if (playlistData.svType) favs[idx].svType = playlistData.svType;
            if (playlistData.svId) favs[idx].svId = playlistData.svId;
            if (playlistData.svKind) favs[idx].svKind = playlistData.svKind;
            if (playlistData.svCategory) favs[idx].svCategory = playlistData.svCategory;
            saveFavPlaylists(favs);
            return { action: 'updated', category: cat };
        } else {
            favs.unshift({
                id: playlistData.id,
                type: playlistData.type || 'playlist',
                platform: playlistData.platform || '',
                svType: playlistData.svType || '',
                svId: playlistData.svId || '',
                svKind: playlistData.svKind || '',
                svCategory: playlistData.svCategory || '',
                title: playlistData.name || playlistData.title || '精选歌单',
                name: playlistData.name || playlistData.title || '精选歌单',
                curator: playlistData.curator || 'Apple Music',
                url: playlistData.url || '',
                trackCount: playlistData.trackCount || 0,
                category: cat,
                favAt: Date.now()
            });
            saveFavPlaylists(favs);
            return { action: 'added', category: cat };
        }
    }

    function unfavPlaylist(id) {
        if (!id) return false;
        const favs = getFavPlaylists();
        const idx = favs.findIndex(f => f.id === id);
        if (idx >= 0) {
            favs.splice(idx, 1);
            saveFavPlaylists(favs);
            return true;
        }
        return false;
    }

    function toggleFavPlaylist(playlistData, targetCategory = "未分组") {
        if (!playlistData || !playlistData.id) return false;
        const favs = getFavPlaylists();
        const idx = favs.findIndex(f => f.id === playlistData.id);

        if (idx >= 0) {
            favs.splice(idx, 1);
            saveFavPlaylists(favs);
            return false; // 取消收藏
        } else {
            return favPlaylistWithCategory(playlistData, targetCategory);
        }
    }

    function renameFavPlaylist(id, newName) {
        if (!newName || !newName.trim()) return false;
        const list = getFavPlaylists();
        const item = list.find(f => f.id === id);
        if (item) {
            item.name = newName.trim();
            item.title = newName.trim();
            saveFavPlaylists(list);
            return true;
        }
        return false;
    }

    /* ========================================================
     * 区块 4: 用户历史记忆与播放偏好持久化
     * ======================================================== */

    function getLastPlaylist() {
        return getJson(KEY_LAST, null);
    }

    function setLastPlaylist(data) {
        if (!data) {
            localStorage.removeItem(KEY_LAST);
            return;
        }
        try {
            localStorage.setItem(KEY_LAST, JSON.stringify(data));
        } catch (e) {}
    }

    /* ========================================================
     * 区块 5: 一键导出备份与导入恢复 (JSON 引擎)
     * ======================================================== */

    /**
     * 导出完整备份数据为 JSON 字符串
     * @returns {string} 格式化后的 JSON 字符串
     */
    function exportBackup() {
        const customs = getCustomPlaylists();
        const favs = getFavPlaylists();
        const lastPl = getLastPlaylist();
        const volume = localStorage.getItem(KEY_VOLUME) || "0.8";
        const storefront = localStorage.getItem(KEY_STOREFRONT) || "cn";

        const backupData = {
            version: "1.0",
            appName: "YY-Amusic",
            exportedAt: new Date().toISOString(),
            stats: {
                customPlaylistsCount: customs.length,
                favPlaylistsCount: favs.length,
                totalCustomTracks: customs.reduce((acc, cur) => acc + (cur.tracks ? cur.tracks.length : 0), 0)
            },
            data: {
                customPlaylists: customs,
                favPlaylists: favs,
                categoriesCustom: getJson(KEY_CAT_CUSTOM, []),
                categoriesFav: getJson(KEY_CAT_FAV, []),
                lastPlaylist: lastPl,
                volume: volume,
                storefront: storefront
            }
        };

        return JSON.stringify(backupData, null, 2);
    }

    /**
     * 从 JSON 文本解析并恢复用户备份
     */
    function importBackup(jsonStr) {
        if (!jsonStr || typeof jsonStr !== 'string') {
            return { ok: false, error: "备份文件内容为空" };
        }

        try {
            const parsed = JSON.parse(jsonStr);
            const data = parsed.data || parsed; // 兼容直接导出的字典或包裹结构

            const newCustoms = Array.isArray(data.customPlaylists) ? data.customPlaylists : [];
            const newFavs = Array.isArray(data.favPlaylists) ? data.favPlaylists : [];

            // 智能合并或覆盖（静默写入，统一由下方 restore 事件广播一次）
            setJson(KEY_CUSTOM, newCustoms, "custom_playlists", { silent: true });
            setJson(KEY_FAV, newFavs, "fav_playlists", { silent: true });

            if (Array.isArray(data.categoriesCustom)) {
                setJson(KEY_CAT_CUSTOM, data.categoriesCustom, "update", { silent: true });
            }
            if (Array.isArray(data.categoriesFav)) {
                setJson(KEY_CAT_FAV, data.categoriesFav, "update", { silent: true });
            }

            if (data.lastPlaylist) setLastPlaylist(data.lastPlaylist);
            if (data.volume !== undefined) localStorage.setItem(KEY_VOLUME, data.volume.toString());
            if (data.storefront) localStorage.setItem(KEY_STOREFRONT, data.storefront);

            window.dispatchEvent(new CustomEvent("amusic-storage-changed", {
                detail: { key: "all", eventType: "restore" }
            }));
            window.EventBus?.emit?.("storageChanged", { key: "all", eventType: "restore" });

            return {
                ok: true,
                customCount: newCustoms.length,
                favCount: newFavs.length,
                tracksCount: newCustoms.reduce((acc, cur) => acc + (cur.tracks ? cur.tracks.length : 0), 0)
            };
        } catch (e) {
            console.error("[StorageManager] 导入备份解析异常:", e);
            return { ok: false, error: "备份文件解析失败，请确认是否为有效的 JSON 格式" };
        }
    }

    function getCloudLibraryPayload() {
        return {
            customPlaylists: getCustomPlaylists(),
            favPlaylists: getFavPlaylists(),
            categoriesCustom: getJson(KEY_CAT_CUSTOM, []),
            categoriesFav: getJson(KEY_CAT_FAV, [])
        };
    }

    function applyCloudLibrary(data) {
        const payload = (data && typeof data === 'object') ? data : {};
        const customs = Array.isArray(payload.customPlaylists) ? payload.customPlaylists : [];
        const favs = Array.isArray(payload.favPlaylists) ? payload.favPlaylists : [];
        const catsCustom = Array.isArray(payload.categoriesCustom) ? payload.categoriesCustom : [];
        const catsFav = Array.isArray(payload.categoriesFav) ? payload.categoriesFav : [];

        setJson(KEY_CUSTOM, customs, "custom_playlists", { silent: true });
        setJson(KEY_FAV, favs, "fav_playlists", { silent: true });
        setJson(KEY_CAT_CUSTOM, catsCustom, "update", { silent: true });
        setJson(KEY_CAT_FAV, catsFav, "update", { silent: true });

        window.LibraryPanel?.renderLibrary?.();
        return getCloudLibraryPayload();
    }

    function clearUserLibrary() {
        try {
            localStorage.removeItem(KEY_CUSTOM);
            localStorage.removeItem(KEY_FAV);
            localStorage.removeItem(KEY_CAT_CUSTOM);
            localStorage.removeItem(KEY_CAT_FAV);
            localStorage.removeItem(KEY_LAST);
        } catch (e) {}
        try {
            sessionStorage.removeItem("amusic_resolve_cache_v1");
        } catch (e) {}
        window.LibraryPanel?.renderLibrary?.();
    }

    return {
        // 自建歌单
        getCustomPlaylists,
        saveCustomPlaylists,
        createCustomPlaylist,
        deleteCustomPlaylist,
        renameCustomPlaylist,
        addTrackToCustomPlaylist,
        removeTrackFromCustomPlaylist,
        changePlaylistCategory,
        // 分类管理
        getRegisteredCategories,
        getAllCategories,
        addCategory,
        renameCategory,
        deleteCategory,

        // 收藏歌单
        getFavPlaylists,
        saveFavPlaylists,
        renameFavPlaylist,
        isPlaylistFaved,
        toggleFavPlaylist,
        favPlaylistWithCategory,
        unfavPlaylist,

        // 历史记忆
        getLastPlaylist,
        setLastPlaylist,

        // 备份与恢复
        exportBackup,
        importBackup,

        // 云同步读写与清理
        getCloudLibraryPayload,
        applyCloudLibrary,
        clearUserLibrary
    };
})();
