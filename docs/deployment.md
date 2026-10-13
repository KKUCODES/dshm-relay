# 部署与运行

本指南适用于当前仓库中的网关。所有命令在后端仓库目录执行；部署服务不需要克隆或构建 DSHM 插件。

## 选择运行方式

| 方式 | 用途 | 需要准备 |
| --- | --- | --- |
| Docker Compose | 公网自建，推荐 | Docker Compose、域名、TCP 80/443。 |
| Node.js 原生运行 | 本机开发或已有 PostgreSQL 的环境 | Node.js 24 或更新版本、PostgreSQL。 |

当前连接路由仅保存在进程内存中，**只运行一个网关实例**。Compose 提供 PostgreSQL 17、网关和 Caddy，数据库和网关端口不直接发布到公网。

## Docker Compose

### 1. 准备域名与配置

将域名解析到服务器，开放 TCP 80/443；UDP 443 用于可选 HTTP/3。确认端口未被其他服务占用。

复制配置模板：

```sh
cp .env.example .env
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。已有 `.env` 时先检查内容，不覆盖原配置。

编辑 `.env`：

| 变量 | 填写方式 |
| --- | --- |
| `DOMAIN` | 实际域名，例如 `relay.example.com`；不含协议、路径或端口。 |
| `POSTGRES_PASSWORD` | 新生成的随机密码，替换模板占位值。建议使用 base64url 字符，避免数据库 URL 转义。 |
| `REGISTRATION_MODE` | `private` 或 `open`，默认 `private`。 |
| `ENROLLMENT_TOKEN` | `private` 必填，43 字符 base64url 随机值；`open` 可删除此行。 |

生成随机值，不需要服务器安装 Node.js：

```sh
docker run --rm node:24-bookworm-slim node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

分别执行两次，将不同的值用于数据库密码与注册密钥。开放模式只需数据库密码。`.env` 包含真实凭据，不提交到仓库。

### 2. 启动并检查

```sh
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

`config --quiet` 只检查配置，不输出展开后的密码。首次启动需要下载镜像和构建网关。

通过外部网络检查：

```sh
curl https://relay.example.com/health
curl https://relay.example.com/v1/server-info
```

将示例域名替换成自己的域名。健康接口应返回 `ok: true`；服务信息应显示所选 `registrationMode` 和 `remoteTransport: 2`。Windows PowerShell 可使用 `Invoke-RestMethod` 请求相同地址。

Caddy 自动办理 HTTPS 证书并代理 WebSocket。Compose 设置 `PUBLIC_ORIGIN=https://你的域名`，并只信任 Caddy 的一跳代理；不要额外公开网关或数据库端口。当前 HTTPS 配置已提供，但尚未完成实际 HTTPS 部署验收。

### 3. 连接电脑与手机

1. 在电脑 DSHM 插件设置页填写服务根地址 `https://你的域名` 和电脑名称。
2. 个人模式填写 `.env` 中的注册密钥，开放模式无需填写。注册成功后电脑使用自己的独立凭据。
3. 开启远程连接，生成一次性链接，在手机 DSHM 的 Remote 领取。
4. 回到电脑核对手机公钥指纹，批准设备。需要电脑管理能力时另行授予管理权限。

电脑和 DSH 需要保持运行。已有电脑更换地址或后端时，使用插件的“修改服务地址”；手机用新链接重新配对。同一后端换地址需保留数据库和身份，新后端不会自动继承旧授权，旧服务的设备授权也不会自动撤销。

## Node.js 原生运行

### 1. 安装与构建

准备 Node.js 24 或更新版本，以及可连接的 PostgreSQL。在后端目录执行：

```sh
npm ci --ignore-scripts
npm run build
```

生产入口使用 PostgreSQL；测试中的 PGlite 不能替代此数据库配置。

### 2. 配置环境

新建本机 `.env.local`，例如：

```dotenv
DATABASE_URL=postgresql://dsh_mobile:REPLACE_WITH_DATABASE_PASSWORD@127.0.0.1:5432/dsh_mobile
PUBLIC_ORIGIN=http://127.0.0.1:8787
REGISTRATION_MODE=private
ENROLLMENT_TOKEN=REPLACE_WITH_43_CHARACTER_BASE64URL_TOKEN
HOST=127.0.0.1
PORT=8787
```

数据库、账号和密码需提前在 PostgreSQL 中准备，替换示例占位值。注册密钥可用本机 Node.js 生成：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

如果选择开放注册，设置 `REGISTRATION_MODE=open` 并删除 `ENROLLMENT_TOKEN`。

### 3. 启动

```sh
node --env-file=.env.local packages/gateway/dist/main.js
```

确认 `http://127.0.0.1:8787/health` 返回 `ok: true`。启动会执行现有幂等建表逻辑，随后监听端口；新增数据库结构的升级仍需明确迁移方案。

