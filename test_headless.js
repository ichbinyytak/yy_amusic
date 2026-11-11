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
        '--user-data-dir=/tmp/test-chrome-profile-amusic',
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

    const pageTitle = await evaluate(`document.title`);
    console.log(`网页标题: "${pageTitle}" (期望 "YY_Amusic")`);
    if (pageTitle !== 'YY_Amusic') throw new Error(`页面标题应为 YY_Amusic，实际为 ${pageTitle}`);

    console.log("\n--- 开始验证 2: 顶部导航栏与数据管理迁移 ---");
    const exportBtn = await evaluate(`!!document.getElementById('btnExportBackup')`);
    const importBtn = await evaluate(`!!document.getElementById('btnImportBackup')`);
    const oldBackupBlock = await evaluate(`!!document.getElementById('top_backup')`);
    console.log(`我的音乐库存在导出按钮 [↑]: ${exportBtn}`);
    console.log(`我的音乐库存在导入按钮 [↓]: ${importBtn}`);
    console.log(`独立数据管理手风琴已彻底移除: ${!oldBackupBlock}`);
    if (!exportBtn || !importBtn || oldBackupBlock) throw new Error("数据管理图标迁移异常！");

    console.log("\n--- 开始验证 2.05: 备份与恢复防误触应用内确认弹窗 ---");
    await evaluate(`document.getElementById('btnExportBackup').click()`);
    await sleep(200);
    const exportModalOpen = await evaluate(`document.getElementById('confirmActionModal')?.classList.contains('open')`);
    const exportModalTitle = await evaluate(`document.getElementById('confirmActionTitle')?.innerText || ''`);
    console.log(`点击备份触发确认弹窗: ${exportModalOpen}, 弹窗标题: "${exportModalTitle}"`);
    if (!exportModalOpen || !exportModalTitle.includes("备份")) {
        throw new Error("点击备份歌单未弹出应用内确认弹窗！");
    }
    await evaluate(`window.Shell.closeConfirmActionModal()`);
    await sleep(200);

    await evaluate(`document.getElementById('btnImportBackup').click()`);
    await sleep(200);
    const importModalOpen = await evaluate(`document.getElementById('confirmActionModal')?.classList.contains('open')`);
    const importModalTitle = await evaluate(`document.getElementById('confirmActionTitle')?.innerText || ''`);
    console.log(`点击恢复触发确认弹窗: ${importModalOpen}, 弹窗标题: "${importModalTitle}"`);
    if (!importModalOpen || !importModalTitle.includes("恢复")) {
        throw new Error("点击恢复歌单未弹出应用内确认弹窗！");
    }
    await evaluate(`window.Shell.closeConfirmActionModal()`);
    await sleep(200);

    console.log("\n--- 开始验证 2.1: 顶部主标签页切换 (Apple专区 | 我的音乐库) ---");
    const tabAppleBtn = await evaluate(`!!document.getElementById('tabAppleBtn')`);
    const tabLibraryBtn = await evaluate(`!!document.getElementById('tabLibraryBtn')`);
    const viewAppleExists = await evaluate(`!!document.getElementById('viewApple')`);
    const viewLibraryExists = await evaluate(`!!document.getElementById('viewLibrary')`);
    console.log(`主标签页组件完整: AppleTab=${tabAppleBtn}, LibTab=${tabLibraryBtn}, viewApple=${viewAppleExists}, viewLib=${viewLibraryExists}`);
    if (!tabAppleBtn || !tabLibraryBtn || !viewAppleExists || !viewLibraryExists) {
        throw new Error("左侧主标签页或双全页视图未正确就绪！");
    }

    // 初始状态下 viewApple 处于激活，点击 tabLibraryBtn 切换到音乐库全页
    console.log("点击【我的音乐库】Tab 进行全页切换...");
    await evaluate(`document.getElementById('tabLibraryBtn').click()`);
    await sleep(200);
    const libActive = await evaluate(`document.getElementById('viewLibrary').classList.contains('active')`);
    const appleActive = await evaluate(`document.getElementById('viewApple').classList.contains('active')`);
    console.log(`切换后 viewLibrary激活: ${libActive}, viewApple隐藏: ${!appleActive}`);
    if (!libActive || appleActive) throw new Error("切换至【我的音乐库】全页失败！");

    // 切回【Apple专区】
    console.log("切回【Apple专区】Tab...");
    await evaluate(`document.getElementById('tabAppleBtn').click()`);
    await sleep(200);
    const appleRestored = await evaluate(`document.getElementById('viewApple').classList.contains('active')`);
    console.log(`切回后 viewApple重新激活: ${appleRestored}`);
    if (!appleRestored) throw new Error("切回【Apple专区】全页失败！");

    console.log("\n--- 开始验证 3: 网站推荐双抽屉默认折叠与 Apple 地区精简 ---");
    const appleHdrText = await evaluate(`document.querySelector('#top_region .top-accordion-left')?.innerText || ''`);
    console.log(`顶部 Tab 标题: "${appleHdrText}" (包含 "网站推荐")`);
    if (!appleHdrText.includes("网站推荐")) throw new Error(`标题未改名为 网站推荐: ${appleHdrText}`);

    // 验证初始默认折叠，点击后再展开加载 Apple 专区
    const appleAccOpenInitially = await evaluate(`document.querySelector('#top_apple_zone .top-accordion-body')?.classList.contains('open') || false`);
    const svAccOpenInitially = await evaluate(`document.querySelector('#top_streetvoice_zone .top-accordion-body')?.classList.contains('open') || false`);
    if (appleAccOpenInitially || svAccOpenInitially) {
        throw new Error(`网站推荐内 Apple 与街声默认均应折叠 (apple=${appleAccOpenInitially}, sv=${svAccOpenInitially})`);
    }
    await evaluate(`document.querySelector('#top_apple_zone .top-accordion-hdr')?.click()`);
    await sleep(600);

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
    const subtitleText = await evaluate(`document.querySelector('.source-drawer-subtitle')?.innerText || ''`);
    console.log(`音源抽屉副标题文本: "${subtitleText}"`);
    const hasUpdateTime = subtitleText.includes("最近更新") && /\d{4}-\d{2}-\d{2}/.test(subtitleText);
    console.log(`是否展示最近更新时间: ${hasUpdateTime}`);
    if (!hasUpdateTime) {
        throw new Error("音源抽屉副标题中未正确展示最近更新时间！");
    }
    await evaluate(`window.Shell.closeAllDrawers()`);
    await sleep(300);

    console.log("\n--- 开始验证 4: 分组扁平化与【未分组】常驻 ---");
    // 先确保切到我的音乐库
    await evaluate(`document.getElementById('tabLibraryBtn').click()`);
    await sleep(200);

    const oldFavsExists = await evaluate(`!!document.getElementById('lib_favs')`);
    const oldCustomsExists = await evaluate(`!!document.getElementById('lib_customs')`);
    console.log(`已彻底移除中间【收藏歌单】层级: ${!oldFavsExists}`);
    console.log(`已彻底移除中间【我的歌单】层级: ${!oldCustomsExists}`);
    if (oldFavsExists || oldCustomsExists) throw new Error("仍残留中间板块手风琴层级！");

    const libUngrouped = await evaluate(`document.getElementById('lib_cat_未分组') !== null`);
    console.log(`我的音乐库直接存在【未分组】置顶: ${libUngrouped}`);
    if (!libUngrouped) throw new Error("【未分组】未能默认常驻置顶！");

    const ungroupedHasButtons = await evaluate(`!!document.querySelector('#lib_cat_未分组 .library-group-row button')`);
    console.log(`【未分组】禁止外露按钮 (不渲染 ✕ 或 ✎): ${!ungroupedHasButtons}`);
    if (ungroupedHasButtons) throw new Error("【未分组】不应有外露按钮！");

    // 验证草图规范：未分组不可长按
    console.log("验证草图规范：未分组长按/右键不呼出操作菜单...");
    await evaluate(`
        const ugRow = document.querySelector('#lib_cat_未分组 .library-group-row');
        ugRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    `);
    await sleep(200);
    const ugMenuOpen = await evaluate(`document.getElementById('globalContextMenu')?.classList.contains('open') || false`);
    console.log(`未分组长按后菜单未弹出 (期望 false): ${ugMenuOpen}`);
    if (ugMenuOpen) throw new Error("未分组不应响应长按操作菜单！");

    // 验证草图规范与指令9：自定义分组支持长按 (重命名、删除，且不含新建歌单)
    console.log("验证规范：新建自定义分组并测试长按菜单呼出...");
    await evaluate(`
        window.StorageManager.addCategory('custom', '摇滚推荐组');
        window.LibraryPanel.renderLibrary();
    `);
    await sleep(200);
    await evaluate(`
        const rockRow = document.querySelector('#lib_cat_摇滚推荐组 .library-group-row');
        rockRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    `);
    await sleep(200);
    const rockMenuOpen = await evaluate(`document.getElementById('globalContextMenu')?.classList.contains('open') || false`);
    const rockMenuItems = await evaluate(`Array.from(document.querySelectorAll('#globalContextMenu .context-menu-item')).map(e => e.innerText.trim())`);
    console.log(`自定义分组长按弹出菜单: ${rockMenuOpen}, 菜单项:`, rockMenuItems);
    const hasRenameOption = rockMenuItems.some(i => i.includes('重命名'));
    const hasDelOption = rockMenuItems.some(i => i.includes('删除'));
    const hasCreateOption = rockMenuItems.some(i => i.includes('新建歌单'));
    console.log(`自定义分组长按不含“在此分组新建歌单” (期望 false): ${hasCreateOption}`);
    if (!rockMenuOpen || !hasRenameOption || !hasDelOption) {
        throw new Error("自定义分组长按菜单必须包含重命名与删除！");
    }
    if (hasCreateOption) {
        throw new Error("遵照指令9，分组长按菜单中绝不应包含新建歌单选项！");
    }
    // 清理测试菜单与测试分类组
    await evaluate(`window.ContextMenu?.hide?.()`);
    await evaluate(`
        window.StorageManager.deleteCategory('custom', '摇滚推荐组');
        window.LibraryPanel.renderLibrary();
    `);

    // 切回 Apple 专区供后续卡片和歌曲测试使用
    await evaluate(`document.getElementById('tabAppleBtn').click()`);
    await sleep(200);

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

    console.log("\n--- 开始验证 5.1: Apple专区卡片长按静默与无复制选项规范 ---");
    // 测试：长按 Apple 专区卡片绝对不弹出 ContextMenu
    await evaluate(`
        const appleCard = document.querySelector('.playlist-card[id^="card-pl."]');
        if (appleCard) {
            appleCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        }
    `);
    await sleep(200);
    const appleCardMenuOpened = await evaluate(`document.getElementById('globalContextMenu')?.classList.contains('open') || false`);
    console.log(`Apple专区歌单长按静默不弹菜单 (期望 false): ${appleCardMenuOpened}`);
    if (appleCardMenuOpened) throw new Error("Apple专区歌单长按不应弹出任何操作菜单！");

    // 测试：自建歌单长按菜单中绝无“复制”选项
    await evaluate(`
        window.StorageManager.createCustomPlaylist('无复制测试歌单', '未分组');
        window.LibraryPanel.renderLibrary();
        window.LeftPanel.switchTab('library');
    `);
    await sleep(200);
    await evaluate(`
        const cCard = document.querySelector('#viewLibrary .playlist-card');
        if (cCard) {
            cCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        }
    `);
    await sleep(200);
    const customMenuItems = await evaluate(`Array.from(document.querySelectorAll('#globalContextMenu .context-menu-item')).map(e => e.innerText)`);
    const hasCopyOption = customMenuItems.some(t => t.includes('复制'));
    const hasRenameSongOption = customMenuItems.some(t => t.includes('重命名歌单'));
    console.log(`歌单长按菜单项:`, customMenuItems);
    console.log(`歌单长按菜单不存在复制选项 (期望 false): ${hasCopyOption}`);
    console.log(`歌单长按菜单包含重命名歌单选项 (期望 true): ${hasRenameSongOption}`);
    if (hasCopyOption) throw new Error("歌单长按菜单中不应包含任何复制选项！");
    if (!hasRenameSongOption) throw new Error("我的音乐库歌单长按菜单中必须包含重命名歌单！");

    // 点击重命名呼出应用内统一输入弹窗
    await evaluate(`
        const renameBtn = Array.from(document.querySelectorAll('#globalContextMenu .context-menu-item')).find(e => e.innerText.includes('重命名'));
        if (renameBtn) renameBtn.click();
    `);
    await sleep(200);
    const promptModalOpen = await evaluate(`document.getElementById('inputPromptModal')?.classList.contains('open')`);
    console.log(`点击重命名歌单呼出应用内统一输入弹窗: ${promptModalOpen}`);
    if (!promptModalOpen) throw new Error("重命名歌单未能呼出应用内统一输入弹窗！");
    await evaluate(`window.Shell.closeInputPromptModal()`);
    await sleep(200);
    
    // 清理测试数据并切回 Apple 专区
    await evaluate(`window.ContextMenu?.hide?.()`);
    await evaluate(`
        const cList = window.StorageManager.getCustomPlaylists();
        const target = cList.find(c => c.title === '无复制测试歌单');
        if (target) window.StorageManager.deleteCustomPlaylist(target.id);
        window.LibraryPanel.renderLibrary();
        window.LeftPanel.switchTab('apple');
    `);
    await sleep(300);

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

    console.log("\n--- 开始验证 6.5: 方案B左右联动搜索与丝滑返回机制 ---");
    // 触发搜索 "王菲"
    console.log("执行搜索 '王菲'...");
    await evaluate(`
        const input = document.getElementById('searchInput');
        input.value = '王菲';
        window.Shell.handleSearch();
    `);
    // 等待接口异步抓取并渲染完成（最多等待 6 秒）
    for (let i = 0; i < 30; i++) {
        await sleep(200);
        const done = await evaluate(`document.querySelectorAll('#viewSearch .playlist-card').length > 0 && document.querySelectorAll('.track-table tbody tr').length > 0`);
        if (done) break;
    }

    const searchActive = await evaluate(`document.getElementById('viewSearch')?.classList.contains('active')`);
    const searchReturnBar = await evaluate(`!!document.getElementById('searchReturnBar')`);
    const searchCardsCount = await evaluate(`document.querySelectorAll('#viewSearch .playlist-card').length`);
    const rightTrackCount = await evaluate(`document.querySelectorAll('.track-table tbody tr').length`);
    const drawerAutoOpened = await evaluate(`document.getElementById('listPanel')?.classList.contains('open')`);
    console.log(`左侧激活搜索结果面板 (viewSearch.active): ${searchActive}`);
    console.log(`左侧存在顶部返回导航条 (#searchReturnBar): ${searchReturnBar}`);
    console.log(`左侧展示匹配歌单/专辑卡片数: ${searchCardsCount}`);
    console.log(`右侧展示检索到的单曲列表数: ${rightTrackCount}`);
    console.log(`搜索有结果时左侧抽屉自动弹出 (.list-panel.open): ${drawerAutoOpened}`);
    console.log(`调试：最近 10 条 Console Logs:`, consoleLogs.slice(-10));

    if (!searchActive || !searchReturnBar) {
        throw new Error("搜索后左侧未能激活结果面板或未展示返回条！");
    }
    if (searchCardsCount === 0) {
        throw new Error("搜索 '王菲' 后左侧未能展示匹配的歌单或专辑卡片！");
    }
    if (rightTrackCount === 0) {
        throw new Error("搜索 '王菲' 后右侧未能展示匹配的单曲列表！");
    }
    if (!drawerAutoOpened) {
        throw new Error("搜索左侧有结果时，左侧抽屉未能自动弹出！");
    }

    // 测试点击右侧区域，左侧抽屉自动缩回
    console.log("测试交互：点击右侧歌曲面板，左侧抽屉自动缩回...");
    await evaluate(`document.getElementById('detailPanel').click()`);
    await sleep(300);
    const drawerClosedOnRightClick = await evaluate(`!document.getElementById('listPanel')?.classList.contains('open')`);
    console.log(`点击右侧后左侧抽屉已成功缩回: ${drawerClosedOnRightClick}`);
    if (!drawerClosedOnRightClick) {
        throw new Error("点击右侧区域后左侧抽屉未能成功缩回！");
    }

    // 测试丝滑返回：点击左侧顶部的 [← 返回] 按钮
    console.log("测试返回机制：点击左侧 [← 返回] 按钮退出搜索...");
    await evaluate(`document.getElementById('btnExitSearch').click()`);
    await sleep(300);

    const searchClosed = await evaluate(`!document.getElementById('viewSearch')?.classList.contains('active')`);
    const appleRestoredAfterSearch = await evaluate(`document.getElementById('viewApple')?.classList.contains('active')`);
    console.log(`退出搜索后 viewSearch 隐藏: ${searchClosed}`);
    console.log(`退出搜索后自动恢复专区视图: ${appleRestoredAfterSearch}`);
    if (!searchClosed || !appleRestoredAfterSearch) {
        throw new Error("点击 [← 返回] 后未能正常退出搜索或未能恢复原视图！");
    }

    console.log("\n--- 开始验证 6.6: 点击单曲中歌手名联动搜索 & 点击专辑名直接进入整张专辑 ---");
    // 1. 获取当前曲目表中第一首歌的歌手名
    const firstArtist = await evaluate(`document.querySelector('.track-artist-link')?.innerText?.trim() || ''`);
    console.log(`当前列表第一首歌曲歌手: "${firstArtist}"`);
    if (!firstArtist) throw new Error("曲目列表未找到 .track-artist-link 歌手跳转链接元素！");

    // 点击该歌手链接触发搜索联动
    console.log(`点击歌手链接《${firstArtist}》触发联动搜索...`);
    await evaluate(`document.querySelector('.track-artist-link').click()`);

    // 等待搜索结果渲染
    for (let i = 0; i < 30; i++) {
        await sleep(200);
        const done = await evaluate(`document.querySelectorAll('#viewSearch .playlist-card').length > 0 && document.querySelectorAll('.track-table tbody tr').length > 0`);
        if (done) break;
    }

    const artistSearchActive = await evaluate(`document.getElementById('viewSearch')?.classList.contains('active')`);
    const artistSearchInputVal = await evaluate(`document.getElementById('searchInput')?.value || ''`);
    console.log(`点击歌手后激活搜索面板: ${artistSearchActive}`);
    console.log(`搜索框同步歌手关键词: "${artistSearchInputVal}"`);
    if (!artistSearchActive || !artistSearchInputVal.includes(firstArtist.replace(/^·\s*/, ''))) {
        throw new Error("点击歌手名未能正确触发联动搜索！");
    }

    // 2. 在搜索结果单曲列表中，测试点击专辑名直接进入整张专辑
    const targetAlbumName = await evaluate(`document.querySelector('.track-album-link')?.innerText?.trim() || ''`);
    console.log(`搜索结果列表中第一首单曲所属专辑: "${targetAlbumName}"`);
    if (targetAlbumName) {
        console.log(`点击专辑名《${targetAlbumName}》进入专辑完整曲目详情...`);
        await evaluate(`document.querySelector('.track-album-link').click()`);
        
        // 等待专辑详情与曲目加载完成
        for (let i = 0; i < 30; i++) {
            await sleep(200);
            const loaded = await evaluate(`document.getElementById('detailTitle')?.innerText?.includes('${targetAlbumName.replace(/'/g, "\\'")}') && document.querySelectorAll('.track-table tbody tr').length > 0`);
            if (loaded) break;
        }

        const albumDetailTitle = await evaluate(`document.getElementById('detailTitle')?.innerText || ''`);
        const albumTracksCount = await evaluate(`document.querySelectorAll('.track-table tbody tr').length`);
        console.log(`右侧详情标题已切换为专辑: "${albumDetailTitle}"`);
        console.log(`整张专辑曲目加载数: ${albumTracksCount}`);
        if (!albumDetailTitle.includes(targetAlbumName) || albumTracksCount === 0) {
            throw new Error("点击单曲专辑名未能正确穿透加载整张专辑曲目列表！");
        }
    }

    console.log("\n--- 开始验证 6.6.1: 多歌手 a & b 独立链接拆分与各自联动搜索 ---");
    // 渲染带有多歌手的合唱测试曲目
    await evaluate(`
        window.RightPanel.renderTracklist([
            { index: 1, name: "今天你要嫁给我", artist: "陶喆 & 蔡依林", album: "太美丽", durationMillis: 270000 },
            { index: 2, name: "千里之外", artist: "费玉清 / 周杰伦", album: "依然范特西", durationMillis: 255000 }
        ]);
    `);
    await sleep(200);

    const firstRowArtistLinks = await evaluate(`Array.from(document.querySelectorAll('#track-row-0 .track-artist-link')).map(el => el.innerText.trim())`);
    console.log(`合唱歌曲 1 (陶喆 & 蔡依林) 解析到的歌手链接:`, firstRowArtistLinks);
    if (firstRowArtistLinks.length !== 2 || firstRowArtistLinks[0] !== '陶喆' || firstRowArtistLinks[1] !== '蔡依林') {
        throw new Error(`多歌手未能正确拆分成两个独立歌手链接！当前: ${JSON.stringify(firstRowArtistLinks)}`);
    }

    const firstRowDelim = await evaluate(`document.querySelector('#track-row-0 .artist-delimiter')?.innerText?.trim()`);
    console.log(`合唱歌曲 1 连接符: "${firstRowDelim}"`);
    if (firstRowDelim !== '&') {
        throw new Error(`多歌手连接符未正确保留！期望 '&'，当前: '${firstRowDelim}'`);
    }

    const secondRowArtistLinks = await evaluate(`Array.from(document.querySelectorAll('#track-row-1 .track-artist-link')).map(el => el.innerText.trim())`);
    console.log(`合唱歌曲 2 (费玉清 / 周杰伦) 解析到的歌手链接:`, secondRowArtistLinks);
    if (secondRowArtistLinks.length !== 2 || secondRowArtistLinks[0] !== '费玉清' || secondRowArtistLinks[1] !== '周杰伦') {
        throw new Error(`斜杠多歌手未能正确拆分成两个独立歌手链接！当前: ${JSON.stringify(secondRowArtistLinks)}`);
    }

    // 测试点击第二个歌手链接（蔡依林），验证精准搜索‘蔡依林’而非合唱全称
    console.log("测试点击第二个歌手链接《蔡依林》...");
    await evaluate(`document.querySelectorAll('#track-row-0 .track-artist-link')[1].click()`);
    await sleep(600);
    const searchValAfterSecondArtist = await evaluate(`document.getElementById('searchInput')?.value || ''`);
    console.log(`点击第二个歌手后搜索框内容: "${searchValAfterSecondArtist}"`);
    if (searchValAfterSecondArtist !== '蔡依林') {
        throw new Error(`点击第二个歌手时未能精确独立搜索！期望 '蔡依林'，实际: '${searchValAfterSecondArtist}'`);
    }

    console.log("\n--- 开始验证 6.7: 播放切歌即刻静音 & 首曲精准起播不跳曲 ---");
    // 测试：点击“播放全部”，验证立刻停止前序播放并精准从第一首 (索引 0) 开始起播
    console.log("执行‘播放全部’测试...");
    await evaluate(`window.RightPanel.playCurrentAll()`);
    
    // 立即检查播控状态：前序音频是否立刻停止，当前起播索引是否为 0
    const playingIndex = await evaluate(`window.player.currentIndex`);
    const isPausedDuringResolve = await evaluate(`window.player.audio.paused`);
    console.log(`播放全部起播曲目索引 (应为 0): ${playingIndex}`);
    console.log(`寻链阶段底层音频即刻静音 (audio.paused): ${isPausedDuringResolve}`);
    if (playingIndex !== 0) {
        throw new Error(`点击播放全部未能从第一首起播，当前索引为 ${playingIndex}！`);
    }
    if (!isPausedDuringResolve) {
        throw new Error("点击播放新曲目时，未能立刻停止当前音频播放！");
    }

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
