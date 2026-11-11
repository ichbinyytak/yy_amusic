/**
 * ========================================================
 * 模块：js/utils.js - 前端全局公共工具库
 * 命名空间：window.AmusicUtils
 * 职责：消除跨模块重复的 HTML 转义、时长格式化、分类归一化与折叠图标常量
 * ========================================================
 */
(function (window) {
    'use strict';

    const ICON_ARROW_COLLAPSED = '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>';
    const ICON_ARROW_EXPANDED = '<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>';
    const ICON_ARROW_COLLAPSED_LG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"></polygon></svg>';
    const ICON_ARROW_EXPANDED_LG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="3,6 12,20 21,6"></polygon></svg>';

    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatDuration(millis) {
        if (!millis || isNaN(millis)) return "00:00";
        const totalSec = Math.floor(millis / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }

    function formatTimeSec(sec) {
        if (!sec || isNaN(sec)) return "00:00";
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
    }

    function normalizeCategory(cat) {
        if (!cat || typeof cat !== 'string') return "未分组";
        const trimmed = cat.trim();
        if (!trimmed || trimmed === "默认" || trimmed === "未分类" || trimmed === "未分组") {
            return "未分组";
        }
        return trimmed;
    }

    window.AmusicUtils = {
        ICON_ARROW_COLLAPSED,
        ICON_ARROW_EXPANDED,
        ICON_ARROW_COLLAPSED_LG,
        ICON_ARROW_EXPANDED_LG,
        escapeHtml,
        formatDuration,
        formatTimeSec,
        normalizeCategory
    };
    window.escapeHtml = escapeHtml;
    window.formatDuration = formatDuration;
})(window);
