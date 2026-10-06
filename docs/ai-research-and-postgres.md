# AI 研究、扫榜与 PostgreSQL

Novel-King 的 AI 中心使用本机 `D:\deepseek-harness` 的 DSH 0.1.0-rc.5 核心：模型请求、工具调用、会话事件、取消和步数限制均经过原框架循环。运行时已打包到 `vendor/dsh-research`，部署不需要 D 盘或 DSH CLI，也没有嵌套 Git 仓库。原许可证及打包依赖声明一并保留。

## 先连接模型

1. 打开左侧 **AI 中心 → 模型配置 → 添加模型**。
2. 填名称、API 地址、模型名称和自己的 API 密钥。DeepSeek 通常填 `https://api.deepseek.com`；其他兼容服务使用管理员允许的 HTTPS 地址，模型名称可自由填写。
3. 保存并测试连接，再到 **创作研究** 选择作品、研究方法和模型。
4. 输入问题，例如“读取前三章，对照我的榜单资料检查题材、主角目标与期待感，请引用证据”。结果与工具执行记录自动保存；可以停止任务、查看历史。

模型配置与原有正文、画布助手共用。密钥写入当前用户的个人数据库，接口列表只返回是否已保存，网页不会回显完整密钥或保存到 localStorage。**数据库内的密钥目前为明文**，数据库备份也包含密钥；服务器运维者能访问它，不应宣称已做静态加密。仅 API 服务会收到请求中选择的小说资料，不会向模型发送其他用户数据或密钥配置。

实现的是 OpenAI 兼容的 Chat Completions 接口；仅提供 Responses 接口的模型不能直接套用。没有替用户申请密钥，也没有实际调用付费模型做验收。

## 扫榜资料与研究方法

**榜单资料**提供起点签约新书、潜力、公众新书、月票、畅销、推荐和三江书目。自动采集只读取公开书名、作者、分类、简介与链接，保存来源、采集日期及快照。只抓首页样本，不代表完整市场；榜单展示序号不能解释为销量。三江按网页显示的推荐期保存，可能是上一期，不能把采集当天称为本期更新日期。

遇到起点验证码、拒绝访问或网页结构变化，程序返回明确错误，不保存空榜单。**从浏览器导入书目**允许作者自行查看公开网页，再粘贴书名或表格四列（书名、作者、分类、链接）。手动导入会单独标记，不伪装成自动抓取。不会绕过验证码、登录或付费阅读，也不会自动下载小说全文。

内置五种研究技能：榜单研究、开篇检查、参考书拆解、投稿检查、设定与剧情检查。它们要求引用实际读到的材料，区分观察与建议；不编造拒稿原因、平台风向或未读内容。拆书需要自己上传可阅读的材料，榜单元数据不能替代读完整本书。

## MCP 与资料范围

内置 MCP 包括：作品目录、分页阅读正文、人物/世界/词条、画布文本和连线结构、文件库目录与全文、榜单快照、公开榜单读取。所选小说与本账号共享文件可读，其他小说的专属文件不能越界读取。画布里的嵌入图片不会由文字研究工具自动识别；原有画布视觉助手可另行使用。

**工具与技能 → 添加 Exa 网页搜索**会创建服务配置。测试连接后勾选工具，再保存启用，才会提供给研究助手。已验证 Exa 的真实 MCP 握手、工具发现及搜索调用；搜索结果仍需核对原始来源。也可添加管理员准许的其他 Streamable HTTP MCP 服务，单独填写其密钥。

- 默认 MCP origin：`https://mcp.exa.ai`、`https://mcp.tavily.com`。
- 管理员通过 `NOVELKING_MCP_ORIGINS` 添加可信 HTTPS origin；模型服务使用独立的 `NOVELKING_AI_ORIGINS`。
- 必须用户勾选允许的工具，并且服务明确声明 `readOnlyHint: true`。未声明只读的工具不可启用。
- 研究助手没有 shell、宿主文件系统、删除/移动资料或修改稿件工具。外部服务自身的可信度仍由部署管理员负责。
- 每个用户同时只运行一个研究任务，默认上限 12 步、5 分钟；中断或重启保留已记录部分，不自动重启付费请求。

