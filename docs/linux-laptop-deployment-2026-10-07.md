# Linux 笔记本部署记录

2026-10-07，Novel-King 已从 Windows 的 PostgreSQL 实例迁移到 Linux 笔记本。应用源码版本为 `7d8f00a`，管理员继续使用 `owner`，账号 UUID、密码和钱包保留。服务器源码从已校验的 Git bundle 导入，origin 关联本项目自己的 GitHub 仓库；当前部署包含尚未推送的本机提交，更新前须核对版本。

## 地址与目录

- SSH：`ssh rong-ubuntu`，主机 `192.168.137.23`，用户 `rong`。
- 网站：`https://novelking.xxian.fun/`，公网 HTTPS 使用标准 443 端口。
- 原局域网入口 `https://192.168.137.23:3742/` 返回 308 并跳转到公网地址。
- 运维目录：`/opt/novel-king`；源码位于其 `app` 子目录。
- 部署文件：`.env`、`compose.server.yaml`、`Caddyfile.server` 和两份服务器构建 Dockerfile。
- 使用系统 Docker，即 `sudo docker --context default`。用户默认 `desktop-linux` 是另一套 Docker。

公网域名的 A 记录指向 FRP 服务器 `120.79.1.21`。Caddy 使用 Let's Encrypt 公共证书，申请时通过 HTTPS 隧道完成 TLS-ALPN-01 验证，证书保存在现有 Caddy 数据卷并由 Caddy 自动续签。2026-10-07 签发证书的有效期至 2027-01-05。

应用公开 Origin 为 `https://novelking.xxian.fun`，Host/Origin 校验继续启用。原局域网地址仍使用独立 Caddy 本地 CA；未信任该 CA 的客户端访问旧地址时仍可能先显示证书提示。未自动更改电脑或手机的系统信任库。

## 公网隧道和证书网络出口

公网 HTTPS → FRP 服务器 443 → 独立用户服务 `novelking-frpc.service` → `127.0.0.1:3742` → Caddy → 应用容器 3741。网关同时绑定 `127.0.0.1:3742` 和 `192.168.137.23:3742`，外部访问无需添加 3742 端口。

- FRP 配置：`/opt/novel-king/frp/frpc.toml`，权限 600，继承用户提供的服务器和认证信息；不修改原有共享 FRP 配置或 `frpc.service`。
- 用户服务定义：`/home/rong/.config/systemd/user/novelking-frpc.service`；启用开机启动，用户 lingering 已启用。
- FRP 开启 PROXY protocol v2，网关仅信任 `172.30.79.1/32` 传入的地址，再将客户端 IP 传给账户服务。否则按 IP 限流会把不同公网用户视作同一桥接地址。
- 此隧道转发 TCP，网关只启用 HTTP/1.1 和 HTTP/2，避免向公网浏览器通告无法转发的 HTTP/3 端口。

证书申请最初在下载备用证书链时反复出现连接超时。为网关配置独立的 `novelking-acme-proxy.service`：`socat` 仅绑定 Docker 桥接网关 `172.30.79.1:3794`，只接受 HTTPS 网关 `172.30.79.2`，转接到笔记本已有的 `127.0.0.1:7890` 代理。Caddy 的 `HTTPS_PROXY` 指向该转接地址；应用反向代理目标保持直连。此服务已启用开机启动，证书申请与自动续签依赖笔记本 7890 代理可用。

公网切换前的配置备份位于 `/opt/novel-king/backups/public-domain-20261007_145318/`，路径同时记录在 `/opt/novel-king/last-public-domain-backup.txt`。

## 资源与持久化

部署前实测：主机总内存约 14.8 GiB，可用约 10 GiB，磁盘可用 221 GB；已有 MapFlow 服务运行在系统 Docker。没有改动现有服务、Docker daemon 或系统交换分区。

| 服务 | 内存上限 | CPU 上限 |
| --- | --- | --- |
| 写作与账户应用 | 1536 MiB | 1.5 核 |
| PostgreSQL 16 + pgvector | 512 MiB | 0.75 核 |
| 榜单 Chromium | 768 MiB | 0.75 核 |
| Caddy HTTPS 网关 | 96 MiB | 0.25 核 |

Docker 容器总内存上限为 2912 MiB，约 2.84 GiB；不是预先占用该内存。登录与浏览器验收后一次实测约 178 MiB，后续使用会变化。各容器不额外使用 swap，限制 PID，日志最多每服务 3 × 10 MB。写作进程最多 2 个，空闲回收；榜单服务保留单任务采集和请求间隔。

