# 账户与服务器部署

服务器入口是 `npm run start:server`（`account-server.mjs`）。`npm start` 保留为本机单作者入口，**不能把旧入口直接反向代理到公网**。账户版支持开放注册、算术题、登录退出、修改密码、管理员启停账号与重置密码。

## 隔离方式

账户数据库：`accounts-data/accounts.db`；每个账号的作品与模型配置：`accounts-data/users/<不可猜测的用户 UUID>/novel.db`。上传原件、备份、运行日志也在各自目录。这里的“共享资料”只在**一个用户自己的小说之间共享**。

网关验证登录后，把请求交给该账号的独立 Node 进程。进程只监听随机本机端口，另用随机密钥保护；Cookie、外部代理头、Agent 凭证不转发进去。每个进程都有自己的数据库连接、任务、缓存和 HOME，不继承宿主 AI 密钥。浏览器草稿、会话位置和画布快捷键按账号加前缀保存。旧标签页遇到账号切换会锁定，避免串写。

这是应用数据隔离，**不是操作系统沙箱**。账户版封锁 DSH、服务器目录读取、全局工具配置、任意路径整库恢复、关闭服务等接口；DSH 执行函数本身也拒绝服务器模式的后台调用。直连模型写作、润色、画布助手仍可用。默认仅允许 `https://api.deepseek.com` 和 `https://api.openai.com`，拒绝 HTTP/私网接口和重定向。添加服务商须由部署管理员配置 `NOVELKING_AI_ORIGINS`，填逗号分隔的可信 HTTPS origin，不要开放用户可控或内网服务。当前服务器版暂未开放的高级工具由网关默认拒绝。

## 注册与会话

- 服务端加法/乘法题；答案哈希保存在服务器，题目两分钟有效，答错也消耗题目，绑定来源 IP。
- 每 IP：出题 60 次/10 分钟、注册提交 10 次/小时、通过题目后最多 5 次注册尝试/天。失败后换题不会重置注册限额。
- 登录：每 IP 40 次/15 分钟，每用户名 10 次/15 分钟；失败含统一文案，429 携带 Retry-After。
- 密码 10–128 字符，用随机盐 scrypt（N=131072、r=8、p=1）保存；最多同时执行两次密码哈希。
- 14 天随机会话，数据库只保存 token 哈希，最多 5 个会话；HttpOnly / SameSite=Lax，HTTPS 下 Secure。退出、改密、管理员重置/停用立即撤销相关会话。
- 写操作必须带准确的同源 Origin，账户 JSON 最大 8 KB；没有开放跨域接口。

算术题能挡住简单脚本，自动计算的机器人仍能解题；需要控制滥用时可设置 `NOVELKING_REGISTRATION=closed`。无短信、邮箱验证或邮件找回；目前由管理员重置普通用户密码。管理员忘记密码可用服务器上的 `node scripts/reset-account-password.mjs <用户名>` 交互重置，不通过公开接口。

## 本机查看账户版

```powershell
$env:PORT = '3741'
$env:NOVELKING_PUBLIC_ORIGIN = 'http://localhost:3741'
$env:NOVELKING_ADMIN_USER = 'owner'
$env:NOVELKING_ADMIN_PASSWORD = '<你自己的长密码>'
npm run start:server
```

管理员须由服务器启动配置创建，注册的第一个用户不会自动成为管理员。首次成功启动后，删除环境中的初始密码即可；重新启动不会覆盖已有密码。管理员密码不能在网页里被其他账号重置或管理员自停用。

## Docker + 域名 HTTPS

1. 把域名解析到服务器，开放 80/443。
2. 复制 `deploy/server.env.example` 为 `.env`，修改 DOMAIN、PUBLIC_ORIGIN、管理员账号和密码。
3. `docker compose up -d --build`。Caddy 自动提供 HTTPS；应用端口只映射到服务器回环地址，用户访问域名。
4. 登录管理员，注册一个普通账号，确认普通账号书架为空。

默认 4 个同时驻留的工作进程，空闲 10 分钟关闭，容量满时回收没有在途请求的旧进程；忙时返回 503，数据仍在磁盘。建议从 2 GB 内存起步并按用户数调整。账户认证部分的密码哈希峰值约 256 MB，不能把内存限制设置过低。

**代理与注册限流**：Docker 配置使用专用网络 `172.30.79.0/24`，Caddy 固定为 `.2`，网关只信任这个 IP。Caddy 覆盖客户端传入的 X-Forwarded-For，发送真实直连客户端 IP，避免伪造地址绕过限流。如果该网段与服务器现有网络冲突，同时修改 compose 的子网、两个固定 IP 与受信任代理地址。直接启动网关时默认不信任代理头；使用其他反向代理须显式设置 `NOVELKING_TRUSTED_PROXIES` 为实际代理地址，并在代理上覆盖该头。不要把任意公网地址放进信任列表。代理行为参考 [Caddy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## 把现在的作品迁给管理员

停下旧版写作服务，避免复制期间上传原件变动。首次启动账户版时额外设置 `NOVELKING_LEGACY_DATA_DIR` 为旧 `data` 目录的**绝对路径**。

迁移使用 SQLite `VACUUM INTO` 得到包含 WAL 已提交内容的一致快照，校验完整性后，复制文件原件、备份和调试记录，最后切换管理员目录。原目录不删除、不覆盖；画布已存在数据库快照里。迁移记号写入账户库，重启不会重复覆盖。管理员已经创建个人数据目录时会拒绝迁移，需要先备份、使用新的账户数据根目录。失败的 `.migration-*` 暂存目录保留用于排查。

Docker 迁移须临时把旧目录只读挂载进应用容器，并把变量设置为容器内路径。不要把旧数据库复制进 Docker 镜像。

## 备份与恢复

备份**整个账户数据根目录**（账户库、每人小说数据库、上传原件），不能只备份 `novel.db`。最简单的一致备份方式：`docker compose stop novel-king` → 备份 `novel-king-data` 卷 → `docker compose start novel-king`。恢复时先停止应用，再还原整个卷。`.env` 内的部署配置另行保存。

实现参考：[Node scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)、[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。
