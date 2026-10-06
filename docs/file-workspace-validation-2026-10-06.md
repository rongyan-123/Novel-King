# 小说资料工作台验收

## 测试先红后绿

- 小说卡片计数：原接口没有 `works[].total_files`，测试失败（undefined != 1）；实现后，各书文件数与共享文件数隔离通过。
- 编辑上传资料：原接口 `GET /files/:id/edit` 返回 404；实现编辑稿保存后，格式/全文搜索/重启/原件不变/冲突/只读边界通过。
- 浏览器入口：旧文件库不存在小说入口卡片，真实浏览器断言失败；新版按小说进入工作台，默认内容与左侧切换通过。
- 旧文件库备份：去掉新增编辑字段的备份还原返回 400（缺 edited_html）；修复后还原成功，文字与原件可继续编辑。

## 自动检查

- `node scripts/ci-offline-checks.mjs`：最终 57 组通过，0 组失败，零模型调用。
- 文件库公共 HTTP 验收：11 个测试覆盖独立原件、Word/PDF、小说隔离、编辑保存、冲突、移动/回收站及两类旧备份。
- Host Contract 1.23.0：26 通过、0 失败、1 跳过。跳过项是仓库没有 `.p1-baseline/data/novel.db` 的历史 schema 指纹，不能视为已验证；本轮旧备份兼容由隔离 HTTP 夹具实测。
- `node --check`：app.js、file-library.js、file-library.mjs、db.js、server.js 通过；`git diff --check` 通过。项目没有配置独立 typecheck/lint 脚本。

## 真实浏览器

使用 browser-harness、专属浏览器会话 `BU_NAME=novel-files-9237` 和隔离浏览器上下文，服务 `http://127.0.0.1:38470` 的独立数据目录。脚本为 `scripts/test-file-library-workspace-browser.py`，通过 browser-harness 的标准输入运行。

- 小说卡片、不同小说同名资料隔离，目录有文件时默认打开文字。
- 原生鼠标点击左侧切换文件，离开前保存；原生输入与粗体工具有效，刷新保留格式和位置。
- 空目录显示上传区域，浏览器文件选择上传后直接打开新内容。
- 模拟网络离线：保存失败保留编辑区，阻止切换文件/离开；恢复网络后刷新恢复本地稿并保存。
- 用 HTTP 模拟其他窗口同时保存：当前旧版本收到 409，服务器与本地草稿均保留。
- 桌面 1440×900、手机 390×844 无横向页面溢出；手机首次进入时目录收起，文件横向切换，上传与正文可用。

截图在临时目录 `novel-king-file-workspace-review/`，未作为项目文件提交。

## 作者数据

更新了 localhost:3740 预览服务，返回 Host Contract 1.23.0。重启前后 `/works`、`/volumes`、`/chapters`、`/characters`、`/terms`、`/world_entries` 的响应完全一致；没有使用作者的数据做上传、改稿或还原测试。

## 编辑边界

Word/PDF 编辑的是提取文字，原生排版不回写；原件与编辑稿下载分开。图片保留预览与原件，不能作为文字编辑。版本号用于冲突保护，并非完整历史版本。文件库仍没有开放新的资料 Agent 或扫榜采集任务。