## 数据库与向量基础

Docker 默认 `pgvector/pgvector:pg16`，初始化 `vector` 扩展。账户 schema 为 `nk_accounts`，个人数据为 `nk_u_<UUID 无短横线>`。非 Docker 本机运行可设 `NOVELKING_DATABASE_URL`，否则继续 SQLite。

现在提供 PostgreSQL 持久化及词法检索兼容；**尚未实现 embedding 生成、向量索引或语义检索**。后续需要确定 embedding 模型和维度、分块、增量更新与引用位置，再建立向量索引，不能凭空生成向量。原有 OpenViking 可选记忆服务不作为文件库和研究的启动依赖。

已有 SQLite 首次在对应 PostgreSQL schema 打开时会迁移：检查源库完整性，事务复制表/行/关联/ID、校验列值与行数，重置序列并记录迁移标记。原 SQLite 只读、不删除；目标已有数据时拒绝覆盖。原件继续在个人文件目录，并不是存进 PostgreSQL。几十张应用表、嵌套目录与 API 配置的真实迁移已经测试；极大数据库仍应先备份并在维护窗口演练。

把旧单作者的 `data` 迁给管理员，应先停旧服务，用新的账户数据根目录，设置 `NOVELKING_LEGACY_DATA_DIR` 为旧目录绝对路径。先复制 SQLite 和原件到管理员目录，再在首次访问时迁到 PostgreSQL；原目录保持不变。Docker 需把旧目录只读挂载，并配置容器内路径。

## Docker 部署

使用 Node 24 镜像。复制 `deploy/server.env.example` 为不提交 Git 的 `.env`，填写真实域名、公开访问地址、管理员初始密码、数据库密码及榜单服务令牌。

```sh
# 生成随机字符串，分别用于数据库密码、服务令牌与初始密码
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

# 域名已解析，80/443 可用
docker compose --profile https up -d --build

# 使用已有反向代理时不启用 Caddy
docker compose up -d --build
```

不启用 Caddy 时须自行配置 HTTPS 反向代理。应用只绑定本机 `127.0.0.1:3741`；数据库与榜单浏览器不映射宿主端口。榜单服务用独立 Chromium，只接受固定榜单 ID 与内部令牌，不能作为任意网址浏览器。若 Docker 网段冲突，在 `.env` 同时指定 `NOVELKING_NETWORK_SUBNET`、`NOVELKING_APP_IP` 和 `NOVELKING_PROXY_IP`。

账户注册、算术题与密码重置见 [账户部署说明](accounts-and-deployment.md)。命令行重置支持 PostgreSQL；运行时需使用服务同一组数据库连接及 schema 配置。

## 一致备份

PostgreSQL 和上传卷必须成对保存。以下为 Linux 服务器示例；执行目录为仓库，备份目录不能提交 Git，也不要上传含密钥的备份。

```sh
mkdir -p backups
docker compose stop novel-king
docker compose exec -T postgres pg_dump -U novelking -d novelking -Fc > backups/novelking.dump
docker compose cp novel-king:/var/lib/novel-king backups/account-files
cp .env backups/deployment.env
docker compose start novel-king
```

检查 `pg_dump` 和文件复制都成功后再结束备份；失败时不要误用空 dump。恢复应在新的测试栈先演练，用 `pg_restore` 还原整个数据库、同时还原原件目录及部署配置。网页原有的 SQLite 整库恢复不会用于 PostgreSQL；不要把 SQLite 导出按钮当作 PostgreSQL 备份。

## 验证与当前限制

具体记录见 [开发验收](ai-research-validation-2026-10-07.md)。自动测试使用受控的模型 HTTP 服务，确认真实 DSH 调用 MCP 再返回结果，而不是伪造回复。Docker 中实际运行账户服务、PostgreSQL 与 Chromium 采集服务，桌面/手机进行了浏览器检查。

当前起点自动浏览器可能被验证拦截，需要人工导入；首次填写自己的模型密钥后仍应测试实际服务商连接。已有 Excalidraw/Mermaid、Mammoth 等依赖存在 npm 审计告警；没有为消除告警强制降级画布或 Word 导入组件，详见验收记录。这些限制不能被“测试通过”掩盖。
