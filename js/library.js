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
    const expandedLibraryGroups = new Set();

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

        // 1. 收藏歌单板块
        const favBlock = createLibrarySection({
            secId: "lib_favs",
            title: "收藏歌单",
            count: favPlaylists.length,
            isFav: true,
            items: favPlaylists,
            onAddCategory: () => promptCreateCategory("fav")
        });
        container.appendChild(favBlock);

        // 2. 我的自建歌单板块
        const customBlock = createLibrarySection({
            secId: "lib_customs",
            title: "我的歌单",
            count: customPlaylists.length,
            isFav: false,
            items: customPlaylists,
            onAddCategory: () => promptCreateCustomPlaylist()
        });
        container.appendChild(customBlock);
    }

    function createLibrarySection({ secId, title, count, isFav, items, onAddCategory }) {
        const secBlock = document.createElement("div");
        secBlock.className = "sub-accordion-block";

        const isOpen = expandedLibraryGroups.has(secId);

        const hdr = document.createElement("div");
        hdr.className = "sub-accordion-hdr";
        hdr.innerHTML = `
            <div class="sub-accordion-left">
                <span class="sub-accordion-arrow">${isOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(title)}</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px;">
                <span class="count-badge">${count}</span>
                <button class="btn-card-action" title="${isFav ? '新建收藏分类' : '新建自建歌单'}" style="color:var(--accent);">＋</button>
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
                hdr.querySelector(".sub-accordion-arrow").innerHTML = iconArrowCollapsed;
            } else {
                expandedLibraryGroups.add(secId);
                body.classList.add("open");
                hdr.querySelector(".sub-accordion-arrow").innerHTML = iconArrowExpanded;
            }
        };

        // 按分类组聚合
        const grouped = {};
        items.forEach(item => {
            const cat = item.category || "默认";
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });

        const catNames = Object.keys(grouped);
        if (catNames.length === 0) {
            body.innerHTML = `<div style="padding:10px 14px; font-size:var(--fs-t4); color:var(--text-muted);">暂无${title}，可点击 ＋ 新建</div>`;
        } else {
            catNames.forEach(catName => {
                const groupItems = grouped[catName];
                const groupBlock = createCategoryGroupBlock(secId, catName, groupItems, isFav);
                body.appendChild(groupBlock);
            });
        }

        secBlock.appendChild(hdr);
        secBlock.appendChild(body);
        return secBlock;
    }

    function createCategoryGroupBlock(parentSecId, catName, items, isFav) {
        const groupSecId = `${parentSecId}_cat_${catName}`;
        const isGroupOpen = expandedLibraryGroups.has(groupSecId);

        const groupDiv = document.createElement("div");
        groupDiv.className = "library-group-container";

        const groupRow = document.createElement("div");
        groupRow.className = "library-group-row";
        groupRow.innerHTML = `
            <div class="library-group-left">
                <span class="sub-accordion-arrow">${isGroupOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(catName)}</span>
                <span class="count-badge">${items.length}</span>
            </div>
            <div class="library-group-actions">
                ${catName !== "默认" ? `
                    <button class="btn-group-action" title="重命名分类" data-action="rename">✎</button>
                    <button class="btn-group-action btn-del" title="删除分类" data-action="del">✕</button>
                ` : ''}
            </div>
        `;

        const groupBody = document.createElement("div");
        groupBody.className = `library-group-body ${isGroupOpen ? 'open' : ''}`;

        groupRow.onclick = (e) => {
            if (e.target.closest("button")) return;
            if (expandedLibraryGroups.has(groupSecId)) {
                expandedLibraryGroups.delete(groupSecId);
                groupBody.classList.remove("open");
                groupRow.querySelector(".sub-accordion-arrow").innerHTML = iconArrowCollapsed;
            } else {
                expandedLibraryGroups.add(groupSecId);
                groupBody.classList.add("open");
                groupRow.querySelector(".sub-accordion-arrow").innerHTML = iconArrowExpanded;
            }
        };

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
                promptDeleteCategory(isFav ? "fav" : "custom", catName);
            };
        }

        // 渲染分类下的卡片
        items.forEach(item => {
            const card = window.LeftPanel.createPlaylistCard(item, {
                isCustom: !isFav,
                isFav: isFav,
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
        const name = prompt("请输入新建分类名称：");
        if (name && name.trim()) {
            window.StorageManager.addCategory(type, name.trim());
            renderLibrary();
        }
    }

    function promptRenameCategory(type, oldName) {
        const newName = prompt(`将分类 "${oldName}" 重命名为：`, oldName);
        if (newName && newName.trim() && newName.trim() !== oldName) {
            window.StorageManager.renameCategory(type, oldName, newName.trim());
            renderLibrary();
        }
    }

    function promptDeleteCategory(type, catName) {
        if (confirm(`确认删除分类 "${catName}" 吗？（内部歌单将归入 "默认"）`)) {
            window.StorageManager.deleteCategory(type, catName);
            renderLibrary();
        }
    }

    function promptCreateCustomPlaylist() {
        const title = prompt("请输入新建歌单名称：");
        if (title && title.trim()) {
            const pl = window.StorageManager.createCustomPlaylist(title.trim(), "默认");
            if (pl) {
                window.Shell?.showToast?.(`已创建歌单《${pl.title}》`);
                renderLibrary();
                window.RightPanel?.selectCustomPlaylist?.(pl.id);
            }
        }
    }

    return {
        init,
        renderLibrary
    };
})();
