/**
 * ========================================================
 * js/library.js - 我的音乐库控制器 (遵照 SITE_ARCHITECTURE.md)
 * 纯手风琴树状层级：
 * - 收藏歌单 (分类组 -> 歌单/专辑)
 * - 我的歌单 (分类组 -> 自建歌单/专辑)
 * 纯图标操作：▶ 播放 / ✕ 删除 / ↓ 下载 / + 新建 / ✎ 重命名
 * ========================================================
 */

window.LibraryPanel = (function () {
    'use strict';

    let containerElement = null;
    const expandedLibraryGroups = new Set(["lib_favs", "lib_customs", "lib_favs_cat_未分组", "lib_customs_cat_未分组"]);

    const iconArrowCollapsed = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>`;
    const iconArrowExpanded = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>`;

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function init(container) {
        containerElement = container;
        renderLibrary();

        // 监听本地存储变更，自动同步
        window.addEventListener("amusic-storage-changed", () => {
            renderLibrary();
        });
    }

    /**
     * 主渲染：挂载“收藏歌单”与“我的歌单”两大子板块
     */
    function renderLibrary(container = containerElement) {
        if (!container) return;
        containerElement = container;
        container.innerHTML = "";

        const favPlaylists = window.StorageManager.getFavPlaylists();
        const customPlaylists = window.StorageManager.getCustomPlaylists();

        // 1. 收藏歌单板块 (＋ 为新建分类组)
        const favBlock = createLibrarySection({
            secId: "lib_favs",
            title: "收藏歌单",
            count: favPlaylists.length,
            isFav: true,
            items: favPlaylists,
            onAddCategory: () => promptCreateCategory("fav")
        });
        container.appendChild(favBlock);

        // 2. 我的自建歌单板块 (＋ 严格为新建分类组)
        const customBlock = createLibrarySection({
            secId: "lib_customs",
            title: "我的歌单",
            count: customPlaylists.length,
            isFav: false,
            items: customPlaylists,
            onAddCategory: () => promptCreateCategory("custom")
        });
        container.appendChild(customBlock);
    }

    function createLibrarySection({ secId, title, count, isFav, items, onAddCategory }) {
        const secBlock = document.createElement("div");
        secBlock.className = "sub-accordion-block";
        if (secId) secBlock.id = secId;

        const isOpen = expandedLibraryGroups.has(secId);

        const hdr = document.createElement("div");
        hdr.className = `sub-accordion-hdr ${isOpen ? 'open' : ''}`;
        hdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow ${isOpen ? 'open' : ''}">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(title)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span class="count-badge">${count}</span>
                <button class="btn-card-action" title="新建分类组" style="color:var(--accent);">＋</button>
            </div>
        `;

        const btnAdd = hdr.querySelector("button");
        btnAdd.onclick = (e) => {
            e.stopPropagation();
            onAddCategory();
        };

        const body = document.createElement("div");
        body.className = `sub-accordion-body ${isOpen ? 'open' : ''}`;

        hdr.onclick = () => {
            if (expandedLibraryGroups.has(secId)) {
                expandedLibraryGroups.delete(secId);
                body.classList.remove("open");
                hdr.classList.remove("open");
                const arrow = hdr.querySelector(".sub-accordion-arrow");
                arrow.classList.remove("open");
                arrow.innerHTML = iconArrowCollapsed;
            } else {
                expandedLibraryGroups.add(secId);
                body.classList.add("open");
                hdr.classList.add("open");
                const arrow = hdr.querySelector(".sub-accordion-arrow");
                arrow.classList.add("open");
                arrow.innerHTML = iconArrowExpanded;
            }
        };

        // 按分类组聚合（【未分组】常驻置顶不可删）
        const kind = isFav ? "fav" : "custom";
        const registered = window.StorageManager.getRegisteredCategories(kind);
        const grouped = {};
        grouped["未分组"] = [];
        registered.forEach(c => {
            if (!grouped[c]) grouped[c] = [];
        });

        items.forEach(item => {
            const rawCat = item.category;
            const cat = (!rawCat || rawCat === "默认" || rawCat === "未分类" || rawCat === "未分组") ? "未分组" : rawCat.trim();
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });

        // 排序规则：【未分组】常驻置顶，其余分类按字母/时间顺序排序
        const catNames = Object.keys(grouped).sort((a, b) => {
            if (a === "未分组") return -1;
            if (b === "未分组") return 1;
            return a.localeCompare(b);
        });

        catNames.forEach(catName => {
            const groupItems = grouped[catName];
            const groupBlock = createCategoryGroupBlock(secId, catName, groupItems, isFav);
            body.appendChild(groupBlock);
        });

        secBlock.appendChild(hdr);
        secBlock.appendChild(body);
        return secBlock;
    }

    function createCategoryGroupBlock(parentSecId, catName, items, isFav) {
        const groupSecId = `${parentSecId}_cat_${catName}`;
        const isGroupOpen = expandedLibraryGroups.has(groupSecId);

        const groupDiv = document.createElement("div");
        groupDiv.className = "library-group-container";
        groupDiv.id = groupSecId;

        const groupRow = document.createElement("div");
        groupRow.className = `library-group-row ${isGroupOpen ? 'open' : ''}`;

        // 【未分组】不渲染 ✎ 与 ✕；自定义分组有 ✎ 与 ✕；我的歌单可在组内新建歌单（＋）
        let actionsHtml = "";
        if (!isFav) {
            actionsHtml += `<button class="btn-group-action" title="在此分组新建歌单" data-action="add-pl">＋</button>`;
        }
        if (catName !== "未分组") {
            actionsHtml += `
                <button class="btn-group-action" title="重命名分类" data-action="rename">✎</button>
                <button class="btn-group-action btn-del" title="删除分类" data-action="del">✕</button>
            `;
        }

        groupRow.innerHTML = `
            <div class="library-group-left">
                <span class="sub-accordion-arrow ${isGroupOpen ? 'open' : ''}">${isGroupOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(catName)}</span>
                <span class="count-badge">${items.length}</span>
            </div>
            <div class="library-group-actions">
                ${actionsHtml}
            </div>
        `;

        const groupBody = document.createElement("div");
        groupBody.className = `library-group-body ${isGroupOpen ? 'open' : ''}`;

        groupRow.onclick = (e) => {
            if (e.target.closest("button")) return;
            if (expandedLibraryGroups.has(groupSecId)) {
                expandedLibraryGroups.delete(groupSecId);
                groupBody.classList.remove("open");
                groupRow.classList.remove("open");
                const arrow = groupRow.querySelector(".sub-accordion-arrow");
                arrow.classList.remove("open");
                arrow.innerHTML = iconArrowCollapsed;
            } else {
                expandedLibraryGroups.add(groupSecId);
                groupBody.classList.add("open");
                groupRow.classList.add("open");
                const arrow = groupRow.querySelector(".sub-accordion-arrow");
                arrow.classList.add("open");
                arrow.innerHTML = iconArrowExpanded;
            }
        };

        const btnAddPl = groupRow.querySelector('[data-action="add-pl"]');
        if (btnAddPl) {
            btnAddPl.onclick = (e) => {
                e.stopPropagation();
                promptCreateCustomPlaylistInGroup(catName);
            };
        }

        const btnRename = groupRow.querySelector('[data-action="rename"]');
        if (btnRename) {
            btnRename.onclick = (e) => {
                e.stopPropagation();
                promptRenameCategory(isFav ? "fav" : "custom", catName);
            };
        }

        const btnDel = groupRow.querySelector('[data-action="del"]');
        if (btnDel) {
            btnDel.onclick = (e) => {
                e.stopPropagation();
                promptDeleteCategory(isFav ? "fav" : "custom", catName, items.length);
            };
        }

        // 渲染分类下的卡片
        items.forEach(item => {
            const card = window.LeftPanel.createPlaylistCard(item, {
                isCustom: !isFav,
                isFav: isFav,
                onRename: !isFav ? () => promptRenameCustomPlaylist(item.id, item.title || item.name) : null,
                onDelete: () => {
                    if (isFav) {
                        window.StorageManager.unfavPlaylist(item.id);
                        window.Shell?.showToast?.(`已移除收藏《${item.name || item.title}》`);
                    } else {
                        window.StorageManager.deleteCustomPlaylist(item.id);
                        window.Shell?.showToast?.(`已删除歌单《${item.title}》`);
                    }
                    renderLibrary();
                }
            });
            groupBody.appendChild(card);
        });

        groupDiv.appendChild(groupRow);
        groupDiv.appendChild(groupBody);
        return groupDiv;
    }

    function promptCreateCategory(type) {
        const name = prompt("请输入新建分类组名称：");
        if (name && name.trim()) {
            const trimmed = name.trim();
            if (trimmed === "未分组") {
                alert("已存在默认【未分组】分类");
                return;
            }
            window.StorageManager.addCategory(type, trimmed);
            renderLibrary();
        }
    }

    function promptRenameCategory(type, oldName) {
        if (oldName === "未分组") {
            alert("【未分组】不可重命名");
            return;
        }
        const newName = prompt(`将分类 "${oldName}" 重命名为：`, oldName);
        if (newName && newName.trim() && newName.trim() !== oldName) {
            const res = window.StorageManager.renameCategory(type, oldName, newName.trim());
            if (res.ok) {
                renderLibrary();
            } else {
                alert(res.error || "重命名失败");
            }
        }
    }

    function promptDeleteCategory(type, catName, itemCount) {
        if (catName === "未分组") {
            alert("【未分组】为根分类，不能删除");
            return;
        }
        if (itemCount > 0) {
            window.Shell?.showToast?.("该组内包含歌单，无法删除");
            alert("该组内包含歌单，无法删除。请先清空或移出组内歌单。");
            return;
        }
        if (confirm(`确认删除空分类组 "${catName}" 吗？`)) {
            const res = window.StorageManager.deleteCategory(type, catName);
            if (res.ok) {
                window.Shell?.showToast?.(`已删除分类组《${catName}》`);
                renderLibrary();
            } else {
                alert(res.error || "删除失败");
            }
        }
    }

    function promptCreateCustomPlaylistInGroup(catName = "未分组") {
        const title = prompt(`在【${catName}】分组下新建歌单名称：`);
        if (title && title.trim()) {
            const pl = window.StorageManager.createCustomPlaylist(title.trim(), catName);
            if (pl) {
                window.Shell?.showToast?.(`已创建歌单《${pl.title}》`);
                renderLibrary();
                window.RightPanel?.selectCustomPlaylist?.(pl.id);
            }
        }
    }

    function promptRenameCustomPlaylist(id, currentTitle) {
        const newTitle = prompt("请输入新歌单名称：", currentTitle);
        if (newTitle && newTitle.trim() && newTitle.trim() !== currentTitle) {
            const ok = window.StorageManager.renameCustomPlaylist(id, newTitle.trim());
            if (ok) {
                window.Shell?.showToast?.(`歌单已更名为《${newTitle.trim()}》`);
                renderLibrary();
                if (window.RightPanel?.isViewingCustom?.(id)) {
                    window.RightPanel.updateCurrentCustomTitle?.(newTitle.trim());
                }
            }
        }
    }

    return {
        init,
        renderLibrary
    };
})();
