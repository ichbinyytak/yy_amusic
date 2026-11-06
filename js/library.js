/**
 * ========================================================
 * 模块：js/library.js - 我的音乐库手风琴与分组控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.LibraryPanel
 * 依赖协同：window.StorageManager, window.RightPanel, window.Shell, window.ContextMenu
 * --------------------------------------------------------
 * 扁平直接的分组层级：
 *   - 顶部工具栏（备份歌单 | 恢复歌单）由 left.js 的 #libraryToolbarRow 承载
 *   - 下方直接展示分组列表：
 *     1. 【未分组】(常驻置顶，不能变，不可重命名/删除，长按不弹出菜单)
 *     2. 自定义分组 (长按支持重命名、删除；不出现新建歌单)
 *   - 歌单卡片：纯标题展示，点击仅在右侧展开曲目列表（绝不播放全部）；
 *     长按支持移动至分组、重命名(自建)、删除
 * --------------------------------------------------------
 * 功能目录：
 *   1. 初始化与存储监听 (init / amusic-storage-changed)
 *   2. 主渲染聚合驱动 (renderLibrary - 自建+收藏歌单聚合分组)
 *   3. 分组手风琴容器生成 (createCategoryGroupBlock)
 *   4. 分组与歌单交互控制 (promptRenameCategory / promptDeleteCategory / promptRenamePlaylist)
 * ========================================================
 */

