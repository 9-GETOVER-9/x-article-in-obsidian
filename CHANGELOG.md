# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。所有版本兼容 Obsidian `1.6.0+`。

> 该 CHANGELOG 为 2026-05-15 回填，由 git history 整理而来。1.0.7 与 1.0.14 未打 tag（在 versions.json 中登记），变更内容并入相邻发布说明。

---

## [1.0.17] - 2026-05-05

### Fixed
- 在 macOS GUI 环境下解析 `npx` 为绝对路径，修复从 Obsidian GUI 启动时找不到 Node 工具链的问题。

## [1.0.16] - 2026-05

### Fixed
- 拆分 `mcpServers` 命令字符串，剥离嵌套 token 前缀，修复在 MCP 客户端配置中传递组合命令时的解析错误。

## [1.0.15] - 2026-05

### Added
- 支持嵌套的 frontmatter 字段 `formatter.title` / `formatter.cover`，允许用户把文章标题与封面集中写在 `formatter:` 块下。

### Docs
- 澄清 draft 上传工作流。

### Tests
- e2e 测试新增可见彩色 PNG 作为图片 fixture，便于人眼审查渲染结果。

## [1.0.14] - 2026-05

> 未打独立 tag，登记在 versions.json，变更随 1.0.15 一并发布。

### Fixed
- 在 GUI 启动的 macOS / Linux Obsidian 环境下，探测 login shell PATH 以可靠定位 Node。
- 标记删除前先 focus 编辑器再设置 selection，避免删除失败。
- MPH 标记匹配走精确 token 边界，消除模糊匹配带来的误删 / 误插入。

### Tests
- 扩展 marker 检查覆盖；新增 shell-path probe 回归测试套件。

## [1.0.13] - 2026-04

### Fixed
- Obsidian 发布前置检查可靠检测 Node 是否可用，给出清晰的诊断信息。

### Docs
- 澄清插件 release 仓的角色；记录 workspace 迁移说明。

## [1.0.12] - 2026-04

### Added
- 自动应用封面设置，优化封面上传流程（用户在 frontmatter 指定 cover 后自动填入文章封面）。

## [1.0.11] - 2026-04

### Performance
- 新增图像资产并发限制器，避免大量图片同时下载/上传拖垮发布流程。

## [1.0.10] - 2026-04

### Changed
- 优化文件输入选择逻辑，确保 file picker 正确获取媒体文件。
- 更新功能简介文案，描述更精炼，去掉冗余信息。

## [1.0.9] - 2026-04

### Added
- 新增调试日志功能，记录发布过程中的详细信息；UI 提供"打开日志文件"快捷入口。

## [1.0.8] - 2026-04

> 该版本主要为版本号与文档同步。

## [1.0.7] - 2026-04

> 未打独立 tag，登记在 versions.json，变更随 1.0.8 一并发布。

### Added
- README 加入快速使用指南与 Node.js 环境提示，并显式说明运行时要求。

### Changed
- 文档增强错误提示信息，让 Node 环境缺失场景下用户更容易自助排查。

## [1.0.6] - 2026-04

### Changed
- 插件正式更名为 **"X Article in Obsidian"**（原名 "X Article Preview"），manifest / README / 相关文档同步更新。

## [1.0.5] - 2026-04

### Added
- 新增封面 (cover) 和标题 (title) 处理能力，优化文章预览卡片渲染（按 frontmatter / 第一个 H1 / 第一张图自动识别）。

### Fixed
- 清理 temp 历史，稳定 lint 流水线。

## [1.0.4] - 2026-04

### Added
- 文章预览侧栏新增 **发布功能 + 工具栏**：一键调用浏览器/MCP 路径推草稿到 X 文章编辑器。
- 引入 **国际化（i18n）** 框架，UI 文本与错误提示支持多语言。
- 设置面板新增 **Playwright Token 管理**，配置浏览器自动化所需凭据。

### Changed
- 优化用户提示文案；MCP 评估超时可配置。
- 浏览器发布流程精简：移除多余锚点创建逻辑，统计处理项数量并改进错误处理。

## [1.0.3] - 2026-04

### Added
- 实现 **通过浏览器 MCP (Model Context Protocol) 发布** 功能，把 Obsidian 文档推送到 X 文章编辑器。
- 新增 MCP 工具可用性检查、删除/插入标记、标记回归校验等能力。
- 文章预览卡片可一键复制发布脚本。

### Fixed
- 优化 MCP 发布命令组装；忽略临时目录避免脏数据。

## [1.0.2] - 2026-04

### Changed
- 配置 GitHub Actions 权限与环境变量，支持自动构建发布。

## [1.0.1] - 2026-04

### Added
- README 加入安装与发布说明。
- 配置 GitHub Actions 自动构建并发布 release artifact。

## [1.0.0] - 2026-04

首个公开发布版本。

### Added
- Obsidian 侧栏中以 X Article 排版风格预览当前 Markdown 文档，支持与编辑器**同步滚动**。
- 内嵌富媒体：图片、Twitter post embed（带 loading 态与回退）、引用块、代码块（含一键复制按钮）。
- 文章预览模板：Hero card 设计、段落 / 分隔线映射、外链图标隐藏、卡片宽度自适应。
- Twitter post embed 缓存层，避免重复请求。
- 插件首次命名为 "X Article Preview"（1.0.6 起更名为 "X Article in Obsidian"）。

---

## 维护说明

- 每次发版统一修改 `manifest.json` / `package.json` / `versions.json` 三处版本字段（`version-bump.mjs` 已自动化）。
- 用户面变更写到本文件**对应版本段**，使用 Added / Changed / Fixed / Removed / Security / Performance / Docs / Tests 分组。
- 历史版本若未打 tag（如 1.0.7 / 1.0.14），并入下一个 tagged 版本的发布段，注明"登记在 versions.json，变更随下一版发布"。
- 写"为什么改"而不是只写"改了什么"，方便用户判断是否要升级。
