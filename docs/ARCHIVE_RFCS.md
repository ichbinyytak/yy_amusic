# 📦 Amusic 历史设计草案与 RFC 归档 (ARCHIVE_RFCS.md)

> **文档说明**：本文件归档了项目在各个演化阶段编写的专项 RFC 核心技术备忘。  
> **注意**：本项目唯一的现行事实来源为根目录的 [ARCHITECTURE.md](../ARCHITECTURE.md)，本文件仅作历史追溯参考。

---

## 1. 街声专区 (StreetVoice) RFC 备忘
* **官方接口契约**：
  * 即时排行：`https://streetvoice.com/api/v5/chart/realtime/{cat}/?limit=50`
  * 每周排行：`https://streetvoice.com/api/v5/chart/weekly/{cat}/?limit=50`
* **解密与脱壳**：
  * 街声流为原生 HLS。`.ts` 切片内为未加密 MP3 裸流。
  * 前端利用纯 JS（`hls.js` + ArrayBuffer 截取）在浏览器端解构打包，避免服务端带宽浪费。
* **双域名降级**：
  * 默认 `streetvoice.com`（192kbps），异常时自动回退 `streetvoice.cn`（96kbps）。

---

## 2. 外部歌单导入与转化 RFC 备忘
* **平台覆盖**：
  * 网易云 (`wy`)、QQ 音乐 (`tx`)、酷我 (`kw`)、汽水音乐、咪咕 (`mg`)、酷狗概念版 (`kg`)、Apple Music、街声、Spotify。
* **搜索框交互**：
  * 普通文本：按关键词检索 Apple Music 目录；
  * 分享口令/链接：静默拦截并路由至 `POST /api/import_playlist`，直接在右侧面板展示曲目预览。
* **安全与存储原则**：
  * 每一跳短链重定向必须经过 SSRF 防御校验；
  * 用户点击 `＋` 保存为 `customPlaylists` 本地自建歌单快照，不写外部死链。

---

## 3. 国内五大音乐榜单 (QQ/网易/酷我/酷狗/咪咕) RFC 备忘
* **官方直连端点**：
  * 企鹅：`https://u.y.qq.com/cgi-bin/musicu.fcg`
  * 网易：`https://music.163.com/api/toplist` 与 `/playlist/detail`
  * 酷我：`http://kbangserver.kuwo.cn/ksong.s`
  * 酷狗：`http://mobilecdnbank.kugou.com/api/v3/rank/list`
  * 咪咕：`https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/index/rank/detail`
* **缓存策略**：
  * 榜单分类缓存 24 小时，曲目列表缓存 12 小时。

---

## 4. 账户鉴权与云同步 RFC 备忘
* **密钥与哈希**：
  * PBKDF2-HMAC-SHA256 算法，迭代 100,000 次，16 字节随机 Salt。
  * 会话维持：HMAC-SHA256 签名 Cookie (`amusic_session`)，无状态验证。
* **存储边界**：
  * 仅同步自建歌单、收藏歌单和自定义分组，单用户上限严格限制在 512 KB。
  * 音量、历史位置、SWR 缓存仅保存在本地 `localStorage`。

---

## 5. 多主题配色 RFC 备忘
* **7 套色板**：`dark`（默认）、`midnight`、`light`、`sky`、`warm`、`mint`、`pink`。
* **防闪烁实现**：
  * 主题名存储于 `localStorage.amusic_theme`。
  * `index.html` 顶部内联预读脚本设置 `dataset.theme`，实现首屏零闪烁。
