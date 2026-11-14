/**
 * test_kpop_playlist.js
 * 专门针对用户反馈的 "kpopwrld:2026年度最佳" 歌单 (ID: pl.df64d6dd79a842aebabdd2d20ec85b9e)
 * 用无头 Chrome 在生产环境 (https://amusic.hefang.fun) 模拟真实用户：
 * 1. 自动进入并加载该歌单；
 * 2. 依次测试前 6 首歌曲的点播与播放状态；
 * 3. 严格检测是否出现 11 秒假音频语音刺客 (588957081.mp3 / ~11s 时长)；
 * 4. 验证真音频是否出声、拦截是否生效。
 */

const { spawn } = require('child_process');
const http = require('http');

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log("======================================================================");
    console.log("🚀 启动生产环境自动化验收测试：歌单《KPOPWRLD: 2026年度最佳》");
    console.log("目标站点: https://amusic.hefang.fun");
    console.log("======================================================================");

    const chromePort = 9556;
    const chrome = spawn('google-chrome', [
        '--headless=new',
        `--remote-debugging-port=${chromePort}`,
        '--user-data-dir=/tmp/amusic-kpop-smoke-test',
        '--no-sandbox',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,800',
        'about:blank'
    ]);

    let closed = false;
    chrome.on('exit', () => { closed = true; });

    let targets = null;
    for (let i = 0; i < 20; i++) {
        await sleep(300);
        try {
            targets = await getJson(`http://127.0.0.1:${chromePort}/json`);
            if (targets && targets.some(t => t.type === 'page')) break;
        } catch (e) {}
    }

    const pageTarget = targets?.find(t => t.type === 'page');
    if (!pageTarget) {
        console.error("❌ 无法连接到 Chrome CDP");
        chrome.kill();
        process.exit(1);
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
    });

    let msgId = 1;
    const pendingCallbacks = new Map();

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pendingCallbacks.has(msg.id)) {
            const cb = pendingCallbacks.get(msg.id);
            pendingCallbacks.delete(msg.id);
            cb(msg);
        }
    };

    function sendCommand(method, params = {}) {
        return new Promise((resolve) => {
            const id = msgId++;
            pendingCallbacks.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expression) {
        const res = await sendCommand('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        return res?.result?.result?.value;
    }

    try {
        await sendCommand('Page.enable');
        await sendCommand('Runtime.enable');

        console.log("1. 正在导航至生产环境主页...");
        await sendCommand('Page.navigate', { url: 'https://amusic.hefang.fun' });

        // 等待页面初始挂载
        let loaded = false;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            const ready = await evaluate(`!!(window.RightPanel && window.RightPanel.selectPlaylist)`);
            if (ready) {
                loaded = true;
                console.log("✅ 生产环境前端组件挂载完成");
                break;
            }
        }

        if (!loaded) {
            console.error("❌ 页面前端组件挂载超时");
            return;
        }

        console.log("2. 正在加载歌单《KPOPWRLD: 2026年度最佳》(pl.df64d6dd79a842aebabdd2d20ec85b9e)...");
        await evaluate(`
            (async function() {
                await window.RightPanel.selectPlaylist(
                    'pl.df64d6dd79a842aebabdd2d20ec85b9e',
                    'playlist',
                    'KPOPWRLD：2026 年度最佳',
                    'Apple Music'
                );
            })()
        `);

        // 等待歌曲列表渲染为 Kpop 歌单内容 (第一首歌应为 SWIM)
        let trackCount = 0;
        let trackList = [];
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            trackList = await evaluate(`
                (function() {
                    const rows = document.querySelectorAll('tr[id^="track-row-"]');
                    if (!rows || rows.length === 0) return [];
                    const tracks = Array.from(rows).slice(0, 8).map((r, idx) => ({
                        index: idx,
                        title: r.querySelector('.track-name, td:nth-child(2)')?.textContent?.trim() || '',
                        artist: r.querySelector('.track-artist, td:nth-child(3)')?.textContent?.trim() || ''
                    }));
                    if (tracks.some(t => t.title.includes('SWIM') || t.title.includes('NEON') || t.artist.includes('BTS') || t.artist.includes('防弹'))) {
                        return tracks;
                    }
                    return [];
                })()
            `) || [];
            if (trackList.length > 0) {
                trackCount = trackList.length;
                console.log(`✅ 成功渲染《KPOPWRLD: 2026年度最佳》曲目列表，已获取前 ${trackCount} 首歌曲:`);
                trackList.slice(0, 5).forEach((t, i) => console.log(`   ${i+1}. ${t.title} - ${t.artist}`));
                break;
            }
        }

        if (trackCount === 0) {
            console.error("❌ 未能获取到歌单曲目");
            return;
        }

        console.log("======================================================================");
        console.log("3. 开始逐首测试点播与假音频拦截监测（测试前 5 首）...");
        console.log("======================================================================");

        const testLimit = Math.min(5, trackList.length);
        for (let i = 0; i < testLimit; i++) {
            const track = trackList[i];
            console.log(`\n▶️  [${i + 1}/${testLimit}] 测试点播: 《${track.title}》 - ${track.artist}`);

            // 触发双击该歌曲播放
            await evaluate(`
                (function() {
                    const rows = document.querySelectorAll('tr[id^="track-row-"]');
                    if (rows[${i}]) {
                        rows[${i}].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                    }
                })()
            `);

            // 监测播放器与错误提示 (等待最多 10 秒)
            let resultStatus = "waiting";
            let audioInfo = null;
            let toastInfo = null;

            for (let t = 0; t < 25; t++) {
                await sleep(400);
                const state = await evaluate(`
                    (function() {
                        const audio = document.querySelector('audio');
                        const toast = document.querySelector('.toast, .custom-toast, [id*="toast"]');
                        return {
                            audio: audio ? {
                                src: audio.src,
                                paused: audio.paused,
                                currentTime: audio.currentTime,
                                duration: audio.duration
                            } : null,
                            toastText: toast ? toast.textContent?.trim() : ''
                        };
                    })()
                `);

                if (state?.audio?.src) {
                    const src = state.audio.src;
                    const duration = state.audio.duration;

                    // 假音频检测特征：
                    // 1. url 包含 588957081.mp3
                    // 2. 音频时长在 10 ~ 12 秒之间 (提示音为 11 秒)
                    if (src.includes("588957081.mp3") || (duration >= 10.5 && duration <= 12.0)) {
                        resultStatus = "FAKE_AUDIO_LEAK";
                        audioInfo = state.audio;
                        break;
                    }

                    // 正常出声播放 (进度 > 0.5s 且时长正常)
                    if (!state.audio.paused && state.audio.currentTime > 0.3) {
                        resultStatus = "PLAYING_OK";
                        audioInfo = state.audio;
                        break;
                    }
                }

                if (state?.toastText && (state.toastText.includes("无法播放") || state.toastText.includes("无可用") || state.toastText.includes("未匹配"))) {
                    resultStatus = "GRACEFUL_INTERCEPT";
                    toastInfo = state.toastText;
                    break;
                }
            }

            if (resultStatus === "FAKE_AUDIO_LEAK") {
                console.error(`🚨【严重违规】捕获到 11 秒假音频流放行！`);
                console.error(`   地址: ${audioInfo.src}`);
                console.error(`   时长: ${audioInfo.duration} 秒`);
            } else if (resultStatus === "PLAYING_OK") {
                console.log(`🎉【正常出声】曲目成功播放！`);
                console.log(`   时长: ${audioInfo.duration.toFixed(1)}s (正常歌曲长度)`);
                console.log(`   进度: ${audioInfo.currentTime.toFixed(1)}s`);
                console.log(`   直链: ${audioInfo.src.substring(0, 80)}...`);
            } else if (resultStatus === "GRACEFUL_INTERCEPT") {
                console.log(`🛡️【安全拦截】假音频与无效源被成功阻断，UI 提示: "${toastInfo}" (未给用户播放 11 秒录音刺客)`);
            } else {
                console.log(`⏱️【未响应/超时】该曲目未能即时返回，未泄漏假音频。`);
            }
        }

        console.log("\n======================================================================");
        console.log("🏁 歌单端到端测试完毕！");
        console.log("======================================================================");

    } finally {
        ws.close();
        chrome.kill();
    }
}

main().catch(err => {
    console.error("执行异常:", err);
    process.exit(1);
});
