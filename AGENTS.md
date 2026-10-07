# Novel-King 本地长期部署

继承全局开发规范。本文件记录当前部署事实，不放宽开发、测试或确认要求。

## 默认实例

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
