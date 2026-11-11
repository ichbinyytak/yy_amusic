/**
 * ========================================================
 * 模块：js/theme.js - 多主题切换管理器 (遵照 architecture-theme.md)
 * 命名空间：window.ThemeManager
 * 依赖协同：localStorage (amusic_theme), index.html 顶部防闪烁内联脚本, css/base.css 主题变量
 * --------------------------------------------------------
 * 核心能力：
 *   1. 7 套主题元数据管理 (dark / midnight / light / sky / warm / mint / pink)
 *   2. 顶栏主题按钮与色块下拉菜单渲染、外部点击 / ESC 自动收起
 *   3. 主题即时切换与 localStorage 持久化（无闪烁、零外部依赖）
 * ========================================================
 */

window.ThemeManager = (function () {
    'use strict';

    const STORAGE_KEY = "amusic_theme";
    const DEFAULT_THEME = "dark";

    const THEMES = [
        { id: "dark",     name: "暗夜黑",   type: "dark",  bg: "#0d1117", surface: "#161b22", accent: "#58a6ff" },
        { id: "midnight", name: "午夜深蓝", type: "dark",  bg: "#0b1120", surface: "#131c31", accent: "#38bdf8" },
        { id: "light",    name: "极简纯白", type: "light", bg: "#f5f5f7", surface: "#ffffff", accent: "#0071e3" },
        { id: "sky",      name: "晴空浅蓝", type: "light", bg: "#edf5fc", surface: "#ffffff", accent: "#0969da" },
        { id: "warm",     name: "护眼暖米", type: "light", bg: "#f6f1e7", surface: "#fbf8f1", accent: "#b45309" },
        { id: "mint",     name: "薄荷浅绿", type: "light", bg: "#eef7f3", surface: "#ffffff", accent: "#1a7f37" },
        { id: "pink",     name: "樱花浅粉", type: "light", bg: "#fdf2f6", surface: "#ffffff", accent: "#db2777" }
    ];

    const VALID_IDS = new Set(THEMES.map(t => t.id));
    let initialized = false;

    function normalizeThemeId(themeId) {
        return VALID_IDS.has(themeId) ? themeId : DEFAULT_THEME;
    }

    function getCurrentTheme() {
        const attr = document.documentElement.dataset.theme;
        if (VALID_IDS.has(attr)) return attr;
        try {
            return normalizeThemeId(localStorage.getItem(STORAGE_KEY));
        } catch (e) {
            return DEFAULT_THEME;
        }
    }

    function renderMenu(activeId) {
        const menu = document.getElementById("themeDropdownMenu");
        if (!menu) return;

        menu.innerHTML = THEMES.map(t => {
            const isActive = t.id === activeId;
            return `
                <button type="button"
                    class="theme-dropdown-item ${isActive ? 'active' : ''}"
                    data-theme-id="${t.id}"
                    role="menuitemradio"
                    aria-checked="${isActive ? 'true' : 'false'}">
                    <span class="theme-swatch" style="background: linear-gradient(135deg, ${t.bg} 50%, ${t.accent} 50%);"></span>
                    <span class="theme-item-name">${t.name}</span>
                    <span class="theme-item-check">${isActive ? '✓' : ''}</span>
                </button>
            `;
        }).join("");
    }

    function closeMenu() {
        const wrapper = document.getElementById("themeSwitcherWrapper");
        const toggleBtn = document.getElementById("btnThemeToggle");
        if (wrapper) wrapper.classList.remove("open");
        if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
    }

    function toggleMenu() {
        const wrapper = document.getElementById("themeSwitcherWrapper");
        const toggleBtn = document.getElementById("btnThemeToggle");
        if (!wrapper) return;
        const isOpen = wrapper.classList.toggle("open");
        if (toggleBtn) toggleBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    function applyTheme(themeId, options = {}) {
        const validId = normalizeThemeId(themeId);
        document.documentElement.dataset.theme = validId;

        try {
            localStorage.setItem(STORAGE_KEY, validId);
        } catch (e) {}

        renderMenu(validId);

        if (!options.keepOpen) {
            closeMenu();
        }

        if (!options.silent) {
            const meta = THEMES.find(t => t.id === validId);
            if (meta && window.Shell?.showToast) {
                window.Shell.showToast(`已切换主题：${meta.name}`);
            }
        }
        return validId;
    }

    function init() {
        const activeId = getCurrentTheme();
        document.documentElement.dataset.theme = activeId;
        renderMenu(activeId);

        if (initialized) return;
        initialized = true;

        const wrapper = document.getElementById("themeSwitcherWrapper");
        const toggleBtn = document.getElementById("btnThemeToggle");
        const menu = document.getElementById("themeDropdownMenu");

        toggleBtn?.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        menu?.addEventListener("click", (e) => {
            const item = e.target.closest(".theme-dropdown-item[data-theme-id]");
            if (!item) return;
            e.stopPropagation();
            const chosen = item.getAttribute("data-theme-id");
            applyTheme(chosen);
        });

        document.addEventListener("click", (e) => {
            if (wrapper && wrapper.classList.contains("open") && !wrapper.contains(e.target)) {
                closeMenu();
            }
        });

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                closeMenu();
            }
        });
    }

    return {
        THEMES,
        init,
        applyTheme,
        getCurrentTheme,
        closeMenu
    };
})();
