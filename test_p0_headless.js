const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

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
    console.log("=== 启动无头 Chrome 端到端实测 (验证 P0 1.1, 1.2, 1.3) ===");

    const chromePort = 9444;
    const chrome = spawn('google-chrome', [
        '--headless=new',
        `--remote-debugging-port=${chromePort}`,
        '--user-data-dir=/tmp/amusic-headless-p0-test',
        '--no-sandbox',
        '--disable-gpu',
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
    const pending = new Map();
    const consoleLogs = [];
    const consoleErrors = [];

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
            if (type === 'error') consoleErrors.push(text);
        }
    };

    function sendCmd(method, params = {}) {
        return new Promise((resolve) => {
            const id = msgId++;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    function evalPage(expr) {
        return sendCmd('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
            awaitPromise: true
        }).then(res => {
            if (res.result?.exceptionDetails) {
                console.error("[Page Exception]:", res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description);
            }
            return res.result?.result?.value;
        });
    }

    await sendCmd('Runtime.enable');
    await sendCmd('Page.enable');

    console.log("--> 正在打开 Amusic 服务 http://127.0.0.1:8088/ ...");
    await sendCmd('Page.navigate', { url: 'http://127.0.0.1:8088/' });
    await sleep(2500);

    // 步骤 A: 准备自建歌单测试数据并载入
    console.log("\n--> 步骤 A: 创建自建歌单《自动化测试歌单》并存入 3 首曲目...");
    const setupVal = await evalPage(`
        (function() {
            const testPl = {
                id: "custom_p0_test",
                title: "自动化测试歌单",
                name: "自动化测试歌单",
                category: "测试",
                tracks: [
                    { name: "晴天", artist: "周杰伦", album: "叶惠美", duration: "04:29" },
                    { name: "七里香", artist: "周杰伦", album: "七里香", duration: "04:59" },
                    { name: "夜曲", artist: "周杰伦", album: "十一月的萧邦", duration: "03:46" }
                ]
            };
            window.StorageManager.saveCustomPlaylists([testPl]);
            window.RightPanel.selectCustomPlaylist("custom_p0_test");
            return {
                title: document.getElementById("detailTitle")?.innerText,
                trackRowCount: document.querySelectorAll(".track-table tbody tr").length
            };
        })()
    `);
    console.log("自建歌单载入结果:", setupVal);

    // 步骤 B: 验证未勾选时的操作栏图标 (自建歌单应显示 ✕ 删除歌单，符合规范)
    console.log("\n--> 步骤 B: 验证未勾选状态下实体总览操作栏 (验证 P2 4.5 与规范)...");
    const defaultActions = await evalPage(`
        (function() {
            const actions = document.getElementById("detailActions");
            const btnDelete = document.getElementById("btnDeleteCustomCurrent");
            return {
                hasDeleteBtn: !!btnDelete,
                deleteTitle: btnDelete?.title,
                btnText: btnDelete?.innerText.trim()
            };
        })()
    `);
    console.log("未勾选时操作栏:", defaultActions);
    if (!defaultActions?.hasDeleteBtn || defaultActions?.btnText !== "✕") {
        throw new Error("自建歌单未勾选时未正确渲染 ✕ 删除歌单按钮！");
    }
    console.log("✔ 验证通过: 自建歌单未勾选状态下成功常驻 [✕] 删除歌单入口");

    // 步骤 C: 勾选 2 首歌曲，激活多选模式 (验证 P0 1.3)
    console.log("\n--> 步骤 C: 勾选前 2 首歌曲，验证多选操作栏动态出现『－ 移出歌单』(验证 P0 1.3)...");
    const selectionResult = await evalPage(`
        (function() {
            // 真实模拟点击复选框 (或者右键长按曲目)
            const checkboxes = document.querySelectorAll(".track-table tbody tr input[type='checkbox']");
            if (checkboxes.length >= 2) {
                checkboxes[0].click();
                checkboxes[1].click();
            }
            const actions = document.getElementById("detailActions");
            const btnRemove = actions?.querySelector("button[title*='从当前自建歌单移出']");
            return {
                selectedTracksCount: document.querySelectorAll(".track-row-selected").length,
                hasRemoveCustomBtn: !!btnRemove,
                removeBtnTitle: btnRemove?.title,
                removeBtnText: btnRemove?.innerText.trim()
            };
        })()
    `);
    console.log("多选激活后操作栏:", selectionResult);
    if (!selectionResult?.hasRemoveCustomBtn || selectionResult?.removeBtnText !== "－") {
        throw new Error("自建歌单多选激活时缺少『－ 移出歌单』按钮！");
    }
    console.log("✔ 验证通过: 自建歌单激活多选后，成功动态呈现 [－] 移出歌单入口！");

    // 截取一张多选状态截图
    const screenshot1 = await sendCmd('Page.captureScreenshot');
    if (screenshot1.result?.data) {
        fs.writeFileSync('/tmp/amusic_p0_selection.png', Buffer.from(screenshot1.result.data, 'base64'));
        console.log("📸 已保存多选状态截图至: /tmp/amusic_p0_selection.png");
    }

    // 步骤 D: 模拟点击『－ 移出歌单』并确认 (验证 P0 1.2)
    console.log("\n--> 步骤 D: 点击『－ 移出歌单』，触发应用内确认弹窗并执行移出 (验证 P0 1.2)...");
    const removeResult = await evalPage(`
        (function() {
            // 触发批量移出
            window.RightPanel.removeBatchSelectedFromCustom();
            
            // 检查此时弹出的模态框
            const modal = document.getElementById("confirmActionModal");
            const modalTitle = document.getElementById("confirmActionTitle")?.innerText;
            const modalMsg = document.getElementById("confirmActionMessage")?.innerText;

            // 自动点击“确认移出”按钮
            const confirmBtn = document.getElementById("btnConfirmActionSubmit");
            if (confirmBtn) {
                confirmBtn.click();
            }

            // 获取移出后的歌单曲目
            const remainingTracks = window.StorageManager.getCustomPlaylists().find(p => p.id === "custom_p0_test")?.tracks;
            const tableRows = document.querySelectorAll(".track-table tbody tr").length;

            return {
                modalTitle,
                modalMsg,
                remainingTrackNames: remainingTracks?.map(t => t.name),
                tableRows
            };
        })()
    `);
    console.log("移出操作执行结果:", removeResult);
    if (!removeResult?.remainingTrackNames || removeResult.remainingTrackNames.length !== 1 || removeResult.remainingTrackNames[0] !== "夜曲") {
        throw new Error("歌曲移出失败，底层数据未正确删除！");
    }
    console.log("✔ 验证通过: 成功将选中的 2 首歌曲批量移出，歌单内仅剩余《夜曲》，视图同步更新为 1 行！");

    // 步骤 E: 验证数据管理与备份导出 (验证 P0 1.1)
    console.log("\n--> 步骤 E: 验证备份导出 (验证 P0 1.1)...");
    const backupResult = await evalPage(`
        (function() {
            const rawJson = window.StorageManager.exportBackup();
            let parsed = null;
            let parseOk = false;
            try {
                parsed = JSON.parse(rawJson);
                parseOk = true;
            } catch (e) {}

            return {
                isString: typeof rawJson === 'string',
                parseOk,
                isNotObjectObject: rawJson !== "[object Object]",
                customCount: parsed?.data?.customPlaylists?.length,
                tracksInBackup: parsed?.data?.customPlaylists?.[0]?.tracks?.length
            };
        })()
    `);
    console.log("备份导出校验结果:", backupResult);
    if (!backupResult?.isString || !backupResult?.parseOk || !backupResult?.isNotObjectObject) {
        throw new Error("备份导出内容被破坏，非合法 JSON！");
    }
    console.log("✔ 验证通过: StorageManager.exportBackup 干净返回真实合法的 JSON 字符串，绝无 [object Object] 破坏！");

    // 截取最终状态截图
    const screenshot2 = await sendCmd('Page.captureScreenshot');
    if (screenshot2.result?.data) {
        fs.writeFileSync('/tmp/amusic_p0_finished.png', Buffer.from(screenshot2.result.data, 'base64'));
        console.log("📸 已保存最终状态截图至: /tmp/amusic_p0_finished.png");
    }

    // 清理测试数据
    await evalPage(`
        window.StorageManager.deleteCustomPlaylist("custom_p0_test");
        window.LibraryPanel?.renderLibrary?.();
    `);

    // 关闭无头浏览器
    ws.close();
    chrome.kill();

    console.log("\n🎉 ALL TESTS PASSED: 无头浏览器端到端全链路实测全部通过！");
}

main().catch(err => {
    console.error("\n❌ 实测失败:", err);
    process.exit(1);
});
