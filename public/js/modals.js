/**
 * ========================================================
 * 模块：js/modals.js - 业务弹窗集中管理器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.Modals
 * 依赖协同：window.StorageManager, window.LibraryPanel, window.RightPanel, window.Downloader, window.Shell
 * --------------------------------------------------------
 * 功能目录：
 *   1. 收藏分类弹窗 (AddToFavModal)       —— 歌单收藏、自建新分类与取消收藏
 *   2. 移动歌单分组弹窗 (MoveCategoryModal) —— 快速跨分类迁移自建或收藏歌单
 *   3. 添加到自建歌单弹窗 (AddToCustomModal) —— 单曲或多选批量加入现有或新建歌单
 *   4. 批量打包下载弹窗 (BatchDownloadModal) —— 选中曲目清单校验与 ZIP 导出
 *   5. 通用二次确认弹窗 (ConfirmActionModal) —— 防误触删除歌单、移除歌曲与清空确认
 *   6. 通用文本输入弹窗 (InputPromptModal)  —— 歌单重命名、新建分类名称录入
 * ========================================================
 */

window.Modals = (function () {
    'use strict';

    const escapeHtml = (str) => window.AmusicUtils.escapeHtml(str);
    const normalizeCategory = (cat) => window.AmusicUtils.normalizeCategory(cat);

    function showToast(msg) {
        if (window.Shell?.showToast) {
            window.Shell.showToast(msg);
        }
    }

    /* -------------------- 1. 弹窗：添加到收藏分类 -------------------- */
    let pendingFavPlaylist = null;

    function openAddToFavModal(playlistData) {
        if (!playlistData || !playlistData.id) return;
        pendingFavPlaylist = playlistData;

        const modal = document.getElementById("addToFavModal");
        const infoEl = document.getElementById("favModalPlaylistInfo");
        const choiceList = document.getElementById("favCategoryChoiceList");
        const input = document.getElementById("newFavCategoryInput");

        if (input) input.value = "";
        const name = playlistData.name || playlistData.title || "未知歌单";
        const curator = playlistData.curator || "Apple Music";
        const isFaved = window.StorageManager.isPlaylistFaved(playlistData.id);

        let curCat = "";
        if (isFaved) {
            const favs = window.StorageManager.getFavPlaylists();
            const curItem = favs.find(f => f.id === playlistData.id);
            curCat = normalizeCategory(curItem ? curItem.category : "");
        }

        if (infoEl) {
            infoEl.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span>${escapeHtml(name)} <span style="opacity:0.7; font-size:var(--fs-t4);">• ${escapeHtml(curator)}</span></span>
                    ${isFaved ? `
                        <button class="btn btn-sm btn-ghost" style="color:var(--danger-text); font-size:var(--fs-t4); padding:1px 5px; cursor:pointer;" onclick="window.Modals.unfavCurrentFromModal()" title="取消收藏">✕ 取消收藏</button>
                    ` : ''}
                </div>
            `;
        }

        if (choiceList) {
            const cats = window.StorageManager.getAllCategories ? window.StorageManager.getAllCategories() : window.StorageManager.getRegisteredCategories('fav');
            const favs = window.StorageManager.getFavPlaylists();
            let html = '';
            cats.forEach(c => {
                const count = favs.filter(f => normalizeCategory(f.category) === c).length;
                const isCurrent = isFaved && curCat === c;
                html += `
                    <div class="playlist-choice-item" data-category="${escapeHtml(c)}" onclick="window.Modals.selectFavCategory(this.dataset.category)" style="${isCurrent ? 'background:var(--accent-soft-bg); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:var(--fs-t4); margin-left:6px;">(当前分类)</span>' : ''}
                        </div>
                        <span class="meta-tag">共 ${count} 个歌单</span>
                    </div>
                `;
            });
            choiceList.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeAddToFavModal() {
        const modal = document.getElementById("addToFavModal");
        if (modal) modal.classList.remove("open");
        pendingFavPlaylist = null;
    }

    function selectFavCategory(catName) {
        if (!pendingFavPlaylist) return;
        window.StorageManager.favPlaylistWithCategory(pendingFavPlaylist, catName);
        showToast(`已收藏至【${catName}】`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    function confirmCreateCategoryAndFav() {
        if (!pendingFavPlaylist) return;
        const input = document.getElementById("newFavCategoryInput");
        const name = input ? input.value.trim() : "";
        if (!name) {
            showToast("请输入新分类名称");
            return;
        }
        window.StorageManager.addCategory('fav', name);
        window.StorageManager.favPlaylistWithCategory(pendingFavPlaylist, name);
        showToast(`已创建分类【${name}】并收藏`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    function unfavCurrentFromModal() {
        if (!pendingFavPlaylist) return;
        window.StorageManager.unfavPlaylist(pendingFavPlaylist.id);
        showToast(`已取消收藏《${pendingFavPlaylist.name || pendingFavPlaylist.title}》`);
        closeAddToFavModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    /* -------------------- 2. 弹窗：移动歌单到分组 -------------------- */
    let pendingMoveData = null; // { kind, id, curCat }

    function openMoveCategoryModal(kind, playlistId, curCat) {
        if (!playlistId) return;
        const normCurCat = normalizeCategory(curCat);
        pendingMoveData = { kind, id: playlistId, curCat: normCurCat };

        const modal = document.getElementById("moveCategoryModal");
        const infoEl = document.getElementById("moveModalPlaylistInfo");
        const choiceList = document.getElementById("moveCategoryChoiceList");
        const input = document.getElementById("newMoveCategoryInput");

        if (input) input.value = "";

        let plName = "当前歌单";
        if (kind === 'fav') {
            const item = window.StorageManager.getFavPlaylists().find(f => f.id === playlistId);
            if (item) plName = item.name || item.title || plName;
        } else {
            const item = window.StorageManager.getCustomPlaylists().find(c => c.id === playlistId);
            if (item) plName = item.title || plName;
        }

        if (infoEl) {
            infoEl.innerHTML = `<span>移动歌单：<strong>${escapeHtml(plName)}</strong> <span style="opacity:0.7; font-size:var(--fs-t4);">(当前: ${escapeHtml(normCurCat)})</span></span>`;
        }

        if (choiceList) {
            const cats = window.StorageManager.getAllCategories ? window.StorageManager.getAllCategories() : window.StorageManager.getRegisteredCategories(kind);
            let html = '';
            cats.forEach(c => {
                const isCurrent = normCurCat === c;
                html += `
                    <div class="playlist-choice-item" data-category="${escapeHtml(c)}" onclick="window.Modals.selectMoveCategory(this.dataset.category)" style="${isCurrent ? 'background:var(--accent-soft-bg); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:var(--fs-t4); margin-left:6px;">(当前分组)</span>' : ''}
                        </div>
                        <span class="meta-tag">${isCurrent ? '已在此组' : '移至此组'}</span>
                    </div>
                `;
            });
            choiceList.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeMoveCategoryModal() {
        const modal = document.getElementById("moveCategoryModal");
        if (modal) modal.classList.remove("open");
        pendingMoveData = null;
    }

    function selectMoveCategory(catName) {
        if (!pendingMoveData) return;
        window.StorageManager.changePlaylistCategory(pendingMoveData.kind, pendingMoveData.id, catName);
        showToast(`已移动至【${catName}】`);
        closeMoveCategoryModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    function confirmCreateCategoryAndMove() {
        if (!pendingMoveData) return;
        const input = document.getElementById("newMoveCategoryInput");
        const name = input ? input.value.trim() : "";
        if (!name) {
            showToast("请输入新分组名称");
            return;
        }
        window.StorageManager.addCategory(pendingMoveData.kind, name);
        window.StorageManager.changePlaylistCategory(pendingMoveData.kind, pendingMoveData.id, name);
        showToast(`已创建分组【${name}】并移动至此`);
        closeMoveCategoryModal();
        window.LibraryPanel?.renderLibrary?.();
    }

    /* -------------------- 3. 弹窗：添加到自建歌单 -------------------- */
    function openAddToCustomModal(songInfoText) {
        const modal = document.getElementById("addToPlaylistModal");
        const infoEl = document.getElementById("addToSongInfo");
        const choiceList = document.getElementById("playlistChoiceList");
        const input = document.getElementById("newPlaylistInput");

        if (input) input.value = "";
        if (infoEl) infoEl.innerText = songInfoText || "已选择歌曲";

        if (choiceList) {
            const customs = window.StorageManager.getCustomPlaylists();
            if (customs.length === 0) {
                choiceList.innerHTML = '<div style="padding:8px; font-size:var(--fs-t4); color:var(--text-muted);">暂无自建歌单，请在下方直接输入名称新建</div>';
            } else {
                let html = '';
                customs.forEach(pl => {
                    const count = pl.tracks ? pl.tracks.length : 0;
                    html += `
                        <div class="playlist-choice-item" data-playlist-id="${escapeHtml(pl.id)}" onclick="window.RightPanel.confirmAddPendingToPlaylist(this.dataset.playlistId)">
                            <strong>${escapeHtml(pl.title)}</strong>
                            <span class="meta-tag">共 ${count} 首歌</span>
                        </div>
                    `;
                });
                choiceList.innerHTML = html;
            }
        }

        if (modal) modal.classList.add("open");
    }

    function closeAddToCustomModal() {
        const modal = document.getElementById("addToPlaylistModal");
        if (modal) modal.classList.remove("open");
    }

    function confirmCreateAndAdd() {
        const input = document.getElementById("newPlaylistInput");
        const title = input ? input.value.trim() : "";
        if (!title) {
            showToast("请输入新歌单名称");
            return;
        }
        const newPl = window.StorageManager.createCustomPlaylist(title, "未分组");
        if (newPl) {
            window.RightPanel.confirmAddPendingToPlaylist(newPl.id);
            window.LibraryPanel?.renderLibrary?.();
        }
    }

    /* -------------------- 4. 弹窗：批量打包下载确认 -------------------- */
    let pendingBatchDownloadTracks = [];

    function openBatchDownloadModal(tracks) {
        pendingBatchDownloadTracks = tracks || [];
        const modal = document.getElementById("batchDownloadModal");
        const summaryEl = document.getElementById("batchDownloadSummary");
        const listEl = document.getElementById("batchDownloadSongList");

        if (summaryEl) {
            summaryEl.innerText = `已选中 ${pendingBatchDownloadTracks.length} 首歌曲，将打包为单个 ZIP 文件下载：`;
        }
        if (listEl) {
            let html = "";
            pendingBatchDownloadTracks.forEach((t, i) => {
                const title = t.name || t.title || "未知歌曲";
                const artist = t.artist || "未知歌手";
                const dur = t.durationMillis ? `${Math.floor(t.durationMillis / 60000)}:${String(Math.floor((t.durationMillis % 60000) / 1000)).padStart(2, '0')}` : "";
                html += `
                    <div style="padding:3px 4px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle);">
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:8px;">${i + 1}. <strong>${escapeHtml(title)}</strong> - ${escapeHtml(artist)}</span>
                        ${dur ? `<span style="color:var(--text-muted); font-size:10px; flex-shrink:0;">${dur}</span>` : ''}
                    </div>
                `;
            });
            listEl.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeBatchDownloadModal() {
        const modal = document.getElementById("batchDownloadModal");
        if (modal) modal.classList.remove("open");
        pendingBatchDownloadTracks = [];
    }

    function confirmBatchDownload() {
        if (!pendingBatchDownloadTracks || pendingBatchDownloadTracks.length === 0) {
            closeBatchDownloadModal();
            return;
        }
        const toDownload = [...pendingBatchDownloadTracks];
        closeBatchDownloadModal();
        window.Downloader?.startZipBatchDownload?.(toDownload);
    }

    /* -------------------- 5. 弹窗：通用确认 (防误触) -------------------- */
    let pendingConfirmCallback = null;

    function openConfirmModal({ title, message, confirmText, cancelText, onConfirm }) {
        const modal = document.getElementById("confirmActionModal");
        const titleEl = document.getElementById("confirmActionTitle");
        const msgEl = document.getElementById("confirmActionMessage");
        const submitBtn = document.getElementById("btnConfirmActionSubmit");
        const cancelBtn = document.getElementById("btnConfirmActionCancel");

        if (titleEl) titleEl.innerText = title || "操作确认";
        if (msgEl) msgEl.innerText = message || "确认执行此操作吗？";
        if (cancelBtn) cancelBtn.innerText = cancelText || "取消";
        if (submitBtn) submitBtn.innerText = confirmText || "确认";

        pendingConfirmCallback = onConfirm;

        if (submitBtn) {
            submitBtn.onclick = () => {
                const cb = pendingConfirmCallback;
                closeConfirmActionModal();
                if (typeof cb === 'function') cb();
            };
        }

        if (modal) modal.classList.add("open");
    }

    function closeConfirmActionModal() {
        const modal = document.getElementById("confirmActionModal");
        if (modal) modal.classList.remove("open");
        pendingConfirmCallback = null;
    }

    /* -------------------- 6. 弹窗：通用文本输入/重命名 -------------------- */
    let pendingInputCallback = null;

    function openInputPromptModal({ title, desc, defaultValue, onConfirm }) {
        const modal = document.getElementById("inputPromptModal");
        const titleEl = document.getElementById("inputPromptTitle");
        const descEl = document.getElementById("inputPromptDesc");
        const inputEl = document.getElementById("inputPromptValue");
        const submitBtn = document.getElementById("btnInputPromptSubmit");

        if (titleEl) titleEl.innerText = title || "✎ 重命名";
        if (descEl) descEl.innerText = desc || "请输入新名称：";
        if (inputEl) inputEl.value = defaultValue || "";

        pendingInputCallback = onConfirm;

        function submit() {
            const val = inputEl ? inputEl.value.trim() : "";
            const cb = pendingInputCallback;
            closeInputPromptModal();
            if (typeof cb === 'function') cb(val);
        }

        if (submitBtn) submitBtn.onclick = submit;
        if (inputEl) {
            inputEl.onkeydown = (e) => {
                if (e.key === "Enter") submit();
            };
        }

        if (modal) {
            modal.classList.add("open");
            setTimeout(() => {
                inputEl?.focus();
                inputEl?.select();
            }, 100);
        }
    }

    function closeInputPromptModal() {
        const modal = document.getElementById("inputPromptModal");
        if (modal) modal.classList.remove("open");
        pendingInputCallback = null;
    }

    /* -------------------- 7. 弹窗：保存/更新外部导入歌单 (architecture-playlist-import.md) -------------------- */
    let pendingImportPlaylist = null;
    let pendingImportTracks = [];

    function openSaveImportModal(playlistMeta, tracks) {
        if (!playlistMeta) return;
        pendingImportPlaylist = playlistMeta;
        pendingImportTracks = tracks || [];

        const modal = document.getElementById("saveImportModal");
        const titleInput = document.getElementById("saveImportPlaylistTitle");
        const hintEl = document.getElementById("saveImportHint");
        const choiceList = document.getElementById("saveImportCategoryChoiceList");
        const newCatInput = document.getElementById("newSaveImportCategoryInput");

        if (newCatInput) newCatInput.value = "";
        const defaultTitle = playlistMeta.name || playlistMeta.title || "外部歌单";
        if (titleInput) titleInput.value = defaultTitle;

        // 检查是否已有相同 sourceUrl 的歌单
        const existing = window.StorageManager.findCustomPlaylistBySourceUrl(playlistMeta.sourceUrl);
        const existingCat = existing ? normalizeCategory(existing.category) : "";

        if (hintEl) {
            if (existing) {
                hintEl.style.display = "block";
                hintEl.innerHTML = `⚠️ 该歌单此前已收录于【<strong>${escapeHtml(existingCat)}</strong>】，点击目标分组即直接用最新曲目覆盖更新`;
            } else {
                hintEl.style.display = "none";
                hintEl.innerHTML = "";
            }
        }

        if (choiceList) {
            const cats = window.StorageManager.getAllCategories ? window.StorageManager.getAllCategories() : window.StorageManager.getRegisteredCategories('custom');
            const customs = window.StorageManager.getCustomPlaylists();
            let html = '';
            cats.forEach(c => {
                const count = customs.filter(p => normalizeCategory(p.category) === c).length;
                const isCurrent = existing && existingCat === c;
                html += `
                    <div class="playlist-choice-item" data-category="${escapeHtml(c)}" onclick="window.Modals.selectSaveImportCategory(this.dataset.category)" style="${isCurrent ? 'background:var(--accent-soft-bg); border-left:2px solid var(--accent);' : ''}">
                        <div>
                            <strong>${escapeHtml(c)}</strong>
                            ${isCurrent ? '<span style="color:var(--accent); font-size:var(--fs-t4); margin-left:6px;">(已收录在此，点击即更新)</span>' : ''}
                        </div>
                        <span class="meta-tag">共 ${count} 个歌单</span>
                    </div>
                `;
            });
            choiceList.innerHTML = html;
        }

        if (modal) modal.classList.add("open");
    }

    function closeSaveImportModal() {
        const modal = document.getElementById("saveImportModal");
        if (modal) modal.classList.remove("open");
        pendingImportPlaylist = null;
        pendingImportTracks = [];
    }

    function selectSaveImportCategory(catName) {
        if (!pendingImportPlaylist) return;
        const titleInput = document.getElementById("saveImportPlaylistTitle");
        const title = (titleInput ? titleInput.value.trim() : "") || pendingImportPlaylist.name || "外部歌单";

        const res = window.StorageManager.saveImportedPlaylist({
            title: title,
            category: catName,
            tracks: pendingImportTracks,
            sourceUrl: pendingImportPlaylist.sourceUrl || "",
            sourcePlatform: pendingImportPlaylist.platform || ""
        });

        if (res && res.playlist) {
            if (res.isUpdate) {
                showToast(`已将《${res.playlist.title}》更新为最新曲目 (${pendingImportTracks.length} 首)`);
            } else {
                showToast(`已成功保存《${res.playlist.title}》至【${catName}】`);
            }
            closeSaveImportModal();
            window.LibraryPanel?.renderLibrary?.();
            window.RightPanel?.selectCustomPlaylist?.(res.playlist.id);
        } else {
            showToast("保存歌单失败");
        }
    }

    function confirmCreateCategoryAndSaveImport() {
        if (!pendingImportPlaylist) return;
        const input = document.getElementById("newSaveImportCategoryInput");
        const catName = input ? input.value.trim() : "";
        if (!catName) {
            showToast("请输入新分组名称");
            return;
        }
        window.StorageManager.addCategory('custom', catName);
        selectSaveImportCategory(catName);
    }

    return {
        openAddToFavModal,
        closeAddToFavModal,
        selectFavCategory,
        confirmCreateCategoryAndFav,
        unfavCurrentFromModal,
        openMoveCategoryModal,
        closeMoveCategoryModal,
        selectMoveCategory,
        confirmCreateCategoryAndMove,
        openAddToCustomModal,
        closeAddToCustomModal,
        confirmCreateAndAdd,
        openBatchDownloadModal,
        closeBatchDownloadModal,
        confirmBatchDownload,
        openConfirmModal,
        closeConfirmActionModal,
        openInputPromptModal,
        closeInputPromptModal,
        openSaveImportModal,
        closeSaveImportModal,
        selectSaveImportCategory,
        confirmCreateCategoryAndSaveImport
    };
})();
