# 后端开发与验证

后端使用 TypeScript、Node.js 24、Fastify、PostgreSQL 和 WebSocket。所有命令在后端目录执行。只对接官方 DSH 和独立 DSHM 插件，不通过修改或重新构建 DSH 本体补足能力。

## 构建后端

```sh
npm ci --ignore-scripts
npm run build
```

`build` 先编译 `@dsh-mobile/protocol`，再编译 `@dsh-mobile/gateway`。生产运行只使用本仓库中的两个包，不需要构建相邻插件。环境与启动方式见[部署指南](./deployment.md)。

## 测试范围

仅检查后端鉴权、配对与中继：

```sh
node node_modules/vitest/vitest.mjs run tests/auth.test.ts tests/pairing.test.ts tests/relay.test.ts
```

这组测试使用隔离测试数据库与协议对等端，不代表真实 DSH、Android 或公网使用通过。

### 跨端测试

完整 `npm test` 和 `npm run typecheck` 还包含插件、手机及版本兼容测试。当前开发按项目集合目录组织：

```text
项目集合/
├── backend/       本项目
├── plugin/        独立电脑插件
└── dsh-mobile/    Android 客户端
```

先完成后端构建，再在相邻 `plugin/` 按其开发指南安装依赖和构建，随后回到后端运行：

```sh
npm run typecheck
npm test
```

手机、真实官方 Host 与专项环境按各测试要求准备；仅克隆后端不能运行全部跨端验收。部分历史脚本保留旧版补丁组合，**不能作为当前纯插件交付的启动方式或通过证据**。不要为了运行这些脚本修改或打包 DSH 本体。

共享协议变更需同时核对电脑插件和手机适配。版本支持与实际验收从[知识库总目录](./project-knowledge/catalog.md)查阅，不从一次协商成功推定全部能力可用。

### PostgreSQL 驱动验证

Windows x64 可运行：

```sh
npm run test:postgres
```

脚本启动本项目内的临时 PostgreSQL 17，验证实际 pg driver 和编译后的启动入口，结束后停止数据库，数据保留在被忽略的 `.test-data/`。先执行后端构建。

其他平台将专用测试数据库连接写入环境变量 `TEST_DATABASE_URL`，再运行：

```sh
node node_modules/vitest/vitest.mjs run tests/postgres.test.ts
```

测试会创建、使用并删除独立 schema，不使用生产数据库。未提供 `TEST_DATABASE_URL` 时该测试跳过，跳过不能算驱动验证通过。

## 接入真实 DSH 的协议客户端

先构建共享协议，然后启动：

```sh
node scripts/live-client.mjs
```

客户端从标准输入逐行读取 JSON 命令，标准输出逐行返回结果，终端模式不回显输入。无需读取 `.env.local` 或电脑 Host 凭据；设备私钥和 token 仅在进程内存中，退出后不能恢复。

从插件生成新的配对链接，替换以下示例值：

```json
{"command":"pair","link":"插件生成的完整配对链接","name":"DSH Mobile 协议联调"}
{"command":"status"}
```

在电脑核对 `paired` 输出的设备指纹并批准，再连接和读取会话列表：

```json
{"command":"connect"}
{"command":"request","operation":{"method":"session.list"}}
```

收到 `ready` 且 `hostOnline: true` 后再请求会话。具体操作按本仓库的[协议定义](../packages/protocol/src/index.ts)填写，follow 快照中的 `throughSeq` 用于历史分页。

- 续聊只选择专用测试会话的实际 `sessionId`，使用新的 `requestId`，先订阅 follow 观察输出。超时可能意味着结果未知，客户端不自动重发消息。
- `cancel` 取消指定订阅，`exit` 关闭客户端；`session.cancel` 才是取消 Agent 轮次，不混用。
- `{"command":"disconnect"}` 强制断开 socket，保留内存身份。收到 closed 后重新 connect 会申请新票据，需要重建订阅，不会自动重发 prompt。
- 启动时加 `--summary` 可截断长字符串并省略大字段，适合查看摘要；完整协议验证按需使用默认输出。

测试结束后在插件页撤销设备。客户端会输出明确请求的会话内容，不输出配对 key、token 或私钥；不要把完整会话输出提交到仓库。该工具没有手机 UI，不能代替真实模型请求或 Android 验收。

## 文档检查

```sh
node scripts/check-docs.mjs
```

当前脚本检查整个相邻项目集合的 Markdown 本地文件链接，排除上游检出、依赖与产物。它不验证外部网址、Markdown 锚点或文档命令的实际运行；独立克隆时缺少的集合文档需另行配套。

技术导航见[后端知识库](./project-knowledge/catalog.md)。公开 README 保持用途和使用入口，内部迭代摘要由本地项目集合维护。
