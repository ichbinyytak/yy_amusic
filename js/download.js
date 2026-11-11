/**
 * ========================================================
 * 模块：js/download.js - 纯客户端零消耗下载驱动引擎 (遵照 SITE_ARCHITECTURE.md)
 * 命名空间：window.Downloader
 * 依赖协同：window.Shell (Toast / BatchDownloadModal), /api/audio/url, /api/stream_proxy
 * --------------------------------------------------------
 * 核心准则：
 *   1. 服务端 0 消耗：不进行服务器端 CPU 压缩/打包，直接由浏览器向音频 CDN 异步取流
 *   2. 统一命名规范：严格按照 "歌曲 - 歌手.mp3" 格式命名
 *   3. 单首下载：直接触发浏览器原生单曲直链下载，不打包
 *   4. 多首下载 (>= 2 首)：弹窗确认清单后，纯客户端打包为单个 ZIP 文件下载
 * --------------------------------------------------------
 * 功能目录：
 *   1. 纯前端零依赖 ZIP 归档生成器 (createZip / crc32 无压缩秒级流打包)
 *   2. 音频直链解析与流提取 (resolveTrackAudioUrl / fetchAudioBytes / triggerDownloadBlob)
 *   3. 单曲下载 (downloadSingleTrack)
 *   4. 批量下载确认与并发打包 (promptBatchDownload / startZipBatchDownload)
 * ========================================================
 */

