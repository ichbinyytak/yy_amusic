# 🧪 Amusic 自动化验证与回归测试集 (tests/)

本目录集中存放项目端到端验证、出声嗅探与全链路回归脚本。

## 脚本清单与职责

| 脚本文件 | 适用场景与职责 | 运行方式 |
| :--- | :--- | :--- |
| **`test_p0_headless.js`** | **P0 核心可用性检验**：以无头 Chrome 自动化验证核心功能（搜索、点击播放、真实音频流出声状态） | `node tests/test_p0_headless.js` |
| **`test_prod_play.js`** | **生产环境真实出声嗅探**：模拟真实用户访问生产环境（`https://amusic.hefang.fun`），自动加载并验证 `<audio>` 物理出声时间 | `node tests/test_prod_play.js` |
| **`test_kpop_playlist.js`** | **歌单导入与防串曲专项测试**：针对复杂歌单进行逐曲解析点播与 11 秒假音频拦截测试 | `node tests/test_kpop_playlist.js` |
| **`test_headless.js`** | **全流程 CDP 排错与控制台报错检测**：验证全流程无异常无控制台报错 | `node tests/test_headless.js` |

## 运行前提
- 本地安装 Node.js 环境（测试脚本使用纯 Node.js 标准库，零三方 npm 依赖）；
- 系统安装有 Google Chrome / Chromium 浏览器（用于 CDP 无头通信）。