两个新增原生用户服务分别限制 FRP 64 MiB、证书网络转接 32 MiB，均不额外使用 swap，CPU 配额分别为 0.1 核和 0.05 核。包含这两个服务的内存上限合计 3008 MiB，约 2.94 GiB；切换后一次实测两者合计约 10 MiB。服务器上其他项目的服务不计入此上限。

- `novelking_postgres-data`：数据库；账户和平台配置在 `nk_accounts`，个人数据在各用户 schema。
- `novelking_novel-king-data`：上传原件、个人目录与 `private/platform-master.key`。
- `novelking_caddy-data`、`novelking_caddy-config`：公共证书、ACME 账户、局域网 CA 及网关状态。

数据库及榜单浏览器没有映射宿主机端口。只有 HTTPS 网关发布局域网和回环地址的 3742。容器设置 `unless-stopped`，系统 Docker 已启用开机启动。

## 启停与备份

```bash
ssh rong-ubuntu
cd /opt/novel-king
sudo docker --context default compose --env-file .env -f compose.server.yaml up -d --no-build --wait
sudo docker --context default compose --env-file .env -f compose.server.yaml ps
systemctl --user status novelking-frpc.service novelking-acme-proxy.service
```

Windows 迁移材料在 `/opt/novel-king/backups/windows-20261007_121930/`，五个核心文件均通过 SHA-256 核对。恢复前确认目标库没有应用表；恢复了完整 custom dump 与文件卷，并核对了主密钥校验值和 Node 用户读取权限。

局域网部署的一致备份在 `/opt/novel-king/backups/linux-20261007_134857/`；公网切换后的完整备份在 `/opt/novel-king/backups/public-20261007_152344/`，最新路径记录在 `/opt/novel-king/last-public-backup.txt`。包括 PostgreSQL custom dump、三个文件/证书卷归档、部署配置、Dockerfile、完整源码 bundle 和校验清单；公网备份还包含私有 FRP 配置及两个用户服务定义。备份期间短暂停止本应用和网关，完成后恢复服务。归档、数据库 dump、源码 bundle 和文件校验均通过检查，恢复服务后再次验证原管理员登录及 14 个接口数据一致。备份和 `.env` 保存在私有目录，不进入 Git。两次备份均为手动执行，未设置定时备份。

数据库、上传文件和平台主密钥必须成对恢复。保留证书卷可继续使用同一局域网 CA。不要执行 `docker compose down -v`，不要用当前远端旧版本覆盖尚未推送的已部署版本。

迁移公网入口时还须备份私有 FRP 配置和两个用户服务定义；目标机需要现有 FRP 二进制、`socat`、用户 lingering，以及网关可使用的 7890 本机代理。先恢复 Docker 网络，再启动原生用户服务；网络尚未建立时，服务会按 5 秒间隔重试。

## 验收

- 管理员密码通过真实登录验证；用户 UUID、角色及 14 个账户、作品、资料、钱包和管理接口与本机数据完全一致。
- 未登录读取作品返回 401；其他 Origin 的写请求返回 403。
- 真实 Chromium 完成网页登录、打开文件库、加载画布模块；390 px 手机视口可渲染，未观察到页面脚本错误。未创建测试作品或调用收费模型。
- 手机交互检查发现现有顶栏按钮会重叠并挡住侧栏切换按钮，因此手机菜单点击验收未通过。该问题属于现有 UI，本次记录后保留，未绕过点击检查宣称通过，也没有扩大部署任务去改业务或 UI。
- PostgreSQL 与应用停止、重启后，再次完成同一管理员登录和接口数据核对。
- 公网切换后，Windows 直接访问域名通过公共证书验证，登录页返回 200；原管理员登录及 14 个接口再次与迁移前数据完全一致，未登录和外部 Origin 仍分别返回 401、403。原局域网入口跳转验证通过。
- 公网真实 Chromium 使用证书校验完成登录、打开文件库、加载画布模块，未观察到页面脚本错误。手机菜单问题未在此次公网切换中修复或重新验收。
- 验收期间出现短时失联；Windows 后台检查确认热点处于开启状态，笔记本仍在连接列表。Linux 日志记录 15:11 无线断开后重新连接，未见机器重启、休眠或容器 OOM；恢复后继续完成公网验收。日志不足以确定最初失联的完整原因。
- 实际 Docker 内存、CPU、数据卷、重启策略已检查；最终运行容器没有 OOM 或异常自动重启。

浏览器截图和本机验收记录在被 Git 忽略的 `accounts-data/server-deployment/`。本次只部署配置和交接文档，没有修改应用业务逻辑。
