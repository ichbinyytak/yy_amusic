/**
 * ========================================================
 * js/backup.js - 数据管理与备份恢复引擎 (遵照 SITE_ARCHITECTURE.md)
 * 纯符号极简：
 * ↑ 导出备份 JSON
 * ↓ 导入恢复 JSON
 * ========================================================
 */

window.BackupManager = (function () {
    'use strict';

    /**
     * 一键导出完整数据为 JSON 备份文件
     */
    function exportData() {
        const jsonStr = window.StorageManager.exportBackup();
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
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

    /**
     * 触发外部 JSON 备份文件导入
     */
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

    /**
     * 渲染“数据管理”手风琴内容
     */
    function renderBackupSection(containerEl) {
        if (!containerEl) return;
        containerEl.innerHTML = `
            <div class="data-backup-row">
                <button class="btn-data-action" onclick="window.BackupManager.exportData()" title="导出备份到本地 JSON 文件">
                    <span>↑</span> 导出备份
                </button>
                <button class="btn-data-action" onclick="window.BackupManager.triggerImport()" title="从本地 JSON 文件还原数据">
                    <span>↓</span> 导入恢复
                </button>
            </div>
        `;
    }

    return {
        exportData,
        triggerImport,
        renderBackupSection
    };
})();