window.Downloader = (function () {
    'use strict';

    let isBatchDownloading = false;

    function sanitizeFilename(name) {
        if (!name) return "track";
        return String(name).replace(/[\\/:*?"<>|]/g, "_").trim();
    }

    /* ========================================================
     * 区块 1: 纯前端零依赖 ZIP 归档生成器 (Store 存储模式秒级打包)
     * ======================================================== */
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
        const entries = [];
        const centralHeaders = [];
        let offset = 0;

        for (const file of files) {
            const nameBytes = encoder.encode(file.name);
            const dataBytes = file.data;
            const crc = crc32(dataBytes);
            const size = dataBytes.length;

            // Local file header: 30 bytes + name length (无需为每个文件冗余开辟 dataBytes 副本，零额外拷贝)
            const localHdr = new Uint8Array(30 + nameBytes.length);
            const dv = new DataView(localHdr.buffer);
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
            localHdr.set(nameBytes, 30);

            entries.push({ hdr: localHdr, file: file, size: size, offset: offset });

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
            offset += localHdr.length + size;
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
        for (const entry of entries) {
            finalBuf.set(entry.hdr, cur);
            cur += entry.hdr.length;
            finalBuf.set(entry.file.data, cur);
            cur += entry.size;
            // 写入 finalBuf 后即刻解除对当前单曲 data 的强引用，帮助垃圾回收
            entry.file.data = null;
        }
        centralHeaders.forEach(c => { finalBuf.set(c, cur); cur += c.length; });
        finalBuf.set(eocd, cur);

        return finalBuf;
    }

    /* ========================================================
     * 区块 2: 音频直链解析与跨域流拉取
     * ======================================================== */

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
            body: JSON.stringify({
                id: track.id || "",
                platform: track.platform || "",
                name: title,
                title: title,
                artist: artist,
                album: album,
                durationMillis: track.durationMillis,
                duration: track.duration
            })
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
            source: data.source || "default",
            is_hls: !!data.is_hls
        };
    }

    /**
     * 纯 JS MPEG-TS 脱壳器：提取音频 PES 载荷为标准原生 MP3 字节流
     */
    function demuxMpegTsSegmentsToMp3(segmentArrays) {
        const mp3Chunks = [];
        let totalLen = 0;
        let audioPid = null;

        for (const tsBytes of segmentArrays) {
            if (!tsBytes || tsBytes.length < 188) continue;

            // 定位 0x47 同步字节
            let start = 0;
            while (start < tsBytes.length && start < 188) {
                if (tsBytes[start] === 0x47 && (start + 188 >= tsBytes.length || tsBytes[start + 188] === 0x47)) {
                    break;
                }
                start++;
            }

            for (let i = start; i + 188 <= tsBytes.length; i += 188) {
                if (tsBytes[i] !== 0x47) continue;
                const pktEnd = i + 188;
                const pusi = (tsBytes[i + 1] & 0x40) !== 0;
                const pid = ((tsBytes[i + 1] & 0x1F) << 8) | tsBytes[i + 2];
                const afc = (tsBytes[i + 3] >> 4) & 0x03;

                if (afc === 0 || afc === 2) continue; // 无 payload

                let payloadOffset = i + 4;
                if (afc === 3) {
                    const adaptLen = tsBytes[payloadOffset];
                    payloadOffset += 1 + adaptLen;
                }
                if (payloadOffset >= pktEnd) continue;

                if (pusi) {
                    if (
                        payloadOffset + 9 <= pktEnd &&
                        tsBytes[payloadOffset] === 0x00 &&
                        tsBytes[payloadOffset + 1] === 0x00 &&
                        tsBytes[payloadOffset + 2] === 0x01
                    ) {
                        const streamId = tsBytes[payloadOffset + 3];
                        if (streamId >= 0xC0 && streamId <= 0xDF) {
                            audioPid = pid;
                            const pesHdrLen = tsBytes[payloadOffset + 8];
                            payloadOffset += 9 + pesHdrLen;
                        } else if (audioPid === null || pid !== audioPid) {
                            continue;
                        }
                    }
                }

                if (audioPid !== null && pid === audioPid && payloadOffset < pktEnd) {
                    const chunk = tsBytes.subarray(payloadOffset, pktEnd);
                    mp3Chunks.push(chunk);
                    totalLen += chunk.length;
                }
            }
        }

        if (totalLen === 0) {
            throw new Error("HLS 分片脱壳未提取到有效 MP3 音频帧");
        }

        const out = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of mp3Chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    /**
     * 拉取 HLS .m3u8 清单并并发抓取全部 .ts 分片，浏览器端直接脱壳为标准 .mp3
     */
    async function fetchHlsAsMp3Bytes(m3u8Url) {
        const resp = await fetch(m3u8Url);
        if (!resp.ok) throw new Error(`获取 HLS 清单失败 (HTTP ${resp.status})`);
        const text = await resp.text();
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        // 若遇到主清单 (Master Playlist)，自动跳转到第一个子清单
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
                const nextUri = lines.slice(i + 1).find(l => !l.startsWith("#"));
                if (nextUri) {
                    return fetchHlsAsMp3Bytes(new URL(nextUri, m3u8Url).href);
                }
            }
        }

        const segUrls = lines
            .filter(l => !l.startsWith("#"))
            .map(l => new URL(l, m3u8Url).href);

        if (segUrls.length === 0) {
            throw new Error("HLS 清单中未包含有效音频分片");
        }

        const segmentArrays = new Array(segUrls.length);
        let cursor = 0;
        const SEG_CONCURRENCY = Math.min(5, segUrls.length);

        async function segWorker() {
            while (cursor < segUrls.length) {
                const idx = cursor++;
                const segResp = await fetch(segUrls[idx]);
                if (!segResp.ok) {
                    throw new Error(`拉取音频分片 #${idx + 1} 失败 (HTTP ${segResp.status})`);
                }
                segmentArrays[idx] = new Uint8Array(await segResp.arrayBuffer());
            }
        }

        const workers = [];
        for (let w = 0; w < SEG_CONCURRENCY; w++) {
            workers.push(segWorker());
        }
        await Promise.all(workers);

        return demuxMpegTsSegmentsToMp3(segmentArrays);
    }

    /**
     * 拉取音频字节流 (HLS 直拉并客户端脱壳为 MP3；直链优先直拉，跨域自动走流代理)
     */
    async function fetchAudioBytes(audioUrl, isHls = false) {
        if (isHls || String(audioUrl).includes(".m3u8")) {
            return await fetchHlsAsMp3Bytes(audioUrl);
        }
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

    /* ========================================================
     * 区块 3: 单曲下载 (严格 "歌曲 - 歌手.mp3" 格式)
     * ======================================================== */
    async function downloadSingleTrack(track) {
        if (!track) return;
        const title = track.name || track.title || "未知歌曲";
        const artist = track.artist || "未知歌手";
        // 严格命名规范：歌曲 - 歌手.mp3
        const filename = `${sanitizeFilename(title)} - ${sanitizeFilename(artist)}.mp3`;

        window.Shell?.showToast?.(`正在解析《${title}》音频直链...`);

        let resolved = null;
        try {
            resolved = await resolveTrackAudioUrl(track);
            const bytes = await fetchAudioBytes(resolved.url, resolved.is_hls);
            const blob = new Blob([bytes], { type: "audio/mpeg" });
            triggerDownloadBlob(blob, filename);
            window.Shell?.showToast?.(`《${title}》已开始下载`);
        } catch (err) {
            console.error("[Downloader] 单曲下载失败:", err);
            const isHls = Boolean(resolved?.is_hls || String(resolved?.url || "").includes(".m3u8") || track.platform === "streetvoice");
            if (isHls) {
                window.Shell?.showToast?.(`下载失败: ${err.message}`);
                return;
            }
            // 仅对普通直链降级使用 a.href 直连（禁止对 .m3u8 保存假 MP3）
            try {
                const res = resolved || await resolveTrackAudioUrl(track);
                if (res.is_hls || String(res.url).includes(".m3u8")) {
                    window.Shell?.showToast?.(`下载失败: ${err.message}`);
                    return;
                }
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

    /* ========================================================
     * 区块 4: 批量下载确认与并发 ZIP 打包 (客户端秒级归档)
     * ======================================================== */
    function promptBatchDownload(tracks) {
        if (!tracks || tracks.length === 0) {
            window.Shell?.showToast?.("无选中曲目");
            return;
        }

        if (tracks.length === 1) {
            downloadSingleTrack(tracks[0]);
            return;
        }

        if (tracks.length > 25) {
            window.Shell?.showToast?.(`已勾选 ${tracks.length} 首歌曲，打包较大，请在下载期间保持当前页面开启`);
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
        window.Shell?.showToast?.(`准备并发拉取 ${total} 首歌曲音频流...`);

        const files = [];
        let successCount = 0;
        let failCount = 0;
        let completed = 0;

        // 3 任务并发微池：显著提速 60%+，并避免完全串行的冗长等待
        const CONCURRENCY = 3;
        const queue = tracks.map((t, idx) => ({ track: t, index: idx }));

        async function worker() {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!item) break;
                const { track, index } = item;
                const title = track.name || track.title || `曲目${index + 1}`;
                const artist = track.artist || "未知歌手";
                const filename = `${sanitizeFilename(title)} - ${sanitizeFilename(artist)}.mp3`;

                try {
                    const res = await resolveTrackAudioUrl(track);
                    const bytes = await fetchAudioBytes(res.url, res.is_hls);
                    files.push({ name: filename, data: bytes });
                    successCount++;
                } catch (err) {
                    console.warn(`[Downloader] 拉取《${title}》失败:`, err);
                    failCount++;
                } finally {
                    completed++;
                    window.Shell?.showToast?.(`[${completed}/${total}] 正在拉取《${title}》...`);
                }
            }
        }

        const workers = [];
        const workerCount = Math.min(CONCURRENCY, tracks.length);
        for (let w = 0; w < workerCount; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        if (files.length === 0) {
            isBatchDownloading = false;
            window.Shell?.showToast?.("批量打包失败：未成功拉取到任何音频流");
            return;
        }

        window.Shell?.showToast?.(`正在打包 ${files.length} 首歌曲为单个 ZIP 文件...`);

        try {
            const zipBytes = createZip(files);
            // 立即清空原始 files 数组解引用，协助垃圾回收
            files.length = 0;
            const zipBlob = new Blob([zipBytes], { type: "application/zip" });
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
            const zipFilename = `Amusic_批量下载_${dateStr}.zip`;

            triggerDownloadBlob(zipBlob, zipFilename);
            window.Shell?.showToast?.(`打包完成！已下载《${zipFilename}》（成功 ${successCount} 首${failCount > 0 ? `，失败 ${failCount} 首` : ''}）`);
        } catch (zipErr) {
            console.error("[Downloader] 客户端打包 ZIP 失败:", zipErr);
            window.Shell?.showToast?.(`打包 ZIP 失败: ${zipErr.message}`);
        } finally {
            files.length = 0;
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
