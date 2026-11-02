/**
 * test_headless.js - 无头 Chrome CDP 自动化排错验证测试脚本
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

async function run() {
    console.log("=== 启动无头 Chrome 自动化排错测试 ===");

    const port = 9333;
    const chrome = spawn('google-chrome', [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        'about:blank'
    ]);

    let closed = false;
    chrome.on('exit', () => { closed = true; });

    // 等待 CDP 端口就绪
    let targets = null;
    for (let i = 0; i < 20; i++) {
        await sleep(300);
        try {
            targets = await getJson(`http://127.0.0.1:${port}/json`);
            if (targets && targets.length > 0 && targets.some(t => t.type === 'page')) break;
        } catch (e) {}
    }

    const pageTarget = targets?.find(t => t.type === 'page');
    if (!pageTarget) {
        console.error("❌ 无法连接到 Chrome CDP 页面 Target");
        chrome.kill();
        process.exit(1);
    }

    const wsUrl = pageTarget.webSocketDebuggerUrl;
    console.log("已连接 CDP 页面:", wsUrl);

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
    });

    let msgId = 1;
    const pending = new Map();
    const consoleErrors = [];
    const consoleLogs = [];

    ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const type = msg.params.type;
            const text = msg.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' ');
            consoleLogs.push(`[${type}] ${text}`);
            if (type === 'error') {
                consoleErrors.push(text);
            }
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            const details = msg.params.exceptionDetails;
            const desc = details?.exception?.description || details?.text;
            const loc = `${details?.url || 'inline'}:${details?.lineNumber}:${details?.columnNumber}`;
            console.log(`[Exception Details] ${loc} -> ${desc}`);
            consoleErrors.push(`EXCEPTION at ${loc}: ${desc}`);
        }
    };

    function sendCmd(method, params = {}) {
        return new Promise((resolve) => {
            const id = msgId++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expr) {
        const res = await sendCmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (res.result?.exceptionDetails) {
            consoleErrors.push(res.result.exceptionDetails.text);
        }
        return res.result?.result?.value;
    }

    // 启用 Console 与 Runtime 事件
    await sendCmd('Runtime.enable');
    await sendCmd('Page.enable');

    console.log("导航至 http://127.0.0.1:8088/ ...");
    await sendCmd('Page.navigate', { url: 'http://127.0.0.1:8088/' });
    await sleep(2000);

    console.log("\n--- 开始验证 1: 基础框架与字号阶梯 ---");
    const t2Fs = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--fs-t2').trim()`);
    console.log(`--fs-t2 字号: "${t2Fs}" (期望 "11px")`);
    if (t2Fs !== '11px') throw new Error(`--fs-t2 应为 11px，实际为 ${t2Fs}`);

    console.log("\n--- 开始验证 2: 顶部导航栏与数据管理迁移 ---");
    const exportBtn = await evaluate(`!!document.getElementById('btnExportBackup')`);
    const importBtn = await evaluate(`!!document.getElementById('btnImportBackup')`);
    const oldBackupBlock = await evaluate(`!!document.getElementById('top_backup')`);
    console.log(`我的音乐库存在导出按钮 [↑]: ${exportBtn}`);
    console.log(`我的音乐库存在导入按钮 [↓]: ${importBtn}`);
    console.log(`独立数据管理手风琴已彻底移除: ${!oldBackupBlock}`);
    if (!exportBtn || !importBtn || oldBackupBlock) throw new Error("数据管理图标迁移异常！");

    console.log("\n--- 开始验证 3: Apple专区与地区精简 ---");
    const appleHdrText = await evaluate(`document.querySelector('#top_region .top-accordion-left')?.innerText || ''`);
    console.log(`专区标题: "${appleHdrText}" (包含 "Apple专区")`);
    if (!appleHdrText.includes("Apple专区")) throw new Error(`标题未改名为 Apple专区: ${appleHdrText}`);

    const selectOptions = await evaluate(`Array.from(document.querySelectorAll('#regionMicroSelect option')).map(o => o.value + ':' + o.text.trim())`);
    console.log(`地区下拉选项:`, selectOptions);
    if (selectOptions.length !== 4) throw new Error(`地区选项数应为 4，实际为 ${selectOptions.length}`);
    const expectedValues = ['cn', 'hk', 'tw', 'us'];
    const actualValues = await evaluate(`Array.from(document.querySelectorAll('#regionMicroSelect option')).map(o => o.value)`);
    if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) throw new Error(`地区选项值不符合规范: ${actualValues}`);

    // 检查专区下属角标不包含“板块”或“专区”文字
    const newBadge = await evaluate(`document.getElementById('badgeNewSections')?.innerText || ''`);
    const expBadge = await evaluate(`document.getElementById('badgeExploreCategories')?.innerText || ''`);
    console.log(`最新发布角标: "${newBadge}", 类别探索角标: "${expBadge}"`);
    if (newBadge.includes("板块") || expBadge.includes("专区")) {
        throw new Error("角标内仍残留有'板块'或'专区'字样！");
    }

    console.log("\n--- 开始验证 3.1: 音源健康度与测速数字显示 ---");
    // 打开音源抽屉测试测速数值
    await evaluate(`window.Shell.toggleSourceModal()`);
    await sleep(800);
    const sourceStatusBadges = await evaluate(`Array.from(document.querySelectorAll('.source-status-badge')).map(b => b.innerText.trim())`);
    console.log(`音源抽屉测速徽章采样:`, sourceStatusBadges.slice(0, 3));
    const hasMsNumber = sourceStatusBadges.some(t => /\d+(\.\d+)?ms/.test(t));
    console.log(`是否存在毫秒测速数值: ${hasMsNumber}`);
    if (!hasMsNumber && sourceStatusBadges.length > 0) {
        throw new Error("音源抽屉中未正确展示延迟毫秒数！");
    }
    await evaluate(`window.Shell.closeAllDrawers()`);
    await sleep(300);

    console.log("\n--- 开始验证 4: 分组规则与【未分组】常驻 ---");
    const favUngrouped = await evaluate(`document.getElementById('lib_favs_cat_未分组') !== null`);
    const customUngrouped = await evaluate(`document.getElementById('lib_customs_cat_未分组') !== null`);
    console.log(`收藏歌单存在【未分组】: ${favUngrouped}`);
    console.log(`我的歌单存在【未分组】: ${customUngrouped}`);
    if (!favUngrouped || !customUngrouped) throw new Error("【未分组】未能默认常驻置顶！");

    const ungroupedHasButtons = await evaluate(`!!document.querySelector('#lib_customs_cat_未分组 .library-group-row button[data-action="del"]') || !!document.getElementById('lib_customs_cat_未分组')?.querySelector('button[data-action="del"]')`);
    console.log(`【未分组】禁止删除按钮 (不渲染 ✕): ${!ungroupedHasButtons}`);
    if (ungroupedHasButtons) throw new Error("【未分组】不应有删除按钮！");

    console.log("\n--- 开始验证 5: 左侧歌单卡片图标精简 ---");
    // 等待歌单卡片加载
    await sleep(2500);
    const cardCount = await evaluate(`document.querySelectorAll('.playlist-card').length`);
    console.log(`页面当前加载的歌单/专辑卡片数量: ${cardCount}`);

    const cardPlayBtnCount = await evaluate(`document.querySelectorAll('.playlist-card button[data-action="play"]').length`);
    const cardFavBtnCount = await evaluate(`document.querySelectorAll('.playlist-card button[data-action="fav"]').length`);
    const cardDownloadBtnCount = await evaluate(`document.querySelectorAll('.playlist-card button[data-action="download"]').length`);
    console.log(`左侧卡片播放按钮 ▶ 数量: ${cardPlayBtnCount} (应为 0)`);
    console.log(`左侧卡片收藏按钮 ★ 数量: ${cardFavBtnCount} (应为 0)`);
    console.log(`左侧卡片下载按钮 ↓ 数量: ${cardDownloadBtnCount} (应为 0)`);
    if (cardPlayBtnCount > 0 || cardFavBtnCount > 0 || cardDownloadBtnCount > 0) {
        throw new Error("左侧卡片仍残留有播放、收藏或下载按钮！");
    }

    console.log("\n--- 开始验证 6: 右侧曲目列表与多选下载逻辑 ---");
    // 点击一个多曲目的官方歌单展开右侧
    await evaluate(`document.querySelector('.playlist-card[id^="card-pl."]')?.click()`);
    await sleep(3000);

    const trackRowCount = await evaluate(`document.querySelectorAll('.track-table tbody tr').length`);
    console.log(`右侧加载曲目数: ${trackRowCount}`);
    if (trackRowCount < 2) throw new Error(`歌单曲目加载不足 2 首: ${trackRowCount}`);

    const actionColExists = await evaluate(`document.querySelectorAll('.track-action-col').length > 0`);
    console.log(`曲目表格已精简为标准 4 列 (彻底移除第 5 列操作栏): ${!actionColExists}`);
    if (actionColExists) throw new Error("曲目表格仍残留第 5 列操作栏！");

    // 测试方案B：未激活多选时，单击曲目行彻底无反应（防误触）
    console.log("测试方案B：单击曲目行验证防误触...");
    await evaluate(`document.querySelector('.track-table tbody tr:nth-child(1)').click()`);
    await sleep(200);
    const selectionAfterClick = await evaluate(`document.querySelectorAll('.track-row-selected').length`);
    console.log(`单击后勾选数量 (应为 0): ${selectionAfterClick}`);
    if (selectionAfterClick !== 0) throw new Error("方案B失败：非多选模式单击曲目行不应产生勾选！");

    const headerDownloadBtnInitially = await evaluate(`!!document.querySelector('.detail-actions button[title*="下载"]')`);
    console.log(`未勾选时实体总览栏不显现下载按钮: ${!headerDownloadBtnInitially}`);
    if (headerDownloadBtnInitially) throw new Error("未勾选时实体总览栏不应显现下载按钮！");

    const favBtnText = await evaluate(`document.getElementById('btnFavCurrent')?.innerText?.trim()`);
    console.log(`默认未勾选时收藏图标统一为 ＋: ${favBtnText === '＋'}`);
    if (favBtnText && favBtnText !== '＋') throw new Error(`收藏图标未统一为 ＋，当前为 ${favBtnText}`);

    // 测试组合1：触发长按/右键进入多选模式
    console.log("测试组合1：右键触发长按多选激活...");
    await evaluate(`
        const tr1 = document.querySelector('.track-table tbody tr:nth-child(1)');
        tr1.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    `);
    await sleep(300);

    const isMultiMode = await evaluate(`document.getElementById('trackTableEl')?.classList.contains('multi-select-mode')`);
    const floatingBarExists = await evaluate(`document.getElementById('floatingBatchBar') !== null`);
    const contextMenuOpen = await evaluate(`!!document.getElementById('globalContextMenu')?.classList.contains('show')`);
    const headerHasBatchActions = await evaluate(`
        (() => {
            const btns = Array.from(document.querySelectorAll('.detail-actions button'));
            return btns.length === 4 && btns.some(b => b.innerText.includes('✕'));
        })()
    `);
    console.log(`多选模式已激活: ${isMultiMode}`);
    console.log(`底部悬浮窗口已彻底移除: ${!floatingBarExists}`);
    console.log(`歌曲长按不弹出冗余选项菜单: ${!contextMenuOpen}`);
    console.log(`头部集中承载多选操作栏(▶, ＋, ↓, ✕): ${headerHasBatchActions}`);
    if (!isMultiMode) throw new Error("长按/右键未能激活多选模式！");
    if (floatingBarExists) throw new Error("底部悬浮窗口未彻底移除！");
    if (contextMenuOpen) throw new Error("歌曲长按不应弹出冗余操作菜单！");
    if (!headerHasBatchActions) throw new Error("歌单头部未能集中承载多选操作栏！");

    // 勾选第 2 首歌
    console.log("多选模式下轻触勾选第 2 首歌曲...");
    await evaluate(`document.querySelector('.track-table tbody tr:nth-child(2)').click()`);
    await sleep(300);

    console.log("点击下载按钮，测试多首下载清单确认弹窗...");
    await evaluate(`document.querySelector('.detail-actions button[title*="下载"]').click()`);
    await sleep(600);

    const modalOpen = await evaluate(`document.getElementById('batchDownloadModal')?.classList.contains('open')`);
    const modalSummary = await evaluate(`document.getElementById('batchDownloadSummary')?.innerText || ''`);
    const modalItems = await evaluate(`document.querySelectorAll('#batchDownloadSongList > div').length`);
    console.log(`批量下载确认弹窗已呼出: ${modalOpen}`);
    console.log(`弹窗摘要信息: "${modalSummary}"`);
    console.log(`弹窗核对清单曲目首数: ${modalItems}`);
    if (!modalOpen || modalItems < 2) throw new Error("批量下载确认弹窗未正常弹出或清单未正确呈现！");

    // 关闭弹窗
    await evaluate(`window.Shell.closeBatchDownloadModal()`);
    await sleep(300);
    const modalClosed = await evaluate(`!document.getElementById('batchDownloadModal')?.classList.contains('open')`);
    console.log(`弹窗成功关闭: ${modalClosed}`);

    console.log("\n--- 开始验证 7: 控制台报错检查 (严格 0 错误铁律) ---");
    console.log(`Console 错误条数: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
        console.error("❌ 发现 Console 错误:", consoleErrors);
        throw new Error(`控制台存在 ${consoleErrors.length} 个错误，不符合 0 错误提交标准！`);
    }

    console.log("\n🎉 所有排错测试 100% 通过！控制台绝对 0 报错！");

    chrome.kill();
    ws.close();
    process.exit(0);
}

run().catch((err) => {
    console.error("\n❌ 测试失败:", err.message);
    process.exit(1);
});
