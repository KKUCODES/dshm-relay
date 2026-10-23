# 公网临时联调服务器

状态：HTTP 临时联调部署与后端公网通信验收通过。维护：后端维护者。核验日期：2026-10-10。

任务：[KKC-27](https://linear.app/kkcodes/issue/KKC-27)。本次用户明确选择 HTTP 非标准端口用于临时联调，不作为正式公共服务发布。

## 当前配置

2026-10-23 配套升级状态：通用分块协议提交 `94183d08ccbb8752d14c819608d79fe3870a9a60` 已推送，App preview.7与插件0.1.87已公开发布。此次只读访问确认 `/health` 与 `/v1/server-info` 正常，但服务器 SSH 身份验证尚未成功，正在等待可用登录信息；尚未修改运行容器、配置或数据库。现有健康结果不能证明新分块能力已上线。[升级任务](https://linear.app/kkcodes/issue/KKC-76)、[协议与回归边界](../docs/response-chunks.md)。后续须保留原配置/数据和回滚源，仅更新本项目网关并验证新旧端通信。

- 当前入口：`http://118.31.20.47:18787`，电脑插件填写此根地址；新电脑注册后按原流程生成配对链接、在手机领取并在电脑批准。
- 开放注册：不需要公共注册密钥，手机仍需一次性配对和电脑批准。
- Ubuntu 22.04，2 核、约 1.6 GiB 内存；部署目录 `/opt/dshm-relay`。
- Compose 项目名 `dshm-relay`，单个网关、独立 PostgreSQL 17 与 Caddy 2.11.7。
- 只发布 TCP 18787。网关 8787、数据库 5432 和 Caddy 管理端口均未映射到公网；80/443 映射已移除。
- 数据库和 Caddy 数据使用独立命名卷。容器自动重启；网关以非 root 用户运行且文件系统只读，在线路由保存在进程内存中。
- 内存上限：网关 384 MiB、数据库 256 MiB、代理 128 MiB；日志每个容器最多三份 10 MiB 文件。
- 凭据只存服务器 `.env`，文件权限 600、项目目录 700；上传源码不包含本机 `.env.local`。

HTTP/WS 不加密，DPoP 和电脑批准不能提供传输机密性。当前仅用于临时联调，不承诺公开使用容量、长期可用性或完整 Android/DSH 公网验收。

## 运维

以下命令在服务器 `/opt/dshm-relay` 执行：

```sh
docker compose -p dshm-relay ps
docker compose -p dshm-relay logs --tail 100 gateway caddy
docker compose -p dshm-relay up -d --wait
docker compose -p dshm-relay restart
```

停止时使用 `docker compose -p dshm-relay down`，它保留命名卷。不要使用 `down -v`。配置包含数据库密码，不要直接分享 `docker compose config` 的完整输出，校验使用 `config --quiet`。

本机备份脚本 `/opt/dshm-relay/backup.sh` 生成 PostgreSQL 自定义格式备份和当前配置压缩包，权限 600，保存约七天。`dshm-relay-backup.timer` 每日 UTC 03:30 后随机延迟最多十五分钟运行，错过运行会在启动后补一次。可手动执行：

```sh
./backup.sh
systemctl list-timers dshm-relay-backup.timer
systemctl status dshm-relay-backup.service
```

备份位于同一服务器，尚无异地副本。不要在公开运行中直接恢复旧备份：它可能回退设备批准/撤销和配对状态。恢复前停止入口，先在隔离数据库检查，再重新核对设备信任。

## HTTPS 后续

IP 证书已由 Let's Encrypt 正式支持，但验证 IP 仍需公网 TCP 80 或 443；不能用 DNS 验证裸 IP。当前服务器未开放这两个端口，未签发受信任证书。

如果提供域名，可通过 DNS 验证签发证书并在非标准端口提供 HTTPS；具体备案范围按服务、服务器地域和云厂商规则确认，不能把换端口解释为免备案。依据：[Let's Encrypt 验证方式](https://letsencrypt.org/docs/challenge-types/)、[阿里云备案服务器检查](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-server-access-information-check)。

## 验证记录

Linux 上第二次镜像构建通过，原 Dockerfile/锁文件的首轮失败已保留服务器 `build.first-failure.log`。失败原因是测试依赖 `embedded-postgres` 的一个可选 macOS 子包锁记录缺少版本信息；按实际包元数据补齐后构建成功，构建阶段省略不需要的可选测试二进制。

用户已放行安全组 TCP 18787。从 Windows 通过实际公网地址访问 `/health` 返回 HTTP 200、`ok: true`；`/v1/server-info` 确认为 open 和 transport 2。

实际公网 HTTP/WS 检查通过：

| 场景 | 结果 |
| --- | --- |
| 一次性配对 | 首次领取成功，重复领取 409；未批准设备不能申请连接票据，返回 403 |
| 批准与防重放 | 批准后设备状态 active；复用同一 DPoP 证明返回 401 |
| 双向 Remote RPC | Host/设备通过公网 WebSocket 通信；关联标识回传、设备归属和基本权限保持 |
| 订阅与取消 | 收到实际转发事件，取消消息传回 Host，客户端收到结束 |
| 权限和票据 | 基本权限不能读取管理设置；已消费的 socket ticket 重用连接被关闭 |
| 容器重启 | 本项目三容器全部停止/启动后，电脑凭据、设备批准状态仍有效，重新连接后 RPC 正常 |
| 设备撤销 | 已连接 socket 关闭，重新申请票据返回 401；测试授权随后清理 |
| 来源限制 | 不匹配的 Origin 请求返回 403 |

公网验收使用隔离协议客户端和 Host 对等端，没有运行真实模型请求，不是完整 DSH/Android 公网验收。结果记录在任务专用 `transport-report.json`，明确标注 `encrypted: false`。容器配置、镜像摘要和上传源文件摘要另存服务器及本地的部署报告。

本机备份已实际执行，归档可读取；恢复到单独的 `dshm_restore_check` 数据库后，先核对四张业务表，再核对测试电脑记录和设备 revoked 状态保持。测试数据库已移除，原数据库未覆盖。测试用配对、电脑、设备和相关防重放记录已按专属标识清理，不删除其他记录；应用日志未出现转发内容的测试标记。系统备份定时器为 active；验证命令打印的 snapd/1Panel 旧配置警告未处理，未改这些服务。

本次只部署后端，不修改官方 DSH、App 或插件，也不切换用户日常连接。原有 MySQL/frp 容器保持运行。任务专用上传清单、配置、SSH 辅助器和协议验收器保存在本地 `backend/artifacts/public-deploy/2026-10-10/`，不包含 SSH 密码；验收器使用隔离协议客户端，不能代替真实 DSH/Android 使用验证。
