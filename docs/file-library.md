# 文件库

侧栏「文件库」展示十个资料分区与真实作品概况。进入分区后，先选择共享资料或所属作品，再建文件夹、选文件上传或拖入文件。每次最多 100 个文件，单文件最大 20 MB；同名文件分别保留。参考书区的「书籍资料夹」按本计数，普通文件夹与附件不计为书。

TXT/Markdown 读取 UTF-8；DOCX 使用 Mammoth、PDF 使用 PDF.js 提取文本。扫描 PDF 不执行 OCR，旧 DOC 与其他格式保留原件。解析失败显示原因，原件仍可下载。PNG/JPEG/GIF/WebP 按内容签名预览。阅读按 20,000 字一页继续加载，正文不截掉；全文搜索跨当前分区的各目录，列表每页 100 个文件。作品概况显示真实章节、角色、设定和画布元素数，不推算剧情完成比例。

「管理」可改名或手动移动；「移入回收站」保留原件，误删可恢复。非空目录（包含回收站文件）不能删除。上传设定、人物或正文资料不会修改作品对应的数据。

## 存储与备份

默认目录为 `data/`，可通过 `NOVELSTUDIO_DATA_DIR` 指向独立数据目录：

- `novel.db`：目录、文件元数据、完整提取文本、回收站状态。
- `file-library/<UUID>`：完整原件，无嵌套第三方 Git。

**完整备份需同时复制数据库和 file-library 目录。** 既有「SQLite 备份」接口只备份数据库，不包含文件原件。复制运行中的数据库应使用 SQLite 备份接口获得一致快照，或停止服务后复制整个数据目录。回收站不永久清除原件。

还原升级前、不包含文件库表的旧备份时，当前文件库保留；所属作品已不在备份中的资料转为共享资料，原件和目录不丢。API 返回 `file_library_preserved=true`。包含文件库的新备份会还原其元数据；从其他机器搬迁时还需复制对应原件目录。

旧版资料库从文件库底部的「旧版资料导入」打开，旧登记未被静默迁移或删除。

## 只读接口

Agent 凭宿主能力令牌调用时，必须明确指定 `work_id=<ID>` 或 `scope=shared`。直接使用模型参数指定磁盘路径不受支持。

| GET 路径 | 内容 |
| --- | --- |
| `/api/files/status` | 分类计数、书夹计数与作品概况 |
| `/api/files` | 目录与文件，支持 area、folder_id、q、offset、trash=1 |
| `/api/files/:id/text` | 文本分页；offset 默认 0，limit 默认 20000，最大 50000 |
| `/api/files/:id/original` | 下载完整原件 |
| `/api/files/:id/preview` | 内容签名通过的图片预览 |

每条文件操作都检查归属。模型写请求返回 403。普通作者界面的目录、上传、改名、移动、回收站及恢复接口可用。

文件库服务入口已可供下一步资料工具使用。本轮没有注册或运行新的资料 Agent；正式开放讨论任务前，仍须验证 dsh 的实际工具白名单，禁用该任务中的通用文件写入、编辑和 Shell。现有 dsh 通用工具不能被宣称为全局只读。拆书分析和扫榜采集也未在本轮运行。

分类参考：[Novelcrafter Codex](https://www.novelcrafter.com/features/codex)、[Campfire Research](https://www.campfirewriting.com/learn/research-tutorial)、[Zotero Collections and Tags](https://www.zotero.org/support/collections_and_tags)。分区是创作用途，子文件夹与书夹是用户手动组织；不自动猜测文件类别。
