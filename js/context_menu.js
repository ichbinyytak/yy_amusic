/**
 * js/context_menu.js - YY-Amusic 全站通用轻量单例上下文菜单引擎 (遵照 SITE_ARCHITECTURE.md)
 * 1. 桌面端鼠标右键 (contextmenu)
 * 2. 触屏端长按 500ms (支持移动阈值防误触)
 * 3. 单例 DOM 动态复用，零冗余开销
 */

window.ContextMenu = (function () {
    'use strict';

    let menuEl = null;

    function getMenuElement() {
        if (!menuEl) {
            menuEl = document.createElement("div");
            menuEl.className = "context-menu-popup";
            menuEl.id = "globalContextMenu";
            document.body.appendChild(menuEl);

            // 点击外部自动关闭
            document.addEventListener("click", (e) => {
                if (menuEl && menuEl.classList.contains("open") && !menuEl.contains(e.target)) {
                    hide();
                }
            }, true);

            // ESC 键关闭
            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape") hide();
            });

            // 滚动时关闭
            window.addEventListener("scroll", hide, true);
        }
        return menuEl;
    }

    function hide() {
        if (menuEl) {
            menuEl.classList.remove("open");
            menuEl.innerHTML = "";
        }
    }

    /**
     * 显示上下文菜单
     * @param {Array<{icon?: string, label: string, onClick: Function, danger?: boolean, separator?: boolean}>} items
     * @param {number} x
     * @param {number} y
     */
    function show(items, x, y) {
        if (!items || items.length === 0) return;
        const el = getMenuElement();
        el.innerHTML = "";

        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement("div");
                sep.className = "context-menu-separator";
                el.appendChild(sep);
                return;
            }

            const btn = document.createElement("button");
            btn.className = `context-menu-item ${item.danger ? 'danger' : ''}`;
            btn.innerHTML = `
                <span class="context-menu-icon">${item.icon || ''}</span>
                <span class="context-menu-label">${item.label || ''}</span>
            `;
            btn.onclick = (e) => {
                e.stopPropagation();
                hide();
                if (typeof item.onClick === "function") {
                    item.onClick();
                }
            };
            el.appendChild(btn);
        });

        el.classList.add("open");

        // 视口边界防溢出计算
        const rect = el.getBoundingClientRect();
        const winW = window.innerWidth;
        const winH = window.innerHeight;

        let posX = x;
        let posY = y;

        if (posX + rect.width > winW - 8) {
            posX = Math.max(8, winW - rect.width - 8);
        }
        if (posY + rect.height > winH - 8) {
            posY = Math.max(8, winH - rect.height - 8);
        }

        el.style.left = `${Math.round(posX)}px`;
        el.style.top = `${Math.round(posY)}px`;
    }

    /**
     * 绑定目标元素：触屏 500ms 长按与鼠标右键
     * @param {HTMLElement} element
     * @param {Function} getItemsFn () => Array<Item>
     */
    function bind(element, getItemsFn) {
        if (!element) return;

        let touchTimer = null;
        let startX = 0;
        let startY = 0;
        let isLongPress = false;

        // 触屏长按 500ms (移动超过 10px 则视同滚动并取消)
        element.addEventListener("touchstart", (e) => {
            if (e.touches.length !== 1) return;
            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            isLongPress = false;

            touchTimer = setTimeout(() => {
                isLongPress = true;
                if (navigator.vibrate) {
                    try { navigator.vibrate(30); } catch (err) {}
                }
                const items = getItemsFn();
                if (items && items.length > 0) {
                    show(items, startX, startY);
                }
            }, 500);
        }, { passive: true });

        element.addEventListener("touchmove", (e) => {
            if (!touchTimer) return;
            const touch = e.touches[0];
            const dist = Math.hypot(touch.clientX - startX, touch.clientY - startY);
            if (dist > 10) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        }, { passive: true });

        element.addEventListener("touchend", (e) => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
            if (isLongPress) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        element.addEventListener("touchcancel", () => {
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        });

        // 桌面端鼠标右键 (contextmenu)
        element.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const items = getItemsFn();
            if (items && items.length > 0) {
                show(items, e.clientX, e.clientY);
            }
        });
    }

    return {
        show,
        hide,
        bind
    };
})();
