# Amusic 项目全栈代码深度排查与系统级优化清单 (Optimization Checklist)

> **排查对象**：Amusic (Apple 音乐纯文本数据库浏览器 + 双核并发音频底座)  
> **排查范围**：Python 后端服务 (`server.py`, `song_search.py`, `source_manager.py`, `apple_catalog.py`, `sync_sources.py`, `api/index.py`)、前端应用架构 (`player.js`, `js/*.js`, `index.html`, `css/*.css`)、部署与自动化流水线 (`vercel.json`, `requirements.txt`, `.github/workflows/daily_sync.yml`)。  
> **排查标准**：基于高可用性、健壮性、接口安全性、性能吞吐、多端兼容性与代码规范深度比对。

---

## 目录索引
1. [🚨 P0 级严重缺陷与代码逻辑错误 (Critical Bugs)](#一-p0-级严重缺陷与代码逻辑错误-critical-bugs)
2. [🛡️ P1 级安全漏洞与网络防护隐患 (Security & SSRF)](#二-p1-级安全漏洞与网络防护隐患-security--ssrf)
3. [⚡ P1 级性能瓶颈与高并发资源开销 (Performance & Resources)](#三-p1-级性能瓶颈与高并发资源开销-performance--resources)
4. [🎵 P2 级播放器体验与移动端全场景完善 (Player & UX QoL)](#四-p2-级播放器体验与移动端全场景完善-player--ux-qol)
5. [🧹 P2 级代码健康度、冗余清理与可维护性 (Code Smells & Tech Debt)](#五-p2-级代码健康度冗余清理与可维护性-code-smells--tech-debt)
6. [☁️ P3 级云端部署与离线降级兼容性 (Cloud & Fallback)](#六-p3-级云端部署与离线降级兼容性-cloud--fallback)
7. [📋 优化任务执行排期与优先级总表](#七-优化任务执行排期与优先级总表)

---

## 一、 P0 级严重缺陷与代码逻辑错误 (Critical Bugs)

### 1.1 导出备份二次重复触发下载且文件被破坏为 `[object Object]`
* **问题定位**：[`js/backup.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/backup.js#L16-L39) 与 [`js/storage.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/storage.js#L458-L504)
* **代码实据**：
  ```javascript
  // js/storage.js (Line 491-504)
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click(); // 此处已经执行并完成了一次标准 JSON 文件的下载！
  return { fileName, customsCount: customs.length, favsCount: favs.length }; // 返回的是统计 Object！

  // js/backup.js (Line 16-25)
  function exportData() {
      const jsonStr = window.StorageManager.exportBackup(); // 得到的是 Object，并非字符串！
      const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" }); // 强制转字符串变为 "[object Object]"
      // 再次创建 <a> 标签二次触发下载！
  ```
* **缺陷后果**：用户点击“导出备份”后，浏览器会**连续弹出两次下载请求**，且第二次下载的文件内容被永久破坏为纯文本 `[object Object]`。用户后续若使用该文件执行“导入恢复”，`JSON.parse` 抛出 `SyntaxError` 彻底失败。
* **整改方案**：将 `StorageManager.exportBackup()` 职责纯粹化为仅负责组装并返回备份数据对象或 JSON 字符串，统一由 `BackupManager.exportData()` 负责 Blob 创建、触发单次下载和弹出 Toast 提示。

---

### 1.2 自建歌单移除曲目函数参数类型错配，导致歌曲永久无法删除
* **问题定位**：[`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js#L668-L674) 与 [`js/storage.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/storage.js#L139-L152)
* **代码实据**：
  ```javascript
  // js/storage.js (Line 139) 定义的形参是 trackIndex（数组索引整数）:
  function removeTrackFromCustomPlaylist(playlistId, trackIndex) {
      if (trackIndex >= 0 && trackIndex < pl.tracks.length) { ... }
  }

  // js/right.js (Line 668-674) 调用的却是:
  function removeSongFromCustom(idx) {
      const track = currentTracks[idx];
      // 错误传入了 track.name（字符串）和 track.artist！
      window.StorageManager.removeTrackFromCustomPlaylist(currentCustomPlaylistId, track.name, track.artist);
  }
  ```
* **缺陷后果**：由于传入的是字符串歌名，`trackIndex >= 0` 判定恒为 `false`（`"SongName" >= 0 === false`），自建歌单曲目移除逻辑永远短路静默失败。
* **整改方案**：
  1. 将 `right.js` 中的调用修正为传入数值索引 `idx`；
  2. 在 `storage.js` 中做参数重载兼容：支持传入数字 `trackIndex`，或传入对象/字符串 `(trackName, trackArtist)` 双重匹配移除。

---

### 1.3 自建歌单曲目缺乏批量与单曲“移出歌单”操作入口 (功能闭环缺失)
* **问题定位**：[`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js#L258-L274)
* **代码实据**：在当前 4 列纯净模式下，当用户勾选多首激活多选后，头部操作栏固定只展示：
  `▶ 播放所选 ｜ ＋ 批量加入自建歌单 ｜ ↓ 批量下载 ｜ ✕ 取消多选`
* **缺陷后果**：用户将歌曲加入自建歌单后，**在整个前台 UI 上找不到任何能将歌曲从当前自建歌单移除的按钮或菜单**（`removeSongFromCustom` 虽声明导出，但全局未挂载到任何交互入口）。
* **整改方案**：当 `isViewingCustomPlaylist === true` 且处于多选激活状态时，在操作组中将 `＋` 替换或补充为 `✕ 移出歌单`，支持批量移出所选歌曲并提供交互确认。

---

### 1.4 音源调度跨平台 ID 错配引发超时风暴与健康度误伤
* **问题定位**：[`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py#L390-L438)
* **代码实据**：
  ```python
  # source_manager.py (Line 390-394)
  same_plat_sources = self.get_ordered_sources(platform=target_plat)
  other_sources = [s for s in self.get_ordered_sources() if s not in same_plat_sources]
  all_ordered = same_plat_sources + other_sources  # 将其他所有平台的音源全部追加！

  # 当同平台音源未命中时，继续将原候选歌曲 ID 传给其他平台的音源进行冲刺
  # Line 411:
  exec_pool.submit(s.probe_func, cand_song, target_plat, 2.5)
  # Line 434-437:
  src.record_miss()
  ```
* **缺陷后果**：
  1. **平台 ID 绝不互通**：候选曲目携带的是特定平台的内部 ID（例如酷我数字 RID `5886682`）。将酷我 RID 传给网易云或 QQ 音乐的音源脚本探测，结果**必定 100% 失败**。
  2. **严重阻塞与延迟雪崩**：每批双核冲刺等待 2.5 秒，跨平台遍历 30+ 个音源会导致单次歌曲解析出现长达数十秒的无意义超时等待。
  3. **健康度恶性降级**：跨平台音源因无法识别异构 ID 失败后，执行 `src.record_miss()`，导致原本完全正常的网易云/QQ 音源被无辜扣分、标记失败、甚至降级停用！
* **整改方案**：
  - 音源寻链必须严格限定在 `cand_song` 目标平台的可用音源队列中；
  - 严禁向单一平台音源传递其他平台的内部 ID；若需跨平台兜底，必须在服务端重新基于歌名歌手触发目标平台的歌曲检索以换取合法 ID。

---

### 1.5 音源脚本缓存命名与清理机制缺陷导致陈旧文件堆积与版本错配
* **问题定位**：[`sync_sources.py`](file:///home/yytak/gd/MyFiles/project/Amusic/sync_sources.py#L43-L48, #L132-L146)、[`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py#L329-L334) 与 [`.github/workflows/daily_sync.yml`](file:///home/yytak/gd/MyFiles/project/Amusic/.github/workflows/daily_sync.yml#L37)
* **代码实据**：
  ```python
  # sync_sources.py: 命名包含序号
  filename = f"{seq:02d}_{safe_name}_{sid}.js"

  # 清理逻辑仅按 sid 判断:
  if sid not in active_sids:
      os.remove(...)  # 若 sid 在 active_sids 中但 seq 改变，旧文件完全不被清理！

  # source_manager.py: 随意匹配第一个文件
  target_file = next((f for f in cached_files if sid[:8] in f), None)
  ```
* **缺陷后果**：
  1. `sources_cache/` 目录下已堆积了 73 个脚本文件（实际仅 32 个音源），存在大量历史版本共存（例如 `05_全豆要..._d5f3b500.js`、`06_全豆要..._d5f3b500.js`、`24_全豆要..._d5f3b500.js`）。
  2. GitHub Actions 每日流水线将这些无用重复文件持续提交至 Git 仓库，造成仓库永久膨胀。
  3. `source_manager.py` 使用 `next()` 从文件列表中取出的文件顺序依赖底层文件系统遍历，极易绑定到**陈旧未更新的历史版本**，导致上游音源修复无法生效。
* **整改方案**：
  - 统一命名为 `source_{sid}.js`，或在下载写入前清理同 `sid` 的任意历史文件；
  - `source_manager` 匹配时优先挑选文件修改时间最新（`os.path.getmtime`）的脚本。

---

## 二、 P1 级安全漏洞与网络防护隐患 (Security & SSRF)

### 2.1 `/api/stream_proxy` 存在任意服务端请求伪造 (SSRF) 与本地系统文件读取漏洞
* **问题定位**：[`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py#L224-L247) 与 [`api/index.py`](file:///home/yytak/gd/MyFiles/project/Amusic/api/index.py#L17-L25)
* **代码实据**：
  ```python
  target_url = qs.get("url", [""])[0]
  req = urllib.request.Request(target_url, headers={"User-Agent": USER_AGENT})
  with urllib.request.urlopen(req, timeout=20) as resp:
      # 直接向客户端吐流
  ```
* **缺陷后果**：
  1. `urllib.request.urlopen` 原生支持 `file://` 协议，攻击者构造 `/api/stream_proxy?url=file:///etc/passwd` 即可直接读取并回显服务器敏感系统文件！
  2. 攻击者可构造 `http://127.0.0.1:xxx` 或云厂商元数据服务（如 `http://169.254.169.254/`），对内网服务或云鉴权凭证执行未授权探测。
  3. `api/index.py` 直接继承自 `server.Handler`，导致云端 Vercel Serverless Function 同样暴露该漏洞。
* **整改方案**：
  - 协议头强制白名单：`if not (target_url.startswith('http://') or target_url.startswith('https://')):` 立即阻断并返回 403；
  - 目标地址防御：禁止代理私有 IP 段（`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` 等）；
  - 限制允许代理的目标 Host 为常见音频直链域名。

---

### 2.2 `/api/apple_curator` 与 `/api/apple_room` 缺少目标域名白名单校验
* **问题定位**：[`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py#L98-L121) 与 [`apple_catalog.py`](file:///home/yytak/gd/MyFiles/project/Amusic/apple_catalog.py#L21-L26)
* **代码实据**：`curator_url = qs.get("url", [""])[0]`，后端直接调用 `http_get_html(url)`，未对 URL 的域名与协议做任何限制。
* **整改方案**：严格校验 `url.startswith("https://music.apple.com/")`，非 Apple 官方域名直接返回 400 拦截。

---

### 2.3 `lx_runner.js` 使用原生 `eval()` 执行第三方脚本无沙箱隔离
* **问题定位**：[`lx_runner.js`](file:///home/yytak/gd/MyFiles/project/Amusic/lx_runner.js#L114-L120)
* **代码实据**：`eval(scriptCode)` 在主作用域直接执行外部拉取的第三方 JS 音源脚本。
* **缺陷后果**：若外部音源库（lx-hub）受到投毒或劫持，脚本可通过 `process`、`require('child_process')` 在宿主机器执行任意系统命令。
* **整改方案**：改用 Node.js 内置 `vm.runInNewContext(scriptCode, sandbox, { timeout: 2500 })`，隔离敏感宿主全局对象。

---

### 2.4 模块导入时同步阻塞外部网络请求造成冷启动严重延迟
* **问题定位**：[`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py#L310-L313)
* **代码实据**：
  `SourceManager.__init__` 在被导入时直接调用 `self.sync_from_lx_hub()`，执行同步网络请求：
  `with urllib.request.urlopen(req, timeout=5) as r:`
* **缺陷后果**：在本地启动或 Vercel Serverless 冷启动阶段，主进程被强制阻塞等待 GitHub Pages 响应，最长阻塞 5 秒。国内网络环境下若访问 GitHub Pages 抖动，接口直接发生冷启动超时。
* **整改方案**：`__init__` 中直接读取已缓存的 `sources_ranking.json` 与本地脚本目录，将云端同步完全交由 GitHub Actions 每日自动完成，或者在后台线程中异步探测。

---

## 三、 P1 级性能瓶颈与高并发资源开销 (Performance & Resources)

### 3.1 本地服务启动时双重重复全量测速造成冷启动拥堵
* **问题定位**：[`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py#L279) 与 [`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py#L370)
* **代码实据**：
  ```python
  # source_manager.py (Line 279)
  threading.Thread(target=self.test_all, daemon=True).start()

  # server.py (Line 370)
  threading.Thread(target=source_hub.test_all, daemon=True).start()
  ```
* **性能后果**：启动瞬间两组多线程同时对 36+ 音源执行就地打测，并发瞬间产生 70+ 个探针请求与 Node.js 进程，浪费带宽并引发线程状态竞态。
* **整改方案**：消除重复启动，并在 `SourceManager` 内部增加 `self._is_testing` 互斥保护标志。

---

### 3.2 歌曲多平台轻量检索采用阻塞式串行执行
* **问题定位**：[`song_search.py`](file:///home/yytak/gd/MyFiles/project/Amusic/song_search.py#L237-L287)
* **代码实据**：酷我检索通道（超时 2.0s）与网易云检索通道（超时 2.0s）为单线程先后串行执行。若前序平台网络抖动，耗时线性叠加。
* **整改方案**：使用 `ThreadPoolExecutor(max_workers=2)` 并发查询酷我与网易云，合并打分排序，将检索响应时间降低 50% 以上。

---

### 3.3 客户端批量 ZIP 打包采用全内存驻留模式存在 OOM 崩溃隐患
* **问题定位**：[`js/download.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/download.js#L260-L300)
* **代码实据**：遍历将各曲目 `Uint8Array` 存入数组，再组装 `local` 头部，最后分配 `finalBuf = new Uint8Array(totalLen)` 二进制合并。产生 3 倍数据体积的连续内存堆叠。
* **整改方案**：
  1. 对批量打包设置安全上限（例如单批次上限 20 首）；
  2. 下载过程增加并发拉流控制（2~3 任务并发，避免全串行等待）；
  3. 超过上限时提示用户分批下载或单曲保存。

---

### 3.4 SWR 本地存储缓存淘汰算法 `cleanOldest` 误杀活跃数据
* **问题定位**：[`js/api.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/api.js#L44-L54)
* **代码实据**：`keys.slice(0, 25).forEach(...)` 直接按 `localStorage.key(i)` 遍历顺序淘汰前 25 个 Key，而非访问时间戳。
* **整改方案**：读取每个条目内保存的 `time` 字段，按 `time` 升序排序，严格按 LRU 原则淘汰最久未更新的旧缓存。

---

### 3.5 播放器 `<audio>` 媒体流加载异常无重试与容灾顺延
* **问题定位**：[`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js#L124-L130)
* **代码实据**：
  ```javascript
  this.audio.addEventListener('error', (e) => {
      ...
      this._emit('stateChange', { isPlaying: false, isResolving: false, error: "音频流加载异常" });
  });
  ```
* **缺陷后果**：当 `/api/resolve` 解析出的直链在播放时遭遇防盗链拦截（403）、临时断链或 CORS 异常时，播放器直接停止出声并报错，没有像解析失败时那样尝试备用候选源或自动顺延下一首。
* **整改方案**：在 `error` 事件中增加容灾重试逻辑：若为歌单连播中遇到音频流错误，自动向后顺延或尝试二次解析。

---

## 四、 P2 级播放器体验与移动端全场景完善 (Player & UX QoL)

### 4.1 缺乏 W3C 标准 `navigator.mediaSession` 系统媒体中枢集成
* **现状分析**：[`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js) 未接入 MediaSession API。
* **体验痛点**：手机锁屏不显示歌名封面、蓝牙耳机/车载中控物理切歌按键无法控制网页播放器。
* **整改方案**：接入 `navigator.mediaSession`，绑定 `metadata` 与 `play`, `pause`, `previoustrack`, `nexttrack` 操作句柄。

---

### 4.2 桌面端曲目行双击 (`dblclick`) 极速直接开播支持
* **现状分析**：遵循“方案 B”，单击曲目行无反应（防误触）。桌面端鼠标用户无法通过双击快速播放歌曲，必须先勾选再点击右上角播放。
* **整改方案**：在 `js/right.js` 中补充 `dblclick` 监听器，双击直接调用 `playSong(idx)` 起播；触屏设备保持单击无反应。

---

### 4.3 随机播放 (`shuffle`) 模式下后台预解析目标曲目错位
* **现状分析**：[`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js#L214) 预解析固定取 `currentIndex + 1`，随机播放模式下实际切歌目标与预解析目标不一致，导致随机切歌无法命中 0ms 预解析秒开。
* **整改方案**：在 `_schedulePrefetch` 中判断播放模式，若为 `shuffle` 则提前随机确定下一首目标进行预解析。

---

### 4.4 随机播放缺乏历史回溯栈 (点“上一曲”体验不佳)
* **现状分析**：[`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js#L475) 中点“上一首”始终执行 `currentIndex - 1`，随机模式下无法回到刚才播放的歌曲。
* **整改方案**：维护播放历史栈 `this.historyStack = []`，切歌时压栈，`prev()` 时优先出栈回退。

---

### 4.5 右侧歌单未勾选状态未遵循规范渲染自建歌单删除按钮
* **现状分析**：[`SITE_ARCHITECTURE.md`](file:///home/yytak/gd/MyFiles/project/Amusic/SITE_ARCHITECTURE.md#L71) 明确规范“自建歌单显示 `✕` 删除歌单”，而 [`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js#L280) 中始终渲染 `＋`（分组管理/收藏）。
* **整改方案**：当 `isViewingCustomPlaylist === true` 时，将右侧操作按钮呈现为 `✕`（删除当前自建歌单），与架构规范对齐。

---

## 五、 P2 级代码健康度、冗余清理与可维护性 (Code Smells & Tech Debt)

### 5.1 冗余重复代码与孤儿样式清理
1. **`song_search.py` 双重 return**：第 372-373 行连续两次 `return lines`，移除无效重复代码。
2. **`css/right.css` 历史第 5 列孤儿样式**：第 269-326 行定义了已废弃的 `.track-action-col`、`.btn-track-action` 等样式类，建议彻底清理。
3. **`js/search.js` 未使用变量**：第 58 行声明了 `const sf` 但未传递给 `window.apiRequest`。

---

### 5.2 `server.py` 测试接口欺骗性伪造状态与延迟
* **问题定位**：[`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py#L183, #L264)
* **代码实据**：
  `lat = round(s.latency_ms, 1) if is_real_ok else (38.0 + (idx % 12) * 6.0)`，并将 `status` 强制覆盖为 `"ok"`。
* **影响分析**：掩盖了实际失效的音源，让前端面板显示虚假的“全量就绪”绿色状态，阻碍运维与音源失效排查。
* **整改方案**：真实透传各音源实测的 `status` 与 `latency_ms`。

---

### 5.3 `requirements.txt` 声明未使用的幽灵依赖 `urllib3`
* **问题定位**：[`requirements.txt`](file:///home/yytak/gd/MyFiles/project/Amusic/requirements.txt#L2)
* **代码实据**：整个项目后端全部使用标准库 `urllib.request` 与 `urllib.parse`，没有任何 Python 文件导入 `urllib3`。
* **整改方案**：清空或移除无用依赖声明，加速 Vercel 部署安装构建耗时。

---

## 六、 P3 级云端部署与离线降级兼容性 (Cloud & Fallback)

### 6.1 Vercel Serverless 环境与 Node.js 沙箱脚本兼容性防护
* **现状分析**：Vercel 的 Python 运行时无预装 Node.js，调用 `subprocess.run(["node", ...])` 会抛出 `FileNotFoundError`。
* **整改方案**：在 `source_manager.py` 初始化时检测是否存在 `node` 可执行文件与环境变量 `VERCEL`，在无 Node 环境下自动旁路 LX 脚本，专注于 4 大原生直连通道。

---

### 6.2 无 C 库运行环境下的繁简转换字典扩容
* **现状分析**：[`song_search.py`](file:///home/yytak/gd/MyFiles/project/Amusic/song_search.py#L62-L67) 的 `FALLBACK_CHAR_MAP` 仅有 24 个常见字，在无 `libopencc.so` 的轻量运行环境中面对热门繁体歌曲匹配率下降。
* **整改方案**：将应急字典扩充至 300~500 个常用华语流行音乐高频繁简对照字。

---

## 七、 优化任务执行排期与优先级总表

| 序号 | 优化事项 | 影响维度 | 涉及核心文件 | 优先级 |
| :---: | :--- | :---: | :--- | :---: |
| **1** | **修复备份导出二次下载与 `[object Object]` 损坏** | 数据安全 / 功能正常 | [`js/backup.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/backup.js) ｜ [`js/storage.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/storage.js) | **P0** |
| **2** | **修复自建歌单删除曲目参数错配问题** | 数据 CRUD 缺陷 | [`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js) ｜ [`js/storage.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/storage.js) | **P0** |
| **3** | **补全自建歌单前台移出歌曲的交互操作入口** | 用户交互功能闭环 | [`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js) | **P0** |
| **4** | **修复音源跨平台 ID 错配与健康度误伤缺陷** | 寻链核心正确性与耗时 | [`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py) | **P0** |
| **5** | **规范音源脚本缓存命名与清理，防陈旧废弃源堆积与错配** | 音源寻链与仓库健康 | [`sync_sources.py`](file:///home/yytak/gd/MyFiles/project/Amusic/sync_sources.py) ｜ [`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py) | **P0** |
| **6** | **加固 `/api/stream_proxy` 与 Apple URL 校验，防御 SSRF 与系统文件穿透** | 服务端接口安全 | [`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py) ｜ [`apple_catalog.py`](file:///home/yytak/gd/MyFiles/project/Amusic/apple_catalog.py) ｜ [`api/index.py`](file:///home/yytak/gd/MyFiles/project/Amusic/api/index.py) | **P1** |
| **7** | **消除模块导入时同步外部网络阻塞，加速冷启动** | 启动响应时间 | [`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py) | **P1** |
| **8** | **消除本地启动时双重全量测速并发竞争** | 服务冷启动性能 | [`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py) ｜ [`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py) | **P1** |
| **9** | **酷我与网易云轻量候选检索改为多线程并发** | 接口吞吐与响应延迟 | [`song_search.py`](file:///home/yytak/gd/MyFiles/project/Amusic/song_search.py) | **P1** |
| **10** | **批量打包下载增设安全首数限制，防止大数组拉流 OOM** | 前端内存健壮性 | [`js/download.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/download.js) | **P1** |
| **11** | **修复 SWR 缓存清理策略，按真实时间戳由旧到新淘汰** | 缓存有效命中率 | [`js/api.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/api.js) | **P1** |
| **12** | **播放器 `<audio>` 媒体流加载异常增加容灾与顺延机制** | 播放状态机健壮性 | [`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js) | **P1** |
| **13** | **集成标准 `navigator.mediaSession` (支持锁屏/蓝牙耳机控制)** | 跨设备核心播放体验 | [`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js) | **P2** |
| **14** | **曲目行支持桌面端双击 (dblclick) 快速开播** | 桌面端交互提效 | [`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js) | **P2** |
| **15** | **随机播放模式下预解析目标曲目对齐与历史回溯栈** | 播放状态机精细化 | [`player.js`](file:///home/yytak/gd/MyFiles/project/Amusic/player.js) | **P2** |
| **16** | **遵循规范在自建歌单头部渲染删除歌单入口** | 交互规范统一性 | [`js/right.js`](file:///home/yytak/gd/MyFiles/project/Amusic/js/right.js) ｜ [`SITE_ARCHITECTURE.md`](file:///home/yytak/gd/MyFiles/project/Amusic/SITE_ARCHITECTURE.md) | **P2** |
| **17** | **清理冗余代码、死样式与幽灵依赖** | 代码整洁与构建优化 | [`song_search.py`](file:///home/yytak/gd/MyFiles/project/Amusic/song_search.py) ｜ [`css/right.css`](file:///home/yytak/gd/MyFiles/project/Amusic/css/right.css) ｜ [`requirements.txt`](file:///home/yytak/gd/MyFiles/project/Amusic/requirements.txt) | **P2** |
| **18** | **移除测速接口伪造延迟与状态的欺骗逻辑** | 真实监控与健康度 | [`server.py`](file:///home/yytak/gd/MyFiles/project/Amusic/server.py) | **P2** |
| **19** | **扩充无 C 库环境繁简转换字典至 300+ 高频字** | 跨平台降级兼容性 | [`song_search.py`](file:///home/yytak/gd/MyFiles/project/Amusic/song_search.py) | **P3** |
| **20** | **Vercel Serverless 环境自动跳过 Node.js 子进程探测** | 云端托管部署健壮性 | [`source_manager.py`](file:///home/yytak/gd/MyFiles/project/Amusic/source_manager.py) | **P3** |
