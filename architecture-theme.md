# 🎨 Amusic 多主题切换架构设计书

> **文档状态**：方案设计稿（已确认色板与入口位置，暂未改动任何业务代码）  
> **对齐基准**：沿用「零三方依赖原生 CSS 变量 + `localStorage` 即时持久化 + 首屏零闪烁」原则。

---

## 一、 核心设计边界与已拍板决策

1. **入口位置（顶部右上角 `.header-right`）**
   - 在 [index.html](./index.html) 的 `.header-right`（`⚡` 音源监控按钮旁）新增一个 `26×26` 紧凑图标按钮 **`🎨`**（`#btnThemeToggle`），视觉体量与 `⚡` 完全一致，兼容后续预留的顶部用户名按钮宽度与手机窄屏空间。
   - 点击按钮就地弹出轻量色块下拉菜单（右对齐 `right: 0`，避免窄屏溢出右边界），支持点击外部或按 `ESC` 关闭。
2. **7 套主题色板（深浅覆盖，全部收录）**
   - 默认主题继续保持现网的 **暗夜黑（`dark`）**，新增 **午夜深蓝、极简纯白、晴空浅蓝、护眼暖米、薄荷浅绿、樱花浅粉** 共 7 套主题：

| 主题 ID | 展示名称 | 类型 | 页面主底色 (`--bg-main`) | 面板/卡片底色 (`--bg-surface`) | 次级/子面板底色 (`--bg-sub`) | 主文字色 (`--text-primary`) | 主强调色 (`--accent` / `--accent-apple`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `dark` *(默认)* | **暗夜黑** | 深色 | `#0d1117` | `#161b22` | `#11141a` | `#e6edf3` | `#58a6ff` / `#fa2d48` |
| `midnight` | **午夜深蓝** | 深色 | `#0b1120` | `#131c31` | `#0f172a` | `#e2e8f0` | `#38bdf8` / `#f43f5e` |
| `light` | **极简纯白** | 浅色 | `#f5f5f7` | `#ffffff` | `#eef0f4` | `#1d1d1f` | `#0071e3` / `#fa2d48` |
| `sky` | **晴空浅蓝** | 浅色 | `#edf5fc` | `#ffffff` | `#e2effa` | `#172b4d` | `#0969da` / `#e11d48` |
| `warm` | **护眼暖米** | 浅色 | `#f6f1e7` | `#fbf8f1` | `#ede5d5` | `#3b3328` | `#b45309` / `#d9463e` |
| `mint` | **薄荷浅绿** | 浅色 | `#eef7f3` | `#ffffff` | `#e0f0e9` | `#163026` | `#1a7f37` / `#e11d48` |
| `pink` | **樱花浅粉** | 浅色 | `#fdf2f6` | `#ffffff` | `#f9e4ec` | `#3b1d2a` | `#db2777` / `#e11d48` |

3. **持久化与防闪烁（Zero-FOUC）**
   - 用户选中的主题 ID 持久化至 `localStorage`（键名 `amusic_theme`），保留在浏览器本地，不消耗 Vercel KV 云同步额度。
   - 在 [index.html](./index.html) `<head>` 最顶部（加载 CSS 之前）放置 3 行同步内联脚本，提前读取 `localStorage.getItem('amusic_theme')` 并写入 `document.documentElement.dataset.theme`，彻底杜绝刷新网页时从黑闪白（或从白闪黑）的视觉闪烁。

---

## 二、 语义化 CSS 变量体系改造蓝图

现网代码全站存在约 90 处硬编码色值（如 `#161b22`、`#141820`、`#11141a`、`#fff`、`rgba(255,255,255,0.06)` 等）。为防止浅色主题出现“白底黑条”或“白字隐身”，必须先做一次完整的变量收口。

### 1. 统一扩展 `:root` 与 `[data-theme="..."]` 变量（[css/base.css](./css/base.css)）
在现有 `--bg-main` / `--bg-surface` / `--border-color` / `--text-primary` 基础上，补齐以下语义变量并按 7 套主题分别配置：

- **层级背景**：
  - `--bg-elevated`（顶部栏、底栏、弹窗、抽屉头，如深色 `#161b22`，浅色 `#ffffff`）
  - `--bg-sub` / `--bg-sub-deep`（二级/三级手风琴与工具条，如深色 `#141820` / `#11141a`）
  - `--bg-input`（搜索框与弹窗 `<input>` 底色）
  - `--bg-overlay-soft`（徽标底色、列表交替浅底，深色用 `rgba(255,255,255,0.05)`，浅色用 `rgba(0,0,0,0.05)`）
  - `--bg-backdrop` / `--shadow-popup`（遮罩与弹出层阴影，浅色阴影需适当减轻透明度）
- **文字与高亮状态**：
  - `--text-strong`（替代写死的 `#fff`，深色 `#ffffff`，浅色 `#111827` 等高对比度深色）
  - `--playing-row-bg` / `--playing-row-text`（正在播放高亮行：深色保持 `#7ee787` 绿字，浅色采用深绿 `#116329` / 深蓝 `#0550ae` 保证强可读性）
  - `--selected-row-bg`（多选勾选行底色）
  - `--danger-text`（删除/异常提示文字：深色 `#ff7588`，浅色 `#cf222e`）
- **滚动条与浏览器原生控件**：
  - 按主题设置 `color-scheme: dark`（`dark` / `midnight`）与 `color-scheme: light`（其余 5 套浅色主题），保证原生滚动条、下拉框与系统控件自动匹配。

### 2. 硬编码色值清理清单（已全站扫描定位）
1. **[css/base.css](./css/base.css)**：
   - 替换 `.brand-text h1`、`.queue-drawer-title`、`.source-drawer-title`、`.context-menu-item:hover`、`.btn-primary`、`#161b22`、`#fff`、`rgba(255,255,255,...)` 等硬编码颜色为对应语义变量；
   - 补齐 `.toast` / `.toast.show` 悬浮提示样式并接入主题变量；
   - 将 `.progress-bar-bg` 底轨、`#0b0e12` / `#080a0d` 歌词栏与 `#7ee787` 歌词高亮色替换为语义变量，防止浅色模式下底轨隐身或底部留出黑条；
   - 为浅色主题单独标定 `--bg-elevated` 与边框/阴影对比度，并在 `@media (max-width: 768px)` 下将 `.search-bar-compact input` 设为弹性窄屏宽度以容纳 `🎨`、`⚡` 与后续用户名按钮。
2. **[css/left.css](./css/left.css)**：替换 `.left-tabs-nav`、`.left-view-toolbar-row`、`.top-accordion-hdr`、`hover`、`.region-dropdown-menu`（`#1c2128`）、`.sub-accordion-hdr`（`#161b22`、`#141820`、`#1c222b`、`#13171e`、`#1a202a`、`#11141a`）、`.btn-lib-text-action:hover`、`.lib-tool-btn:hover`（`#fff`）及 `.library-group-row` 硬编码背景色，并新增 `.sub-accordion-hdr.level-4` 样式。
3. **[css/right.css](./css/right.css)**：替换 `.detail-title-group h2`（`#fff`）、`.track-table th`（`rgba(0, 0, 0, 0.25)`）、正在播放行 `#7ee787`、选中行背景与阴影。
4. **[index.html](./index.html)**：移除 4 个弹窗 `<input>` 与 `#batchDownloadSongList` 内联 `style` 里写死的 `color:#fff` 与 `background:rgba(0,0,0,0.2)`，改为 CSS 类控制。
5. **JS 内联样式清理**：
   - [js/region.js](./js/region.js#L428)：移除 `subHdr.style.backgroundColor = "#0e1117"` 硬编码，交由 `.sub-accordion-hdr.level-4` CSS 类统一控制（浅色主题下不再出现黑条）。
   - [js/modals.js](./js/modals.js#L64) 与 [js/search.js](./js/search.js#L192)：将写死的 `#ff7588`、`rgba(88,166,255,0.15)` 与 `rgba(255,255,255,0.05)` 改为 `var(--danger-text)` / `var(--accent-soft-bg)` / `var(--border-subtle)`。
   - [js/left.js](./js/left.js#L416)：专辑标签 `#e3b341` 改为 `var(--tag-album-color)`（浅色主题下改深琥珀色 `#9a6700`，避免浅黄字在白底上看不清）。
   - [js/shell.js](./js/shell.js#L699)：修复未定义变量 `var(--text-main)` 为 `var(--text-primary)`。

---

## 三、 组件结构与交互实现蓝图

### 1. 顶部主题按钮与选择浮层（[index.html](./index.html) + [css/base.css](./css/base.css)）
- 在 `.header-right` 放置：
  ```html
  <div class="theme-switcher-wrapper" id="themeSwitcherWrapper">
      <button class="btn btn-sm btn-secondary btn-header-theme" id="btnThemeToggle" title="切换页面主题" aria-label="切换页面主题">🎨</button>
      <div class="theme-dropdown-menu" id="themeDropdownMenu"></div>
  </div>
  ```
- 浮层每行包含：
  - 主题色预览小圆点（双拼色或主背景+强调色圆点）；
  - 主题中文名称；
  - 当前选中项右侧显示 `✓` 高亮。

### 2. 主题管理器（可内置于 [js/shell.js](./js/shell.js) 或独立 `js/theme.js`）
- 维护 `THEMES` 静态配置表（7 套主题元数据）。
- `applyTheme(themeId)`：
  - 校验合法性（非法则回退 `"dark"`）；
  - 更新 `document.documentElement.dataset.theme = themeId`；
  - 同步写入 `localStorage.setItem("amusic_theme", themeId)`；
  - 高亮菜单中的当前激活项，并在切换后自动收起菜单。
- 事件绑定：点击 `#btnThemeToggle` 开关菜单；点击页面其他位置或按 `Escape` 自动关闭；同步升级 `index.html` 受影响 CSS/JS `?v=` 版本号以绕开强缓存。

---

## 四、 上线前验收清单（实施后必测项）

1. **7 套主题全页面可读性逐一核对**：
   - 分别切换到 `dark`、`midnight`、`light`、`sky`、`warm`、`mint`、`pink`，依次检查：
     - 顶部导航栏、左侧双栏 Tab（`网站推荐 | 我的音乐库`）、`Apple 专区` 4 级嵌套手风琴（重点核查原 `#0e1117` 子分类条）、`街声` 榜单/歌单卡片；
     - 右侧曲目表（含正在播放高亮行、长按/右键多选高亮行、歌手/专辑文字、底部批量操作）；
     - 底部播控栏、进度条、两行/展开态歌词栏（当前句/下一句/历史句对比度）；
     - 各类弹窗（添加到歌单、收藏分类、批量下载清单、重命名/确认弹窗 `<input>` 输入字色）与底部队列/音源抽屉。
2. **零闪烁与持久化检查**：
   - 选择 `sky`（晴空浅蓝）或 `pink`（樱花浅粉）后强制刷新页面，首屏直接渲染对应浅色背景，不出现黑底闪一下再变白的情况。
3. **手机窄屏兼容性检查**：
   - 375px 宽度下顶栏搜索框 + `🎨` + `⚡` 按钮单行不换行、不溢出、下拉菜单不超出屏幕右边缘。
