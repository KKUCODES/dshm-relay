# DSH rc.2 隔离连接验证

- 状态：本地验证工具，生产中转未改；维护角色：DSHM中转维护者；2026-10-23。
- 来源：[验证协调器](../../../../scripts/verify-rc21-host.mjs)、生产网关与存储实现。

`node scripts/verify-rc21-host.mjs` 通过官方CLI正常安装自有插件，启动独立DSH_HOME、PGlite数据库和私有注册中转。默认端口16977/18793，20分钟内等待本轮测试指令；结束撤销测试设备并停止自己启动的进程。不得对日常服务使用本脚本。

SDK、插件归档及目标版本可分别通过 `DSHM_CHECK_SDK`、`DSHM_CHECK_PLUGIN`、`DSHM_CHECK_VERSION` 指定。当前矩阵使用未改动的官方0.2.0-rc.2、0.2.1-alpha.2、0.2.1-rc.2；手机侧有两个专用UID，不清理已发布App。

输出忽略目录 `artifacts/rc21-host/`：`state.json`无凭据；`pair.private.json`、各轮 `host.private.log`仅本机私密使用，禁止上传或打印。`command.json`指令必须匹配本轮run与唯一id，批准还须匹配测试名称、指纹和pending状态；只授聊天权，不授管理权。该协调器不接入生产服务、不复制Key、不发送模型请求。

本次验证说明rc.2连接问题可以在原生产中转协议上解决，无须改变网关、DPoP或扩大远程权限。CLI和MuMu通过不等于Electron、真机或公网整体验收。
