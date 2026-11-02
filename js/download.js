/**
 * ========================================================
 * js/download.js - 纯客户端零消耗下载驱动引擎 (遵照 SITE_ARCHITECTURE.md)
 * 核心准则：
 * 1. 服务端 0 消耗：不进行服务器端 CPU 压缩/打包，直接由浏览器向音频 CDN 异步取流
 * 2. 统一命名规范：严格按照 "歌曲 - 歌手.mp3" 格式命名
 * 3. 单首下载：直接触发浏览器原生单曲直链下载，不打包
 * 4. 多首下载 (>= 2 首)：弹窗确认清单后，纯客户端打包为单个 ZIP 文件下载，包内统一 "歌曲 - 歌手.mp3"
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
     * 纯前端零依赖 ZIP 归档生成器 (基于规范的 Store 零压缩存储，0 CPU 消耗，毫秒级即时打包)
     */
    function createZip(files) {
        const crcTable = (function () {
            let c, table = [];
            for (let n = 0; n < 256; n++) {
                c = n;
                for (let k = 0; k < 8; k++) {
                    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
                }
                table[n] = c;
            }
            return table;
        })();

        function crc32(buf) {
            let crc = 0 ^ (-1);
            for (let i = 0; i < buf.length; i++) {
                crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
            }
            return (crc ^ (-1)) >>> 0;
        }

        const encoder = new TextEncoder();
        const localHeaders = [];
        const centralHeaders = [];
        let offset = 0;

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const dataBytes = file.data;
            const crc = crc32(dataBytes);
            const size = dataBytes.length;

            // Local file header: 30 bytes + name length + data length
            const local = new Uint8Array(30 + nameBytes.length + size);
            const dv = new DataView(local.buffer);
            dv.setUint32(0, 0x04034b50, true);
            dv.setUint16(4, 20, true); // Version needed
            dv.setUint16(6, 0x0800, true); // UTF-8 filename flag
            dv.setUint16(8, 0, true); // Compression: Store (0)
            dv.setUint16(10, 0, true); // File mod time
            dv.setUint16(12, 0, true); // File mod date
            dv.setUint32(14, crc, true);
            dv.setUint32(18, size, true);
            dv.setUint32(22, size, true);
            dv.setUint16(26, nameBytes.length, true);
            dv.setUint16(28, 0, true); // Extra field len
            local.set(nameBytes, 30);
            local.set(dataBytes, 30 + nameBytes.length);

            localHeaders.push(local);

            // Central directory header: 46 bytes + name length
            const central = new Uint8Array(46 + nameBytes.length);
            const cdv = new DataView(central.buffer);
            cdv.setUint32(0, 0x02014b50, true);
            cdv.setUint16(4, 20, true);
            cdv.setUint16(6, 20, true);
            cdv.setUint16(8, 0x0800, true);
            cdv.setUint16(10, 0, true);
            cdv.setUint16(12, 0, true);
            cdv.setUint16(14, 0, true);
            cdv.setUint32(16, crc, true);
            cdv.setUint32(20, size, true);
            cdv.setUint32(24, size, true);
            cdv.setUint16(28, nameBytes.length, true);
            cdv.setUint16(30, 0, true);
            cdv.setUint16(32, 0, true);
            cdv.setUint16(34, 0, true);
            cdv.setUint16(36, 0, true);
            cdv.setUint32(38, 0, true);
            cdv.setUint32(42, offset, true);
            central.set(nameBytes, 46);

            centralHeaders.push(central);
            offset += local.length;
        }

        const cdOffset = offset;
        let cdSize = 0;
        centralHeaders.forEach(c => cdSize += c.length);

        // End of central directory record: 22 bytes
        const eocd = new Uint8Array(22);
        const edv = new DataView(eocd.buffer);
        edv.setUint32(0, 0x06054b50, true);
        edv.setUint16(4, 0, true);
        edv.setUint16(6, 0, true);
        edv.setUint16(8, files.length, true);
        edv.setUint16(10, files.length, true);
        edv.setUint32(12, cdSize, true);
        edv.setUint32(16, cdOffset, true);
        edv.setUint16(20, 0, true);

        const totalLen = cdOffset + cdSize + 22;
        const finalBuf = new Uint8Array(totalLen);
        let cur = 0;
        localHeaders.forEach(l => { finalBuf.set(l, cur); cur += l.length; });
        centralHeaders.forEach(c => { finalBuf.set(c, cur); cur += c.length; });
        finalBuf.set(eocd, cur);

        return finalBuf;
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
     * 拉取音频字节流 (优先直接拉取，遇到跨域 CORS 时自动走无内存中继拉取)
     */
    async function fetchAudioBytes(audioUrl) {
        try {
            const resp = await fetch(audioUrl);
            if (resp.ok) {
                const buf = await resp.arrayBuffer();
                return new Uint8Array(buf);
            }
        } catch (e) {
            // CORS 限制或网络异常，走轻量流代理
        }
        const proxyUrl = `/api/stream_proxy?url=${encodeURIComponent(audioUrl)}`;
        const resp2 = await fetch(proxyUrl);
        if (!resp2.ok) throw new Error(`拉取音频流失败 (HTTP ${resp2.status})`);
        const buf2 = await resp2.arrayBuffer();
        return new Uint8Array(buf2);
    }

    /**
     * 触发浏览器原生保存文件
     */
    function triggerDownloadBlob(blob, filename) {
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
        }, 2000);
    }

    /**
     * 1. 单曲下载（不打包，命名：歌曲 - 歌手.mp3）
     */
    async function downloadSingleTrack(track) {
        if (!track) return;
        const title = track.name || track.title || "未知歌曲";
        const artist = track.artist || "未知歌手";
        // 严格命名规范：歌曲 - 歌手.mp3
        const filename = `${sanitizeFilename(title)} - ${sanitizeFilename(artist)}.mp3`;

        window.Shell?.showToast?.(`正在解析《${title}》音频直链...`);

        try {
            const res = await resolveTrackAudioUrl(track);
            const bytes = await fetchAudioBytes(res.url);
            const blob = new Blob([bytes], { type: "audio/mpeg" });
            triggerDownloadBlob(blob, filename);
            window.Shell?.showToast?.(`《${title}》已开始下载`);
        } catch (err) {
            console.error("[Downloader] 单曲下载失败:", err);
            // 降级使用 a.href 直连
            try {
                const res = await resolveTrackAudioUrl(track);
                const a = document.createElement("a");
                a.style.display = "none";
                a.href = res.url;
                a.target = "_blank";
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => document.body.removeChild(a), 1000);
            } catch (e2) {
                window.Shell?.showToast?.(`下载失败: ${err.message}`);
            }
        }
    }

    /**
     * 2. 批量下载入口（单首直接下，多首出清单确认弹窗）
     */
    function promptBatchDownload(tracks) {
        if (!tracks || tracks.length === 0) {
            window.Shell?.showToast?.("无选中曲目");
            return;
        }

        if (tracks.length === 1) {
            downloadSingleTrack(tracks[0]);
            return;
        }

        // 多首歌曲 (>= 2 首)：在下载前出弹窗让用户确认歌曲清单
        window.Shell?.openBatchDownloadModal?.(tracks);
    }

    /**
     * 3. 用户确认后执行客户端统一打包 ZIP 下载
     */
    async function startZipBatchDownload(tracks) {
        if (!tracks || tracks.length === 0) return;

        if (isBatchDownloading) {
            window.Shell?.showToast?.("已有打包下载任务在进行中，请稍候...");
            return;
        }

        isBatchDownloading = true;
        const total = tracks.length;
        window.Shell?.showToast?.(`准备拉取 ${total} 首歌曲音频流...`);

        const files = [];
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const title = track.name || track.title || `曲目${i + 1}`;
            const artist = track.artist || "未知歌手";
            // 严格统一按 歌曲 - 歌手.mp3 命名
            const filename = `${sanitizeFilename(title)} - ${sanitizeFilename(artist)}.mp3`;

            window.Shell?.showToast?.(`[${i + 1}/${total}] 正在拉取《${title}》...`);

            try {
                const res = await resolveTrackAudioUrl(track);
                const bytes = await fetchAudioBytes(res.url);
                files.push({ name: filename, data: bytes });
                successCount++;
            } catch (err) {
                console.warn(`[Downloader] 拉取《${title}》失败:`, err);
                failCount++;
            }
        }

        if (files.length === 0) {
            isBatchDownloading = false;
            window.Shell?.showToast?.("批量打包失败：未成功拉取到任何音频流");
            return;
        }

        window.Shell?.showToast?.(`正在打包 ${files.length} 首歌曲为单个 ZIP 文件...`);

        try {
            const zipBytes = createZip(files);
            const zipBlob = new Blob([zipBytes], { type: "application/zip" });
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
            const zipFilename = `Amusic_批量下载_${dateStr}.zip`;

            triggerDownloadBlob(zipBlob, zipFilename);
            window.Shell?.showToast?.(`打包完成！已下载《${zipFilename}》（成功 ${successCount} 首${failCount > 0 ? `，失败 ${failCount} 首` : ''}）`);
        } catch (zipErr) {
            console.error("[Downloader] 客户端打包 ZIP 失败:", zipErr);
            window.Shell?.showToast?.(`打包 ZIP 失败: ${zipErr.message}`);
        } finally {
            isBatchDownloading = false;
        }
    }

    return {
        downloadSingleTrack,
        promptBatchDownload,
        startZipBatchDownload,
        downloadBatchTracks: promptBatchDownload
    };
})();
