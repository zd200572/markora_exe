# Markora (Windows 便携桌面版)

> 一个本地优先、所见即所得的 Markdown 写作应用，还原 Typora 般清爽而专注的编辑体验。  
> 本版本为经过定制与轻量化打包的 **Windows 便携桌面版**，开箱即用，无需配置环境。

---

## ✨ 核心特性

- **所见即所得编辑**：即时渲染排版，支持所见即所得与 Markdown 源码双模式自由切换。
- **便携单文件运行**：单文件绿色版（约 24.9 MB），无须安装 Python、Node.js 或 C++ 运行库，拷贝即可在 Windows 10 / 11 运行。
- **秒级启动与平滑过渡**：去除黑屏控制台窗口，内置专属加载动画（Splash），页面就绪后极速平滑淡入（~350ms 优雅呈现）。
- **完善的导出支持**：
  - 📄 **导出 HTML**：调用原生系统保存对话框，导出带排版样式、响应式布局的独立 HTML 文档。
  - 🖨️ **导出 PDF**：专属打印优化样式（`@media print`），一键调起浏览器打印窗口，直接“另存为 PDF”。
- **文档与工作区管理**：
  - 支持创建、重命名、本地导入与保存 `.md` 文档。
  - 支持原生文件夹工作区浏览、实时目录树展示与按需加载。
- **专注写作工具箱**：
  - 实时大纲导航与标题跳转。
  - 专注模式（Focus Mode）与打字机滚动模式（Typewriter Mode）。
  - 浅色（纸质温润风）与深色（夜间高对比）外观主题无缝切换。
  - GFM 表格插入、任务清单（Checkbox）、代码高亮与字数统计。

---

## 🚀 快速使用

### 方式一：直接运行桌面客户端（推荐）

1. 双击运行目录下的 **`Markora.exe`** 或桌面快捷方式 **`Markora.lnk`**。
2. 即可进入原生独立窗口开始写作。
3. 可直接将 `Markora.exe` 复制分享至其他任意 Windows 10（2021年及之后版本）或 Windows 11 电脑，无需安装额外组件。

### 方式二：浏览器备用模式

1. 双击运行 **`start-markora.bat`**。
2. 系统将在后台启动轻量本地服务器并自动在默认浏览器中打开 `http://localhost:8002`。

---

## 🛠️ 快捷键与常用操作

| 操作 | 快捷键 / 入口 | 说明 |
| :--- | :--- | :--- |
| **新建文档** | `Ctrl + N` / 侧边栏新建 | 新建空白文稿 |
| **打开文档** | `Ctrl + O` / 顶部工具栏 | 打开本地 Markdown 文件 |
| **保存文档** | `Ctrl + S` / 顶部工具栏 | 保存当前文稿到本地文件 |
| **导出 HTML** | 顶部工具栏 `HTML` 按钮 | 弹出原生文件对话框保存完整 HTML |
| **导出 PDF** | 顶部工具栏 `PDF` 按钮 | 调起浏览器打印对话框一键转存 PDF |
| **切换源码模式** | 顶部工具栏 `{ }` 按钮 | 切换实时预览 / 纯文本 Markdown 源码 |
| **插入表格** | `Ctrl + T` | 快速插入 3x3 标准 Markdown 表格 |

---

## 🏗️ 源码架构与二次构建

本项目前端基于 React + TypeScript + Vite + TipTap 构建，桌面壳基于 `pywebview`（Microsoft Edge WebView2 内核）并由 PyInstaller 打包。

### 1. 安装前端依赖与构建

```bash
npm install
npm run build
```

构建产物将输出至 `dist/` 目录。

### 2. 本地调试桌面包装层

```bash
python markora_webview.py
```

### 3. 打包生成单文件 Executable

```bash
pyinstaller --noconfirm --clean --distpath distexe --workpath buildwork Markora.spec
```

打包完成后，单文件便携可执行文件位于 `distexe/Markora.exe`。

---

## 📁 目录结构

```text
matkora/
├── Markora.exe          # 便携式桌面应用程序（24.9 MB）
├── Markora.lnk          # 桌面启动快捷方式（带高分图标）
├── Markora.ico          # 高清应用图标
├── start-markora.bat    # 网页版备用启动脚本
├── index.html           # 前端单页入口（含极速平滑 Splash）
├── assets/              # 前端静态资源（JS/CSS）
├── HANDOFF.md           # 架构、维护与优化交接记录
└── README.md            # 项目使用与说明文档
```

---

## 📄 开源说明

本项目基于开源项目 [misswell/markora](https://github.com/misswell/markora) 进行 Windows 便携化重构与功能加固。