window.LibraryPanel = (function () {
    'use strict';

    let containerElement = null;
    const expandedLibraryGroups = new Set(["lib_cat_未分组"]);

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

    /* ========================================================
     * 区块 1: 音乐库生命周期与数据驱动主渲染
     * ======================================================== */
    function init(container) {
        containerElement = container;
        renderLibrary();

        // 监听本地存储变更，自动同步
        window.addEventListener("amusic-storage-changed", () => {
            renderLibrary();
        });
    }

    /**
     * 主渲染：直接挂载各分组（【未分组】常驻置顶）
     */
    function renderLibrary(container = containerElement) {
        if (!container) return;
        containerElement = container;
        container.innerHTML = "";

        const favPlaylists = window.StorageManager.getFavPlaylists();
        const customPlaylists = window.StorageManager.getCustomPlaylists();

        // 获取全部注册分类
        const allCategories = window.StorageManager.getAllCategories ? 
            window.StorageManager.getAllCategories() : 
            window.StorageManager.getRegisteredCategories('custom');

        // 按分类聚合全部歌单
        const grouped = {};
        grouped["未分组"] = [];
        allCategories.forEach(cat => {
            const norm = (cat || "未分组").trim();
            if (!grouped[norm]) grouped[norm] = [];
        });

        // 归纳自建歌单
        customPlaylists.forEach(item => {
            const rawCat = item.category;
            const cat = (!rawCat || rawCat === "默认" || rawCat === "未分类" || rawCat === "未分组") ? "未分组" : rawCat.trim();
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({ ...item, _isCustom: true });
        });

        // 归纳收藏歌单（我的音乐库就是我的歌单，统一聚合在分组中）
        favPlaylists.forEach(item => {
            const rawCat = item.category;
            const cat = (!rawCat || rawCat === "默认" || rawCat === "未分类" || rawCat === "未分组") ? "未分组" : rawCat.trim();
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({ ...item, _isFav: true });
        });

        // 排序规则：【未分组】常驻置顶，其余分类按名称字母顺序排序
        const catNames = Object.keys(grouped).sort((a, b) => {
            if (a === "未分组") return -1;
            if (b === "未分组") return 1;
            return a.localeCompare(b);
        });

        catNames.forEach(catName => {
            const groupItems = grouped[catName];
            const groupBlock = createCategoryGroupBlock(catName, groupItems);
            container.appendChild(groupBlock);
        });
    }

    /* ========================================================
     * 区块 2: 分组手风琴容器生成 (支持嵌套歌单卡片与长按菜单)
     * ======================================================== */
    function createCategoryGroupBlock(catName, items) {
        const groupSecId = `lib_cat_${catName}`;
        const isGroupOpen = expandedLibraryGroups.has(groupSecId);

        const groupDiv = document.createElement("div");
        groupDiv.className = "library-group-container";
        groupDiv.id = groupSecId;

        const groupRow = document.createElement("div");
        groupRow.className = `library-group-row ${isGroupOpen ? 'open' : ''}`;

        groupRow.innerHTML = `
            <div class="library-group-left">
                <span class="library-group-arrow ${isGroupOpen ? 'open' : ''}">${isGroupOpen ? iconArrowExpanded : iconArrowCollapsed}</span>
                <span>${escapeHtml(catName)}</span>
                <span class="count-badge">${items.length}</span>
            </div>
        `;

        const groupBody = document.createElement("div");
        groupBody.className = `library-group-body ${isGroupOpen ? 'open' : ''}`;

        groupRow.onclick = () => {
            if (expandedLibraryGroups.has(groupSecId)) {
                expandedLibraryGroups.delete(groupSecId);
                groupBody.classList.remove("open");
                groupRow.classList.remove("open");
                const arrow = groupRow.querySelector(".library-group-arrow");
                if (arrow) {
                    arrow.classList.remove("open");
                    arrow.innerHTML = iconArrowCollapsed;
                }
            } else {
                expandedLibraryGroups.add(groupSecId);
                groupBody.classList.add("open");
                groupRow.classList.add("open");
                const arrow = groupRow.querySelector(".library-group-arrow");
                if (arrow) {
                    arrow.classList.add("open");
                    arrow.innerHTML = iconArrowExpanded;
                }
            }
        };

        // 绑定分组长按菜单 (遵照草图规范与用户指令：未分组不可长按；自定义分组长按仅支持重命名与删除，绝不含新建歌单)
        if (catName !== "未分组") {
            window.ContextMenu?.bind(groupRow, () => {
                return [
                    {
                        icon: "✎",
                        label: "重命名分组",
                        onClick: () => promptRenameCategory(catName)
                    },
                    {
                        icon: "✕",
                        label: "删除分组",
                        danger: true,
                        onClick: () => promptDeleteCategory(catName, items.length)
                    }
                ];
            });
        }

        // 渲染分类下的卡片
        if (items.length === 0) {
            const emptyHint = document.createElement("div");
            emptyHint.className = "library-empty-hint";
            emptyHint.style.cssText = "padding: 8px 16px; font-size: 11px; color: var(--text-muted); user-select: none;";
            emptyHint.innerText = "暂无歌单";
            groupBody.appendChild(emptyHint);
        } else {
            items.forEach(item => {
                const isCustom = !!item._isCustom;
                const isFav = !!item._isFav;
                const card = window.LeftPanel.createPlaylistCard(item, {
                    isCustom: isCustom,
                    isFav: isFav,
                    onRename: () => promptRenamePlaylist(item, isCustom),
                    onDelete: () => {
                        if (isFav) {
                            window.StorageManager.unfavPlaylist(item.id);
                            window.Shell?.showToast?.(`已移除歌单《${item.name || item.title}》`);
                        } else {
                            window.StorageManager.deleteCustomPlaylist(item.id);
                            window.Shell?.showToast?.(`已删除歌单《${item.title}》`);
                        }
                        renderLibrary();
                    }
                });
                groupBody.appendChild(card);
            });
        }

        groupDiv.appendChild(groupRow);
        groupDiv.appendChild(groupBody);
        return groupDiv;
    }

    /* ========================================================
     * 区块 3: 分组与歌单交互控制 (重命名、删除保护与二次确认)
     * ======================================================== */
    function promptRenameCategory(oldName) {
        if (oldName === "未分组") {
            alert("【未分组】不可重命名");
            return;
        }
        const doRename = (newName) => {
            if (!newName || !newName.trim() || newName.trim() === oldName) return;
            const res = window.StorageManager.renameCategory('all', oldName, newName.trim());
            if (res.ok) {
                window.Shell?.showToast?.(`分组已更名为《${newName.trim()}》`);
                renderLibrary();
            } else {
                alert(res.error || "重命名失败");
            }
        };

        if (window.Shell?.openInputPromptModal) {
            window.Shell.openInputPromptModal({
                title: "✎ 重命名分组",
                desc: `当前分组名称: ${oldName}`,
                defaultValue: oldName,
                onConfirm: doRename
            });
        } else {
            const res = prompt(`将分组 "${oldName}" 重命名为：`, oldName);
            if (res) doRename(res);
        }
    }

    function promptDeleteCategory(catName, itemCount) {
        if (catName === "未分组") {
            alert("【未分组】为根分类，不能删除");
            return;
        }
        if (itemCount > 0) {
            window.Shell?.showToast?.("该组内包含歌单，无法删除");
            alert("该组内包含歌单，无法删除。请先清空或移出组内歌单。");
            return;
        }
        const doDelete = () => {
            const res = window.StorageManager.deleteCategory('all', catName);
            if (res.ok) {
                window.Shell?.showToast?.(`已删除分组《${catName}》`);
                renderLibrary();
            } else {
                alert(res.error || "删除失败");
            }
        };

        if (window.Shell?.openConfirmModal) {
            window.Shell.openConfirmModal({
                title: "✕ 删除分组确认",
                message: `确认删除空分组 "${catName}" 吗？`,
                confirmText: "删除",
                onConfirm: doDelete
            });
        } else {
            if (confirm(`确认删除空分组 "${catName}" 吗？`)) doDelete();
        }
    }

    function promptRenamePlaylist(item, isCustom) {
        const curName = item.title || item.name || "未命名歌单";
        const doRename = (newName) => {
            if (!newName || !newName.trim() || newName.trim() === curName) return;
            const targetName = newName.trim();
            if (isCustom) {
                window.StorageManager.renameCustomPlaylist(item.id, targetName);
            } else {
                window.StorageManager.renameFavPlaylist(item.id, targetName);
            }
            window.Shell?.showToast?.(`歌单已更名为《${targetName}》`);
            renderLibrary();
            if (window.RightPanel?.isViewingCustom?.(item.id)) {
                window.RightPanel.updateCurrentCustomTitle?.(targetName);
            }
        };

        if (window.Shell?.openInputPromptModal) {
            window.Shell.openInputPromptModal({
                title: "✎ 重命名歌单",
                desc: `当前歌单名称: ${curName}`,
                defaultValue: curName,
                onConfirm: doRename
            });
        } else {
            const res = prompt("请输入新歌单名称：", curName);
            if (res) doRename(res);
        }
    }

    return {
        init,
        renderLibrary
    };
})();
