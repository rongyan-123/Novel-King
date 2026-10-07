# Novel-King 长期部署

继承全局开发规范。本文件记录当前部署事实，不放宽开发、测试或确认要求。

## Linux 服务器实例（当前使用）

- SSH：`rong-ubuntu`，Linux 笔记本 `192.168.137.23`，用户 `rong`。
- 公网访问地址：`https://novelking.xxian.fun/`，使用 Let's Encrypt 公共证书。原局域网入口 `https://192.168.137.23:3742/` 跳转到公网地址。
- 运维目录：`/opt/novel-king`；源码：`/opt/novel-king/app`。
- 使用系统 Docker：`sudo docker --context default`。`rong` 用户默认的 `desktop-linux` 属于另一套 Docker，不能混用。
- Compose 项目：`novelking`；启动使用运维目录中的 `.env` 和 `compose.server.yaml`。
- 管理员继续使用 `owner`，与本机原账号 UUID 相同。
- 数据库卷 `novelking_postgres-data`，文件卷 `novelking_novel-king-data`；证书卷 `novelking_caddy-data` 与 `novelking_caddy-config`。
- 内存上限：应用 1536 MiB、PostgreSQL 512 MiB、榜单浏览器 768 MiB、HTTPS 网关 96 MiB；总计 2912 MiB。写作进程最多 2 个；保留单任务榜单采集。
- 公网入口：FRP `120.79.1.21:443` → 独立的 `novelking-frpc.service` → `127.0.0.1:3742`。FRP 配置位于 `/opt/novel-king/frp/frpc.toml`，认证信息不进入 Git。
- 独立用户服务：`novelking-frpc.service` 上限 64 MiB，`novelking-acme-proxy.service` 上限 32 MiB，均启用开机启动。后者仅允许网关 `172.30.79.2` 通过 `172.30.79.1:3794` 使用现有 `127.0.0.1:7890` 代理申请和续签证书；需要该本机代理保持可用。
- 网关通过 PROXY protocol v2 接收 FRP 传来的客户端 IP，仅信任 Docker 网关 `172.30.79.1/32`。公网入口保留 HTTP/1.1 和 HTTP/2，关闭无法通过此 HTTPS 隧道转发的 HTTP/3。
- 数据与配置的完整备份位于 `/opt/novel-king/backups/`；2026-10-07 已完成迁移、14 个接口数据比对、浏览器验收和数据库重启后的登录验证。
- 公网切换后的完整备份：`/opt/novel-king/backups/public-20261007_152344/`，包含数据库、文件和证书卷、FRP 配置、用户服务及源码 bundle；恢复服务后再次通过原管理员登录和 14 个接口数据比对。
- 不操作 MapFlow 服务，不重启共享 Docker，不做全局 prune 或删除已有数据卷。
- 详细记录见 `docs/linux-laptop-deployment-2026-10-07.md`。
- Agent 聊天首页与编辑研究见 `docs/agent-chat-and-editorial-research.md`；发布前完整备份为 `/opt/novel-king/backups/public-20261007_165052/`。演示验收使用隔离测试模型，生产上游 Key 由用户后续填写。

## 本机保留实例

- 项目路径：`D:\WangWenKing`。
- 访问地址：`http://localhost:3742/`；公开域名与 Host/Origin 必须一致。
- 长期管理员：`owner`，已有账号，继续使用同一用户 UUID。
- 启动配置：根目录 `.env`，已排除 Git 和 Docker 构建上下文。
- Compose 项目名：`novelking-ai-preview`，由 `.env` 的 `COMPOSE_PROJECT_NAME` 固定。
- 标签中虽然保留 preview 字样，该实例现在用于长期保存用户数据。
- 常规启动：在项目根目录执行 `docker compose up -d`。

## 持久化

- PostgreSQL：`pgvector/pgvector:pg16`，数据库 `novelking`，已启用 `vector` 扩展。
- 数据库卷：`novelking-ai-preview_postgres-data`，挂载 `/var/lib/postgresql/data`。
- 文件卷：`novelking-ai-preview_novel-king-data`，挂载 `/var/lib/novel-king`。
- 账户、钱包和平台配置在 `nk_accounts`；小说、章节、画布和文件元数据在各用户独立 schema。
- 上传原件与 `private/platform-master.key` 保存在文件卷。主密钥必须随备份恢复，否则不能解密平台 Key。
- 继续保留这两个卷。不要把该实例切回 SQLite，也不要通过改变项目名或执行 `docker compose down -v` 创建空库替代现有数据。
- 如需调整卷、数据库或项目名，先按用户授权范围做成对备份和迁移，验证后再切换。

## 登录与迁移材料

- 管理员登录信息：`accounts-data/local-deployment/admin-login.txt`；不要将密码写入源码、Git 或日志。
- 本机运维说明：`accounts-data/local-deployment/README.md`。
- 私有备份目录：`accounts-data/local-deployment/backups/`；整个 `accounts-data` 已被 Git 忽略。
- 完整迁移材料包含 PostgreSQL custom dump、文件卷 tar.gz、部署配置、源码 bundle 和校验清单。
- 2026-10-07 已实际演练数据库及文件卷恢复，验证管理员登录、账户 UUID、钱包和作品一致。隔离演练实例不作为默认实例使用。
- 通用部署和恢复说明见 `docs/accounts-and-deployment.md`、`docs/ai-research-and-postgres.md` 和 `docs/platform-admin-and-billing.md`。
