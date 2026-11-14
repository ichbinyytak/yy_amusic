/**
 * test_prod_play.js
 * 专门用于在每次修改后，以真实用户视角无头访问生产环境 (https://amusic.hefang.fun)，
 * 自动加载歌单、点击点播单曲、监测 <audio> 是否产生真实物理播放时间与出声状态。
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
    console.log("==================================================");
    console.log("🚀 启动无头 Chrome 端到端生产环境模拟测试");
    console.log("目标站点: https://amusic.hefang.fun");
    console.log("==================================================");

    const chromePort = 9555;
    const chrome = spawn('google-chrome', [
        '--headless=new',
        `--remote-debugging-port=${chromePort}`,
        '--user-data-dir=/tmp/amusic-prod-smoke-test',
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

        // 等待页面初始渲染 (精选专区卡片或侧栏歌单卡片)
        let loaded = false;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            const title = await evaluate(`document.title`);
            const hasGrid = await evaluate(`!!document.querySelector('.playlist-card')`);
            if (hasGrid) {
                loaded = true;
                console.log(`✅ 页面加载成功! 标题: "${title}"`);
                break;
            }
        }

        if (!loaded) {
            console.error("❌ 页面加载超时或未渲染出 .playlist-card 歌单卡片");
            return;
        }

        console.log("2. 正在模拟用户在搜索框搜索《飞瀑而下 孙燕姿》...");
        await evaluate(`
            (function() {
                window.SearchPanel.search("飞瀑而下 孙燕姿");
            })()
        `);

        // 等待搜索结果渲染
        let songFound = false;
        let targetSong = null;
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            targetSong = await evaluate(`
                (function() {
                    const row = document.querySelector('tr[id^="track-row-"]');
                    if (!row) return null;
                    return {
                        title: row.querySelector('.track-name, td:nth-child(2)')?.textContent?.trim() || '',
                        artist: row.querySelector('.track-artist, td:nth-child(3)')?.textContent?.trim() || ''
                    };
                })()
            `);
            if (targetSong && targetSong.title) {
                songFound = true;
                break;
            }
        }

        if (!songFound) {
            console.error("❌ 搜索未渲染出结果");
            return;
        }

        console.log(`3. 命中搜索单曲: 《${targetSong.title}》 ${targetSong.artist}`);
        console.log("4. 模拟用户双击搜索单曲发起真实点播...");
        const playStart = Date.now();
        await evaluate(`
            (function() {
                const row = document.querySelector('tr[id^="track-row-"]');
                if (row) {
                    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                } else if (window.RightPanel && window.RightPanel.playSong) {
                    window.RightPanel.playSong(0);
                }
            })()
        `);

        console.log("5. 正在监测底层 HTML5 <audio> 播放器真实出声状态...");
        let played = false;
        let audioReport = null;

        for (let i = 0; i < 40; i++) { // 最多等 12 秒
            await sleep(300);
            audioReport = await evaluate(`
                (function() {
                    const audio = document.querySelector('audio');
                    if (!audio) return { exists: false };
                    return {
                        exists: true,
                        paused: audio.paused,
                        currentTime: audio.currentTime,
                        duration: audio.duration,
                        src: audio.src ? audio.src.substring(0, 80) + '...' : '',
                        readyState: audio.readyState,
                        networkState: audio.networkState,
                        error: audio.error ? { code: audio.error.code, message: audio.error.message } : null
                    };
                })()
            `);

            if (audioReport && audioReport.exists && !audioReport.paused && audioReport.currentTime > 0) {
                played = true;
                break;
            }
        }

        const elapsed = Date.now() - playStart;
        if (played) {
            console.log("==================================================");
            console.log(`🎉 真实用户端到端播放验证成功！`);
            console.log(`  🎵 正在播放: 《${targetSong.title}》 - ${targetSong.artist}`);
            console.log(`  ⏱️  出声耗时: ${elapsed} ms`);
            console.log(`  📻 真实直链: ${audioReport.src}`);
            console.log(`  ▶️  当前进度: ${audioReport.currentTime.toFixed(2)}s / ${audioReport.duration.toFixed(2)}s`);
            console.log("==================================================");
        } else {
            console.error("❌ 未能在规定时间内触发音频出声播放！");
            console.error("播放器调试信息:", JSON.stringify(audioReport, null, 2));
        }

    } finally {
        ws.close();
        chrome.kill();
    }
}

main().catch(err => {
    console.error("测试异常:", err);
    process.exit(1);
});
