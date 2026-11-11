/**
 * ========================================================
 * 模块：js/backup.js - 数据备份与恢复控制器 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.BackupManager
 * 依赖协同：window.StorageManager, window.Shell (Toast), window.LibraryPanel
 * --------------------------------------------------------
 * 纯符号极简设计：
 *   ↑ 导出备份 JSON
 *   ↓ 导入恢复 JSON
 * --------------------------------------------------------
 * 功能目录：
 *   1. 一键全量导出 (exportData)
 *   2. 本地文件导入恢复 (triggerImport)
 *   3. 备份操作栏渲染 (renderBackupSection)
 * ========================================================
 */

window.BackupManager = (function () {
    'use strict';

    /* ========================================================
     * 区块 1: 一键全量导出备份数据 (JSON Blob 下载)
     * ======================================================== */
    function exportData() {
        const jsonStr = window.StorageManager.exportBackup();
        if (!jsonStr || typeof jsonStr !== 'string') {
            console.error("[BackupManager] 导出数据异常，未获取到合法的 JSON 字符串");
            window.Shell?.showToast?.("导出失败，数据异常");
            return;
        }
        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const filename = `amusic_backup_${dateStr}.json`;

        try {
            const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.style.display = "none";
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 1000);
            window.Shell?.showToast?.("备份数据已成功导出");
        } catch (err) {
            console.error("[BackupManager] 导出失败:", err);
            window.Shell?.showToast?.("导出失败，请重试");
        }
    }

    /* ========================================================
     * 区块 2: 本地 JSON 备份异步读取与还原合并
     * ======================================================== */
    function triggerImport() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";

        input.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const text = event.target.result;
                const res = window.StorageManager.importBackup(text);
                if (res.ok) {
                    window.Shell?.showToast?.(`恢复成功: ${res.customCount} 个自建歌单, ${res.favCount} 个收藏`);
                    // 重新刷新左侧音乐库
                    window.LibraryPanel?.renderLibrary?.();
                } else {
                    window.Shell?.showToast?.(`恢复失败: ${res.error}`);
                }
            };
            reader.onerror = () => {
                window.Shell?.showToast?.("读取备份文件失败");
            };
            reader.readAsText(file, "utf-8");
        };

        document.body.appendChild(input);
        input.click();
        setTimeout(() => document.body.removeChild(input), 1000);
    }

    return {
        exportData,
        triggerImport
    };
})();