`npm start` 不会自动读取 `.env.local`，仅适合已在进程环境中设置好变量的情况。修改源码后重新构建并重启；修改环境变量后重启。

`127.0.0.1` 只适用于电脑本机访问。手机访问这台服务器时，要使用双方都能访问的地址，并将 `PUBLIC_ORIGIN` 设置为该根地址；手机上的 localhost 指向手机自己。需要监听网卡时设置合适的 `HOST`，例如 `0.0.0.0`，并配置防火墙和反向代理。

## 配置说明

| 变量 | 作用与默认值 |
| --- | --- |
| `DATABASE_URL` | 必填，PostgreSQL 连接 URL；账号、密码和数据库必须有效。 |
| `PUBLIC_ORIGIN` | 必填，客户端看到的 HTTP/HTTPS 根地址，不含路径、查询参数或凭据。 |
| `REGISTRATION_MODE` | 默认 `private`；`open` 只跳过电脑首次注册的密钥校验。 |
| `ENROLLMENT_TOKEN` | 仅个人模式必填，43 字符 base64url 值，不提供给手机。 |
| `HOST` | 原生默认 `127.0.0.1`，容器内为 `0.0.0.0`。 |
| `PORT` | 默认 `8787`。 |
| `TRUST_PROXY_HOPS` | 默认 `0`；仅在网关只接受可信的一跳反向代理时设置为 `1`。Compose 已按此结构配置。 |

`PUBLIC_ORIGIN` 必须与客户端使用的协议、主机和端口一致。它用于设备请求验证，不能填内网代理地址或带登录凭据的 DSH 页面 URL。

HTTP 和 HTTPS 都可连接，不需要旧版 `ALLOW_INSECURE_LOCALHOST` 开关。HTTP 会记录未加密提示，凭据和聊天内容可能被窃听或篡改；公网建议 HTTPS。手机批准和请求鉴权不能替代传输加密，中转也不提供端到端加密。

切换注册模式需重启网关。已有电脑凭据不会因此失效；两种模式都保留注册限流、配对、批准和后续设备鉴权。非法模式或个人模式缺少有效密钥会拒绝启动。

## 更新、停止与备份

Compose 更新源码后执行：

```sh
docker compose up -d --build --wait
docker compose logs --tail 100 gateway caddy
```

更新会断开在线连接，电脑插件重新连接，手机重新获取状态。更换后端或地址仍需通过插件的地址修改流程，不能只修改手机 URL。

`docker compose down` 停止服务并保留命名卷。**不要使用 `down -v`，除非确实要删除数据库和授权记录。** `postgres_data` 保存设备绑定与配对状态，`caddy_data` 保存证书相关数据；均应按自己的运维策略备份。

数据库保存凭据摘要、设备公钥指纹、状态、有效期及短期防重放记录，聊天正文和文件内容不写入数据库。服务日志不记录请求正文或 WebSocket 帧，Authorization/DPoP 字段已隐藏；部署其他监控时也不要采集这些敏感内容。

恢复旧数据库备份可能回退设备撤销和配对状态。先停止入口，在隔离数据库检查备份，再重新核对设备信任，避免直接恢复对外访问。当前没有通用电脑删除、电脑凭据轮换或长期设备记录管理面板；手机凭据有效期为 90 天，到期重新配对。

## 排障

| 现象 | 先检查 |
| --- | --- |
| `Invalid gateway environment` | 必填环境变量、数据库 URL 和端口；是否使用 `--env-file` 加载配置。 |
| `Invalid registration configuration` | 模式是否为 `open/private`，个人模式密钥是否为 43 字符 base64url。 |
| `Gateway startup failed` | PostgreSQL 可达性与权限、`PUBLIC_ORIGIN`、端口占用。 |
| 插件检测失败或 `operation_failed` | 服务健康接口；升级插件后是否真正重启了 DSH 进程。刷新网页不加载新 Host 代码。 |
| 请求鉴权或来源失败 | 手机与电脑使用的地址、`PUBLIC_ORIGIN`、反向代理和协议是否一致。 |
| 手机无法访问 `127.0.0.1` | 手机的 localhost 是手机自己；改用双方可达的服务器地址。 |

配置中不要填写 DSH 启动链接的登录 token。排障时只分享错误码和必要状态，不分享 `.env`、注册密钥、配对链接或模型 Key。

## 验证范围

Linux Docker 的 HTTP 公网协议通信、配对与撤销、容器重启和隔离数据库恢复已有验证记录。HTTPS 证书/WSS、完整 DSH + Android 公网使用、目标服务器负载与长期运行需按自己的环境验证。

维护者的临时 HTTP 环境及原验证范围见[服务器运维记录](../deploy/public-server.md)，不要把该服务器的端口配置当作本仓库默认 HTTPS Compose 配置。
