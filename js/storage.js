/**
 * ========================================================
 * js/storage.js - YY-Amusic 用户数据中枢与配置备份还原引擎
 * 负责：
 * 1. 自建歌单增删改查 CRUD
 * 2. 收藏官方歌单管理
 * 3. 历史记忆与用户偏好持久化
 * 4. 用户数据一键导出备份 (JSON) 与导入恢复 (JSON)
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

    // 辅助安全写入 JSON 并广播变更事件
    function setJson(key, val, eventType = "update") {
        try {
            localStorage.setItem(key, JSON.stringify(val));
            window.dispatchEvent(new CustomEvent("amusic-storage-changed", {
                detail: { key, eventType, data: val }
            }));
            return true;
        } catch (e) {
            console.error(`[StorageManager] 写入 ${key} 失败:`, e);
            return false;
        }
    }

    /* -------------------- 1. 自建歌单管理 -------------------- */

    function getCustomPlaylists() {
        return getJson(KEY_CUSTOM, []);
    }

    function saveCustomPlaylists(list) {
        return setJson(KEY_CUSTOM, list, "custom_playlists");
    }

    function createCustomPlaylist(title, category = "默认") {
        if (!title || !title.trim()) return null;
        const list = getCustomPlaylists();
        const trimmed = title.trim();
        let existing = list.find(p => p.title === trimmed);
        if (existing) return existing;

        const newPl = {
            id: `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            title: trimmed,
            category: (category || "默认").trim(),
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
        // 避免同一歌单内重复加入同名同歌手的曲目
        const isDuplicate = pl.tracks.some(t =>
            (t.name === track.name && t.artist === track.artist) ||
            (track.id && t.id && t.id === track.id)
        );
        if (isDuplicate) {
            return { ok: false, duplicate: true };
        }

        pl.tracks.push({
            index: pl.tracks.length + 1,
            name: track.name || track.title || "未知曲目",
            artist: track.artist || "未知歌手",
            album: track.album || pl.title,
            durationMillis: track.durationMillis || (track.duration ? track.duration * 1000 : 0),
            id: track.id || "",
            url: track.url || ""
        });

        saveCustomPlaylists(list);
        return { ok: true, playlist: pl };
    }

    function removeTrackFromCustomPlaylist(playlistId, trackIndex) {
        const list = getCustomPlaylists();
        const pl = list.find(p => p.id === playlistId);
        if (!pl || !Array.isArray(pl.tracks)) return false;

        if (trackIndex >= 0 && trackIndex < pl.tracks.length) {
            pl.tracks.splice(trackIndex, 1);
            // 重新排列 index 序号
            pl.tracks.forEach((t, idx) => { t.index = idx + 1; });
            saveCustomPlaylists(list);
            return true;
        }
        return false;
    }

    function changePlaylistCategory(kind, id, newCategory) {
        const cat = (newCategory || "未分类").trim();
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
        set.add("未分类");
        if (Array.isArray(saved)) {
            saved.forEach(c => {
                if (c && typeof c === 'string' && c.trim() && c.trim() !== "未分类" && c.trim() !== "默认") {
                    set.add(c.trim());
                }
            });
        }
        // 自动合并对应歌单中已存在的非空分类
        const plList = kind === 'fav' ? getFavPlaylists() : getCustomPlaylists();
        plList.forEach(p => {
            const cat = (!p.category || p.category === "默认" || p.category === "未分类") ? "未分类" : p.category.trim();
            if (cat !== "未分类") {
                set.add(cat);
            }
        });
        return Array.from(set);
    }

    function addCategory(kind, name) {
        if (!name || typeof name !== 'string' || !name.trim()) return false;
        const trimmed = name.trim();
        if (trimmed === "未分类" || trimmed === "默认") return false;
        const key = kind === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
        const saved = getJson(key, []);
        if (!saved.includes(trimmed)) {
            saved.push(trimmed);
            setJson(key, saved);
        }
        return true;
    }

    function renameCategory(kind, oldCat, newCat) {
        if (!newCat || !newCat.trim()) return false;
        const targetCat = newCat.trim();
        if (oldCat === targetCat) return true;

        const key = kind === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
        let cats = getJson(key, []);
        if (!Array.isArray(cats)) cats = [];

        if (oldCat === "未分类") {
            if (!cats.includes(targetCat)) cats.push(targetCat);
        } else {
            const idx = cats.indexOf(oldCat);
            if (idx !== -1) {
                cats[idx] = targetCat;
            } else if (!cats.includes(targetCat)) {
                cats.push(targetCat);
            }
        }
        setJson(key, cats.filter(c => c !== "未分类"));

        if (kind === 'fav') {
            const list = getFavPlaylists();
            list.forEach(f => {
                const cur = (f.category === "默认" || !f.category) ? "未分类" : f.category;
                if (cur === oldCat) f.category = targetCat;
            });
            saveFavPlaylists(list);
            return true;
        } else {
            const list = getCustomPlaylists();
            list.forEach(c => {
                const cur = (c.category === "默认" || !c.category) ? "未分类" : c.category;
                if (cur === oldCat) c.category = targetCat;
            });
            saveCustomPlaylists(list);
            return true;
        }
    }

    function deleteCategory(kind, catName) {
        const key = kind === 'fav' ? KEY_CAT_FAV : KEY_CAT_CUSTOM;
        let cats = getJson(key, []);
        if (Array.isArray(cats)) {
            cats = cats.filter(c => c !== catName);
            setJson(key, cats);
        }

        if (catName === "未分类") {
            if (kind === 'fav') {
                const list = getFavPlaylists().filter(f => {
                    const cur = (f.category === "默认" || !f.category) ? "未分类" : f.category;
                    return cur !== "未分类";
                });
                saveFavPlaylists(list);
            } else {
                const list = getCustomPlaylists().filter(c => {
                    const cur = (c.category === "默认" || !c.category) ? "未分类" : c.category;
                    return cur !== "未分类";
                });
                saveCustomPlaylists(list);
            }
            return true;
        }

        if (kind === 'fav') {
            const list = getFavPlaylists();
            list.forEach(f => {
                const cur = (f.category === "默认" || !f.category) ? "未分类" : f.category;
                if (cur === catName) f.category = "未分类";
            });
            saveFavPlaylists(list);
            return true;
        } else {
            const list = getCustomPlaylists();
            list.forEach(c => {
                const cur = (c.category === "默认" || !c.category) ? "未分类" : c.category;
                if (cur === catName) c.category = "未分类";
            });
            saveCustomPlaylists(list);
            return true;
        }
    }

    /* -------------------- 2. 收藏官方歌单管理 -------------------- */

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

    function favPlaylistWithCategory(playlistData, category = "未分类") {
        if (!playlistData || !playlistData.id) return false;
        const favs = getFavPlaylists();
        const cat = (category || "未分类").trim();
        const idx = favs.findIndex(f => f.id === playlistData.id);

        if (idx >= 0) {
            favs[idx].category = cat;
            if (playlistData.name) favs[idx].name = playlistData.name;
            if (playlistData.title) favs[idx].title = playlistData.title;
            if (playlistData.trackCount !== undefined) favs[idx].trackCount = playlistData.trackCount;
            saveFavPlaylists(favs);
            return { action: 'updated', category: cat };
        } else {
            favs.unshift({
                id: playlistData.id,
                type: playlistData.type || 'playlist',
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

    function toggleFavPlaylist(playlistData, targetCategory = "未分类") {
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

    /**
     * 收藏按键交互流：弹出选项选择【1: 新建分类】还是【2: 加入已有分类】
     */
    function promptFavoriteFlow(playlistData, onDone) {
        if (!playlistData || !playlistData.id) return;
        const plName = playlistData.name || playlistData.title || "歌单";
        const isFaved = isPlaylistFaved(playlistData.id);

        if (isFaved) {
            const favs = getFavPlaylists();
            const curItem = favs.find(f => f.id === playlistData.id);
            const curCat = curItem ? (curItem.category || "未分类") : "未分类";
            const choice = prompt(
                `歌单《${plName}》已在收藏中 (当前分类: ${curCat})：\n1: 🏷️ 更改所属分类\n2: ❌ 取消收藏\n\n请输入 1 或 2:`,
                "1"
            );
            if (choice === "2") {
                unfavPlaylist(playlistData.id);
                if (window.showToast) window.showToast(`已从收藏夹中移除《${plName}》`);
                if (typeof onDone === 'function') onDone({ action: 'unfaved' });
                return;
            } else if (choice !== "1") {
                return; // 用户取消
            }
        }

        // 核心分支：新建分类 还是 加入已有分类
        const branchChoice = prompt(
            `收藏歌单《${plName}》：\n1: 📁 新建分类\n2: 📌 加入已有分类\n\n请输入 1 或 2:`,
            "2"
        );
        if (!branchChoice) return;

        if (branchChoice.trim() === "1") {
            const newCat = prompt("请输入新分类名称 (例如: 华语流行 / 摇滚 / 车载):");
            if (!newCat || !newCat.trim()) return;
            const trimmedCat = newCat.trim();
            addCategory('fav', trimmedCat);
            favPlaylistWithCategory(playlistData, trimmedCat);
            if (window.showToast) window.showToast(`⭐ 已收藏《${plName}》至新分类【${trimmedCat}】！`);
            if (typeof onDone === 'function') onDone({ action: 'added', category: trimmedCat });
        } else if (branchChoice.trim() === "2") {
            const cats = getRegisteredCategories('fav');
            let chosenCat = "未分类";
            if (cats.length <= 1) {
                // 仅有未分类
                chosenCat = "未分类";
                favPlaylistWithCategory(playlistData, chosenCat);
                if (window.showToast) window.showToast(`⭐ 已收藏《${plName}》至【未分类】！`);
                if (typeof onDone === 'function') onDone({ action: 'added', category: chosenCat });
            } else {
                let msg = `请选择目标分类序号 (1 - ${cats.length})：\n`;
                cats.forEach((c, idx) => {
                    msg += `${idx + 1}: 📁 ${c}\n`;
                });
                msg += `\n请输入分类序号:`;
                const catIdxStr = prompt(msg, "1");
                if (!catIdxStr) return;
                const idx = parseInt(catIdxStr.trim(), 10) - 1;
                if (idx >= 0 && idx < cats.length) {
                    chosenCat = cats[idx];
                } else if (catIdxStr.trim()) {
                    chosenCat = catIdxStr.trim();
                    addCategory('fav', chosenCat);
                }
                favPlaylistWithCategory(playlistData, chosenCat);
                if (window.showToast) window.showToast(`⭐ 已收藏《${plName}》至【${chosenCat}】！`);
                if (typeof onDone === 'function') onDone({ action: 'added', category: chosenCat });
            }
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

    /* -------------------- 3. 用户历史记忆与偏好 -------------------- */

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

    /* -------------------- 4. 一键导出备份与导入恢复 -------------------- */

    /**
     * 导出完整备份数据为 JSON 文件并由浏览器直接下载
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

        const jsonStr = JSON.stringify(backupData, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const fileName = `amusic_backup_${dateStr}.json`;

        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);

        return {
            fileName,
            customsCount: customs.length,
            favsCount: favs.length
        };
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

            // 智能合并或覆盖
            saveCustomPlaylists(newCustoms);
            saveFavPlaylists(newFavs);

            if (Array.isArray(data.categoriesCustom)) {
                setJson(KEY_CAT_CUSTOM, data.categoriesCustom);
            }
            if (Array.isArray(data.categoriesFav)) {
                setJson(KEY_CAT_FAV, data.categoriesFav);
            }

            if (data.lastPlaylist) setLastPlaylist(data.lastPlaylist);
            if (data.volume !== undefined) localStorage.setItem(KEY_VOLUME, data.volume.toString());
            if (data.storefront) localStorage.setItem(KEY_STOREFRONT, data.storefront);

            window.dispatchEvent(new CustomEvent("amusic-storage-changed", {
                detail: { key: "all", eventType: "restore" }
            }));

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
        promptFavoriteFlow,

        // 历史记忆
        getLastPlaylist,
        setLastPlaylist,

        // 备份与恢复
        exportBackup,
        importBackup
    };
})();
