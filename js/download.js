/**
 * ========================================================
 * js/download.js - 纯客户端零消耗下载驱动引擎 (遵照 SITE_ARCHITECTURE.md)
 * 核心准则：
 * 1. 服务端 0 消耗：不进行服务器端 CPU 压缩/打包，直接由浏览器向音频 CDN 异步取流并保存
 * 2. 单曲下载：自动格式化为 "歌手 - 歌名.mp3"
 * 3. 整单/批量下载：采用纯客户端轻量有序队列轮询下载 (单曲间隔 500ms)，无需额外第三方打包库
 * ========================================================
 */

window.Downloader = (function () {
    'use strict';

    let isBatchDownloading = false;

    function sanitizeFilename(name) {
        if (!name) return "track";
        return String(name).replace(/[\\/:*?"<>|]/g, "_").trim();
    }

    /**
     * 解析并获取单曲直接可播音频直链 (调用服务端双核并发冲刺引擎)
     */
    async function resolveTrackAudioUrl(track) {
        const title = track.name || track.title || "";
        const artist = track.artist || "";
        const album = track.album || "";

        const resp = await fetch("/api/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: title, title: title, artist: artist, album: album })
        });
        if (!resp.ok) {
            throw new Error(`获取音频直链失败 (HTTP ${resp.status})`);
        }
        const data = await resp.json();
        if (!data || !data.success || !data.url) {
            throw new Error(data.error || "未匹配到可用的音频直链");
        }
        return {
            url: data.url,
            bitrate: data.bitrate || "128k",
            source: data.source || "default"
        };
    }

    /**
     * 触发浏览器原生下载文件
     */
    async function triggerBrowserDownload(audioUrl, filename) {
        try {
            const resp = await fetch(audioUrl);
            if (!resp.ok) throw new Error("取流失败");
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.style.display = "none";
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 1000);
        } catch (e) {
            // 如果遇到跨域 fetch 限制，降级为直接打开/触发
            const a = document.createElement("a");
            a.style.display = "none";
            a.href = audioUrl;
            a.target = "_blank";
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => document.body.removeChild(a), 1000);
        }
    }

    /**
     * 下载单曲
     */
    async function downloadSingleTrack(track) {
        if (!track) return;
        const artist = track.artist || "未知歌手";
        const title = track.name || track.title || "未知歌曲";
        const filename = `${sanitizeFilename(artist)} - ${sanitizeFilename(title)}.mp3`;

        window.Shell?.showToast?.(`正在解析《${title}》音频直链...`);

        try {
            const res = await resolveTrackAudioUrl(track);
            await triggerBrowserDownload(res.url, filename);
            window.Shell?.showToast?.(`《${title}》已开始下载`);
        } catch (err) {
            console.error("[Downloader] 下载失败:", err);
            window.Shell?.showToast?.(`下载失败: ${err.message}`);
        }
    }

    /**
     * 批量队列下载 (每首间隔 500ms，纯客户端队列驱动)
     */
    async function downloadBatchTracks(tracks) {
        if (!tracks || tracks.length === 0) {
            window.Shell?.showToast?.("无可选曲目下载");
            return;
        }

        if (isBatchDownloading) {
            window.Shell?.showToast?.("已有批量下载任务在进行中，请稍候...");
            return;
        }

        isBatchDownloading = true;
        const total = tracks.length;
        window.Shell?.showToast?.(`开始批量下载共 ${total} 首歌曲...`);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const title = track.name || track.title || `第${i+1}首`;
            const artist = track.artist || "未知歌手";
            const filename = `${sanitizeFilename(artist)} - ${sanitizeFilename(title)}.mp3`;

            window.Shell?.showToast?.(`[${i + 1}/${total}] 正在拉取《${title}》...`);

            try {
                const res = await resolveTrackAudioUrl(track);
                await triggerBrowserDownload(res.url, filename);
                successCount++;
            } catch (err) {
                console.warn(`[Downloader] 曲目《${title}》下载跳过:`, err);
                failCount++;
            }

            // 间隔 500ms 避免浏览器安全机制拦截多并发下载弹窗
            if (i < tracks.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        isBatchDownloading = false;
        window.Shell?.showToast?.(`批量下载完成: 成功 ${successCount} 首，失败 ${failCount} 首`);
    }

    return {
        downloadSingleTrack,
        downloadBatchTracks
    };
})();
