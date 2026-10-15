# Remote 差量工具的中转边界

状态：已核验；维护：DSHM 协议；核验：2026-10-15；任务：KKC-60。

共享协议新增[基线引用编码/还原与摘要工具](../../../../packages/protocol/src/sync-cache.ts)。它们由电脑插件和手机打包使用，不改变网关操作枚举、权限或凭据结构，不要求部署新版公网网关。

现有 `remote.rpc` / `remote.stream` 的 payload 是可扩展 JSON 对象。配套插件只在五类已允许的只读端点识别 `_dshmSync`，验证后剥离，再调用原 Host；网关仍执行原设备授权和端点校验。编码后的结果继续使用原 `value` 信封，写操作和权限判断不缓存。旧插件/旧 App 不发送提示或编码，保持原行为。

对共享工具的测试及真实原网关链路见[插件说明](../../../../../plugin/compatibility/latest-upstream/remote-cache.md)和[手机专项](../../../../../dsh-mobile/docs/integration/remote-cache-current.md)。本轮没有修改网关运行代码、生产配置或部署，也没有修改 DSH / SDK。

发版检查：协议TypeScript构建通过。现有后端整轮有107项通过、12项跳过；`plugin-integration.test.ts` 依赖的旧本地插件SDK缺少 `@deepseek-ai/dsh-anonymous-user-id`，导入失败，不计整轮通过。配套官方SDK隔离构建及真实alpha.2网关/Android缓存链路按上述专项记录，不能用旧SDK导入失败替代这些结果，也不能将它隐藏为全通过。
