# 后端知识总目录

首次使用从[项目首页](../../README.md)、[English](../../README.en.md)、[部署指南](../deployment.md)、[开发指南](../development.md)和[Logo 素材说明](../images/README.md)进入。下方保留各阶段验证来源；包含本体补丁的历史组合不属于当前纯官方 DSH＋独立插件交付范围，部署和启动不沿用这些历史脚本。

无模型请求的[ACP测试安装与包管理配置恢复](../../../plugin/compatibility/latest-upstream/official-alpha2.md#acp测试安装的配置恢复2026-10-10)：正常官方安装、卸载和原字节恢复已验；无关配置变化拒绝覆盖。此专项不计Android成功，也不替代余额恢复后的真实审批回归。

版本边界：独立插件候选 `0.1.80-latest.0` 已在未修改的官方预发布 `0.2.1-alpha.2`、正常 `pnpm dsh web` 和真实 Android 下通过核心聊天、模型同步、审批、新建及重连；完整文件分享、交付卡片预览、计划/实际差异及电脑打开/定位已验，长聊天分页、重连及迟到回执的会话隔离另验通过；插件作者自适应声明、用户开关及页面重载保留也已验。PTC程序及内层命令结果、手机停止也已验。已清理新版预设复制/删除的协议入口；其他专项按各自版本记录，86轮恢复核对的具体范围见[新版复验入口](../../../plugin/compatibility/latest-upstream/official-alpha2.md)；版本、安装包、已取消能力及未验边界见[当前交付审查](../../../plugin/compatibility/latest-upstream/official-delivery-audit.md)。不交付修改版DSH，历史补丁结果不作为当前兼容证据，当前固定组合的本地兼容验收结论见[当前支持清单](../../../plugin/compatibility/latest-upstream/official-support.md)。 手机技能搜索、说明预览和官方正文实际加载/真实回复已验。 一层可继续子会话的手机停止、单次中断结算及停止后续聊已验。 外部任务最终正文查看、无效子会话入口拒绝及当前APK真实核心整轮已验。 文件与聊天的双引用入口、实际读取和结构化草稿重连已验。

[默认提问](../../../dsh-mobile/docs/integration/official-plugin-only.md#默认提问等待时app结束与恢复)与[计划审批](../../../dsh-mobile/docs/integration/official-plugin-only.md#计划审批等待时app结束与恢复)的App结束恢复已通过：重新打开可继续决定；另一连接已处理时撤下旧卡片。草稿和完整历史保持，答复只结算一次。[带超时提问](../../../dsh-mobile/docs/integration/official-plugin-only.md#带超时提问的app恢复与补答)的等待恢复和超时后补答也已通过；[带超时提问中的电脑退出与恢复](../../../dsh-mobile/docs/integration/official-plugin-only.md#带超时提问中的电脑退出与恢复)已通过，手机可补答原问题，结算后重启不重放；[默认提问与计划的电脑退出恢复](../../../dsh-mobile/docs/integration/official-plugin-only.md#默认提问与计划中的电脑退出与恢复)也已通过：旧卡片失效，显式新请求单次回答/批准/要求修改，结算后重启不重放；[默认提问、计划与超时补答的同时竞争](../../../dsh-mobile/docs/integration/official-plugin-only.md#默认提问计划与超时补答的同时竞争)也已通过：两条真实连接相反答复只结算一次，手机撤下旧卡片；[默认提问与计划答复发送断线](../../../dsh-mobile/docs/integration/official-plugin-only.md#默认提问与计划答复发送断线及确认丢失)也已通过：未送达保持等待，确认丢失恢复单次结果，无旧答案重放；continued/其他类型答复在途及其他计时策略另验。

纯官方电脑退出：[普通write审批等待/完成后Host重启、原Android自行重连和事件/文件核对](../../../dsh-mobile/docs/integration/official-plugin-only.md#普通write审批中的电脑端结束与恢复)通过；生命周期只操作登记的隔离测试进程树，新App核心回归通过，普通write[答复发送断线与确认丢失](../../../dsh-mobile/docs/integration/official-plugin-only.md#普通write审批答复断线与确认丢失)也已通过：未送达不自动重发，确认丢失后恢复单次结果；手机已修复能力确认前的重连时序。其他工具的Host结束和其他审批类型的答复在途异常仍待验。

纯官方文件与附件：[下载中断/最新原件重试](../../../dsh-mobile/docs/integration/official-plugin-only.md#文件下载中断与最新完整原件重试)、[系统保存窗口取消/断线清理](../../../dsh-mobile/docs/integration/official-plugin-only.md#系统保存窗口取消断线与显式重试)、[手机上传、历史附件与原件保存](../../../dsh-mobile/docs/integration/official-plugin-only.md#手机上传与历史附件预览下载)、[目标写入时App结束与恢复](../../../dsh-mobile/docs/integration/official-plugin-only.md#系统目标写入时app结束与恢复)通过；独立流字节/错误会话拒绝、官方历史/完整原件摘要核对。其他附件/生命周期、其他保存提供方/失败清理/成功回执竞争另验。测试大Buffer直接equals，驱动异常退出的[受控清理脚本](../../scripts/recover-official-file-check.mjs)单独保存恢复证据，不覆盖失败记录；附件轮模拟器重启和原App正常恢复另有报告。 [目标写入中取消/断线/撤权](../../../dsh-mobile/docs/integration/official-plugin-only.md#系统目标写入时取消断线与撤权)实际三类文件清理、断线无自动重存和完整原件手动重试已验。

当前交付规则：[官方 DSH 与纯插件边界](../../../docs/project-knowledge/knowledge/decisions/2026-10-09-official-dsh-plugin-only.md)。取消本体补丁交付；现有协议能力须按官方插件可实现范围重新审计。

纯官方：[正常 Web→生产鉴权/中转→真实 Android](../../../dsh-mobile/docs/integration/official-plugin-only.md)及[测试实现](../../tests/official-host.test.ts)通过核心/审批/计划、write等待时断线/相反答复竞争、[普通write审批等待时App结束与恢复](../../../dsh-mobile/docs/integration/official-plugin-only.md#审批等待时app结束与原会话恢复)、队列/停止/重连、普通会话导航、完成通知与App进程恢复、文件/Office、局部插件与部分管理；内容搜索依赖电脑开启，其他扩展继续验收。

转换生命周期：[原服务停用和设备撤销](../../../plugin/compatibility/latest-upstream/office-engine.md#转换中停用服务与撤销设备)npm与实际源码Android整轮通过；旧进程/队列释放、服务重启显式重试与撤销拒绝重连核验。两轮测试驱动失败保留，原App/Key/绑定及26会话3799事件保持；37原源码/启动、完整恢复构建和355资源精确核验，完整新版支持继续。

转换中断线：[实际socket中断、原生自动重连与原预览重试](../../../plugin/compatibility/latest-upstream/office-engine.md#转换进程运行中断线与原预览重试)发布与实际源码入口通过。原helper退出、队列/临时目录清理且旧请求不重发，新转换显示真实PDF正文；37原源码/启动、334.635秒恢复构建及355资源精确保持。原App/Key/配对与26会话3799事件逐项相同，Windows前台仍待核对；其他并发/撤权/服务卸载及完整新版继续。

Android 组合：[完整新版插件、生产网关、独立 Android 管理页面](../../../plugin/compatibility/latest-upstream/final-android-management.md)。npm发布与实际源码启动均通过真实配对/权限/传输、设置/模型/预设/动态插件、撤销与重启；原源码/355资源和原App/全部26会话历史精确保持。完整新版支持继续。

Electron：[原网关与桌面/Android 完整管理组合](../../../plugin/compatibility/latest-upstream/electron-runtime.md#完整-android-管理组合2026-10-09)。实际桌面Host、生产网关、独立Android管理、撤销和原配置重启恢复通过；真实消息/双流/历史专项证据保持。37原文件/启动、完整恢复构建及355资源精确核验，原App/绑定与26会话3799事件保持；首轮测试解析失败保留，完整新版支持继续。

Windows SDK：[配置重载失败与模块身份修正](../../../plugin/compatibility/latest-upstream/sdk-native.md#配置重载失败与模块身份修正2026-10-08)。第十轮完整官方打包435.436秒、原Python资源检查和实际SDK/Android管理组合164.802秒通过；原SDK9配置重载失败已在完整新载体复验解除，旧失败保持。62文件插件/55源码及165手机资源核对，模型/预设/局部插件/提供方/文件刷新/撤权/Host重启通过；本轮不进行真实模型推理。原App3722/Key/绑定及26会话3799事件保持。37原源码/启动字节、333.909秒原完整恢复构建及355资源精确恢复归档；Windows处于锁屏画面，电脑前台仍待用户解锁后核对。七条总标准及完整新版支持未全部完成。

共享转换反向取消：[第二批准连接取消、原Android继续](../../../plugin/compatibility/latest-upstream/office-engine.md#后加入的读取者取消手机继续预览)空间解除后发布与实际源码入口完整通过。原取消协议只释放第二读者，零PDF/迟到帧；同引擎继续，手机实际正文与完成缓存重开通过。原件/进程退出独立核对，37原源码/启动、378.75秒原恢复构建及355资源精确核验，原App恢复同一前台Remote聊天。生产鉴权/传输/转换未改；三个失败和重复诊断记录保留、钩子已移除，七条总标准仍未全部完成。

六格式原件：[原中转/Host到实际系统保存与独立分享接收](../../../plugin/compatibility/latest-upstream/file-transfers.md#六格式原件保存与分享补验2026-10-07)发布与实际源码两组均完整通过；不改生产认证、传输或转换器。当前62文件归档/55源码核对，24份原件大小/摘要与实际保存/分享一致，同名差异文件保持。八个Host退出、接收器卸载、原App恢复前台；37原源码/启动、381.66秒恢复构建及355资源精确核验。原失败、8份分享缓存规则及18目标审计保留，七项总标准仍未全部完成。

共享 Office 转换：[真实Android与另一已批准WebSocket共用一个转换进程](../../../plugin/compatibility/latest-upstream/office-engine.md#共享转换时关闭一个读取者)及[服务停用/撤销其中一个设备](../../../plugin/compatibility/latest-upstream/office-engine.md#双读者停用服务与撤销其中一个设备2026-10-09)在发布与实际源码入口通过；取消或撤销手机只释放其读者，第二连接仍消费完整PDF，停用服务则释放全部读者和资源。不暂停转换/分片或修改生产鉴权，37原源码/独立启动/根脚本及355资源精确恢复。原App进程变化与重开恢复证据保留，绑定及全部历史核验保持；其他完整标准继续。

新版 Office 引擎：[原手机菜单取消真实 native helper、清理与重新读取](../../../plugin/compatibility/latest-upstream/office-engine.md)在发布和实际源码 Host→生产中转→独立 Android 专项通过。只读观察器与控制文件限本项目隔离home，不修改生产鉴权、取消或转换器；37源码/独立启动/根脚本及355资源精确恢复。测试失败与原App恢复证据保持；共享读者的指定取消场景见上项，其他取消顺序、更多并发及七项总标准仍未完成。

新版第二层续聊：[显式恢复父任务、手机唯一提交/真实回复、停止保留待办及收尾释放](../../../dsh-mobile/docs/integration/latest-child-model.md#恢复父任务后的第二层手机续聊2026-10-07)在发布/实际源码入口通过。26会话全部原历史、身份与原App保持；此前父已释放时的拒绝及验证器失败另存，原37文件/完整构建/355资源已精确恢复归档，完整新版兼容继续。

新版父模型控制：[两种实际手机入口的原发送/停止/再续聊与全历史恢复](../../../dsh-mobile/docs/integration/latest-child-model.md#父模型发送消息与停止子任务2026-10-07)通过。24会话原前缀/投影/设备身份保持，仅追加官方空恢复标记；首次读取时序失败另存，稳定后严格重读通过，生产网关/鉴权未改，完整范围继续。

新版一次性子任务：[两种真实入口的手机只读、原发现工具与完整恢复](../../../dsh-mobile/docs/integration/latest-child-model.md#一次性子任务与原列表工具2026-10-07)。原中转/聊天授权下核对24会话全部原前缀/投影与设备身份，恢复只追加官方空标记；原APK/完整源码资源保持，本轮无生产网关/鉴权修改，其他控制工具继续验收。

新版子任务通知：[两种实际入口手机点击、全历史与原安装恢复](../../../dsh-mobile/docs/integration/latest-child-model.md#后台子任务通知与点击隔离2026-10-07)通过；正常发布Host恢复、22父子会话原前缀/投影/设备身份保持，原APK及原37文件/完整构建/355资源归档。本轮无生产中转/鉴权修改，完整新版兼容继续。

临时归档候选：[两种入口手机输出保留复验及原运行包/17父子历史恢复](../../../dsh-mobile/docs/integration/latest-child-model.md#停止后输出保留修复与发布入口复验2026-10-07)。`--review-candidate` 限已核验归档和停止的原测试home；七项恢复门槛测试通过。发布/实际源码pnpm均通过停止、输出重读/重入与再次续聊；全部原事件前缀/投影/设备身份及37原文件/完整构建/355资源恢复核验，只允许官方空恢复标记。生产网关/鉴权及日常版本保持，完整范围继续。

新版子会话服务：[严格只读状态流、真实Android在途卸载与原历史恢复](../../../dsh-mobile/docs/integration/latest-child-model.md#服务卸载在途与重新读取2026-10-07)在固定发布/源码入口四分支通过，沿原聊天授权、流配额及撤销清理，不放宽身份或管理权限。协议文档已同步；37原文件/启动值及原完整构建/355资源已精确恢复归档，完整兼容继续。

新版子会话故障：[生产中转及原生 Android 主聊天/旁栏六分支](../../../dsh-mobile/docs/integration/latest-child-model.md#子会话身份资料故障2026-10-07)在固定发布及实际源码pnpm入口通过，原 Host 读取/续聊拒绝、全部原历史/投影保持和撤销清理核验。故障在独立原 Session 构造，无模型推理/假认证/替代响应；37原文件/启动值及原完整构建/355资源已精确恢复归档，其他完整标准继续。

新版编辑器：[两种入口的原生手机确认、Cursor/VS Code真实工作区窗口与正常关闭](../../../plugin/compatibility/latest-upstream/desktop-apps.md#手机实际启动电脑编辑器2026-10-07)通过，沿生产网关/Store和原系统启动器。撤销拒绝、测试清理和原载荷核验保持；IntelliJ停在原信任提示、工作区未打开，完整范围不缩减。

新版应用手机在途：[发布及实际源码pnpm的服务停用、迟到准备/确认失效与恢复](../../../plugin/compatibility/latest-upstream/desktop-apps.md#手机确认期间停用服务2026-10-07)通过。沿生产网关/Store、原生桥与原管理器，零次启动、撤销拒绝及独立测试清理核验；不修改生产网关/鉴权或APK，完整兼容继续。

新版双客户端：[发布与实际源码Host、生产中转的双浏览器、Android＋浏览器及同一MuMu的两个独立Android客户端](../../../plugin/compatibility/latest-upstream/cordis-two-clients.md)通过。独立UID/凭据、迟到审批、原运行/版本保留、各自原生重连、913字节原响应迟到、三种加载/运行异常及局部Slot/Factory渲染异常的跨端显示/显式恢复、Factory兄弟实例保持、停止/重跑/移除和撤销均核验。旧版本错误遮挡和渲染失败缺少跨端通知已修正；主App/绑定保持，当前37原文件/启动值、原完整构建及355资源已精确恢复归档。原双客户端标准的逐项证据已核对，其余七条总标准仍未完成；测试不修改生产协议，不代表两台实体手机、真实推理或任意第三方插件通过。

新版真实归档：[当前62文件候选原安装/正常Host至生产中转](../../../plugin/compatibility/latest-upstream/candidate-package.md#当前完整插件源码对应的安装包2026-10-07)通过未批准拒绝、只读协商、已有工作区新会话、选模快照/电脑原列表同步、消息持久同步、流取消和撤销后拒绝；启动PID不存在、全部55源码与归档/安装字节一致。前两轮61文件证据保持。独立PGlite测试环境、无Key/无Android，不代替持续真实模型或完整兼容验收；[运行入口](../../scripts/verify-latest-review-relay.mjs)只消费本轮原安装报告，不覆盖正常联调候选。

SDK隔离载体：[完整官方成功记录核验、原Python资源检查及原home恢复](../../../plugin/compatibility/latest-upstream/source-runner-profile-resolution.md#sdk-打包与源码恢复)。`--resume --sdk-sea` 与SOURCE/诊断互斥，旧进程必须停止且cleanup归属通过；六项启动/恢复测试通过。官方第四/第六轮明确磁盘不足失败，失败轮次被实际核验器拒绝启动；三个目录原属性及36原源码/启动字节、原构建/355资源精确恢复归档。SDK打包需增加Q盘空间，实际载体仍待验。

新版手机超时：[修复超时的原分类/兼容说明/失败详情](../../../plugin/compatibility/latest-upstream/package-repair.md#手机修复超时的分类与详情)和[普通脚本的实际超时主文案/回执/进程退出](../../../dsh-mobile/docs/integration/latest-install-recovery.md#普通安装脚本的手机超时页)分别在两种入口通过。原十秒诊断已精确移除，独立原安装器清理、配置/历史/权限恢复通过，正常SOURCE恢复；五项启动恢复边界保持。不替换安装器/结果或默认生产配置，仅Host退出、手机安装摘要冷恢复及完整范围继续，首轮验证器失败保留。

新版可继续子会话：[发布/源码真实模型创建、手机直接续聊、重入、Host重启后完整原历史/再次续聊及unknown地址经手机原SDK中转读取](../../../dsh-mobile/docs/integration/latest-child-model.md)通过，沿用原配对与父子地址；错误类型被原Host拒绝、原历史未变。冷接口不启动Agent，失败测试断言按原契约修正且原失败保留。损坏目录/descriptor与其他完整标准仍待验。

新版自动审核联调：[原实验包与只读观察器、两种入口实际取消、低风险放行、ask手机拒绝与never最终自动拒绝](../../../dsh-mobile/docs/integration/latest-auto-review.md)。原pwsh未执行、文件保持，权限/历史/正常命令目录恢复；测试策略仅经原本机CommandsService设置，中转权限未扩大。源码Host意外退出原因未知，原审核归档与恢复证据保留；13项/31文件最终精确恢复与完整范围继续。

新版待办通知：[发布提问/审批、两种入口受阻原结算和手机显示修复](../../../dsh-mobile/docs/integration/notifications-current.md#新版待办通知与受阻显示2026-10-06)通过，固定源码原待办证据保留。真实 Android 通知/历史保持、诊断配置移除、管理false；自动审核/其他失败原因及完整范围仍待验。

新版程序写入：[原失败工作区的实际手机修复与精确恢复](../../../dsh-mobile/docs/integration/latest-ptc-files.md#原失败工作区的两个实际手机入口2026-10-06)在SOURCE/RELEASE通过同一旧文件修改/回读、只读拒绝、详情/历史；全部8对象原权限与字节恢复。[原生负例及独立操作入口](../../../dsh-mobile/docs/integration/latest-ptc-files.md#原生拒绝边界与独立操作入口2026-10-06)补齐缺WRITE_DAC、非本人所有和junction拒绝，28操作/越界/重复/明确拒绝回滚保持。[人工工具](../../../plugin/compatibility/latest-upstream/acl-repair.md)有CLI和恢复说明，含新克隆布局的10项入口测试通过；文件符号链接输出1项未实测，完整新版范围继续，生产沙箱和日常旧版保持。

固定源码恢复：[完整历史核对器及真实Android重入](../../../dsh-mobile/docs/integration/latest-live-recovery.md#固定源码的完整历史恢复核对2026-10-06)核验五会话880原事件逐条保持、所有projection与设备身份不变，只增加一个官方恢复标记；原序号不变失败报告保留。两种入口[PTC内部真实pwsh停止](../../../plugin/compatibility/latest-upstream/tool-cancellation.md)及[后台完成通知/点击](../../../dsh-mobile/docs/integration/notifications-current.md#固定新版的后台完成通知2026-10-06)通过，设备管理false；不代表其他通知类型、完整新版交付或后台输出跨Host持久性已验证。

新版任务目录：[job/list 策略与实际 Android 输出](../../../dsh-mobile/docs/integration/latest-background-jobs.md)。只读会话目录在新版公布，旧版拒绝，网关/Host 都校验固定形状；策略、真实流首帧/取消/撤权及原五会话恢复通过。发布及固定源码 Android 双流输出、历史重入、显式重连、单任务停止、真实进程退出、输出保留及其他任务继续完成通过；约421KB中文/emoji窗口、四段历史、结算重入与真实缺口提示也已在固定源码入口通过；首轮额外模型调用失败保留。更多连接/生产者异常仍待专项。

新版持久模型环境：[同home/网关/配对/四会话状态的真实重启恢复](../../../dsh-mobile/docs/integration/latest-live-recovery.md)通过，四项恢复边界及活环境拒绝通过。发布和固定源码Android实际中文/emoji标准流、错误流、实时输出和历史重入通过；固定源码审批、提问及只读PTC真实推理通过，完整有效能力与最终停止/恢复仍待验。

Windows文件读取权限：[原协议专项](../../../plugin/compatibility/latest-upstream/office-lifetime.md#实际-windows-文件读取权限在途收回)在发布100.14秒、源码外层117.89秒通过，原构建/字节/355资源精确恢复已核验。另在[实际Android失败页与重试专项](../../../plugin/compatibility/latest-upstream/office-lifetime.md#实际-android-文件读取权限在途收回与重试)通过发布133.99秒、源码外层159.71秒：完整PDF被原末尾权限检查拒绝、无旧画布，恢复原DACL/字节后点击原重试显示实际PDF正文；Host容量释放与缓存重新授权核验。源码完整恢复288.95秒、原28源码/355资源摘要/Git干净及清理核验通过；附件引用变化、其他ACL/操作系统仍待验，不记为全部权限范围通过；单读者引擎运行中取消另见上方专项。

新版Office：[真实传输、缓存、预览关闭、连接恢复、设备收权及会话归属](../../../plugin/compatibility/latest-upstream/office-lifetime.md)在发布和实际源码pnpm入口通过。收回管理权限后可只读重连，撤销设备后拒绝重连；旧请求/画布清理与Host名额释放核验，原28源码/355资源精确恢复及测试授权/进程清理。主聊天的真实PDF在途切换另在发布与源码Android通过：原载入取消并释放容量，标签身份保留，返回原标签重新读取并显示实际正文。实际Windows ReadData权限收回后的Android失败/重试、原DACL与字节恢复、实际PDF正文和容量释放已在发布与源码入口通过。普通会话切换的缓存按所属会话重新授权，同名文件实际PDF正文与错误会话附件拒绝通过；模型验收App/绑定保留并恢复同一空聊天。单读者取消及共享转换关闭一个读者另见上方专项；共享转换的其他取消顺序、更多并发、旁栏/并发预览在途切换会话、其他文件权限/操作系统及附件引用在途变化、原件下载分享及更广网络时序仍待验。

新版真实模型：[真实回复与文件审批](../../../dsh-mobile/docs/integration/latest-compatibility.md#真实模型回复与文件审批2026-10-06)在独立发布Host/Android自有页面通过。原Key仅核对配置状态；电脑同一会话实际回复、文件读取、只读拒绝后单次批准/真实写入及原权限恢复已核验，设备管理false。发布环境的真实拒绝、提问回答及只读与可写PTC停止/历史重入/继续回复另已通过；测试目录权限前提已定位、验证并恢复。[固定源码专项](../../../dsh-mobile/docs/integration/latest-compatibility.md#固定源码的审批提问与只读ptc2026-10-06)另通过批准/拒绝、提问及只读PTC停止/历史/继续回复，原字节和会话权限恢复。固定源码可写PTC外层停止/历史/继续回复与目录权限精确恢复也通过；内部工具/自动审核取消、其他模式及后台通知仍待验；原持久环境继续保留，最终撤销授权并清理服务。

新版电脑应用在途：[真实协议与手机失效页](../../../plugin/compatibility/latest-upstream/desktop-apps.md#应用查询在途异常)在发布与源码入口通过取消/断线/撤权迟到结果拒绝、真实工作区故障恢复及原服务卸载/重新启用；发布206.01秒、源码pnpm250.26秒协议/独立Android/原Host重启组合通过实际确认撤权和Windows无测试路径窗口。28源码/355原资源精确恢复与清理通过，不代替完整新版验收。

新版子会话：[Session投影目录与共享导航](../../../plugin/compatibility/latest-upstream/subagent-catalog.md)，网关严格限制只读参数，Host按两版契约协商和拒绝不匹配调用；原404证据保留，发布186.56秒与源码pnpm243.16秒的本轮Remote/独立Android/原Host重启链路、28源码/355原资源精确恢复及清理通过。

新版DSH隔离联调：[真实Host与网关测试](../../tests/latest-host.test.ts)及[候选范围](../../../plugin/compatibility/latest-upstream/README.md)。基础配对、权限、消息持久同步、选模和撤销通过；另已执行[真实自有页面及独立Android](../../../dsh-mobile/docs/integration/latest-compatibility.md)，不代表真实模型回复或完整兼容。需先构建插件新版候选，再在后端运行`node node_modules/vitest/vitest.mjs run tests/latest-host.test.ts`；浏览器专项设置 `DSHM_LATEST_PAGE_CHECK=1`，Android 专项设置 `DSHM_LATEST_ANDROID_CHECK=1`、显式模拟器序列号和 adb 路径，并先构建/安装独立候选 APK。

源码联调使用插件目录的[专用验证器](../../../plugin/scripts/verify-latest-source-remote.mjs)，在完整固定隔离检出安装当前十一项/28文件源码及启动载荷，官方完整构建后以实际`pnpm dsh web`运行同一套验收，再恢复原字节和原客户端产物。`DSHM_LATEST_SOURCE_CHECK=1`入口严格核对已安装的二十八文件及启动引导，不代用npm运行补丁；[源码证据与限制](../../../plugin/compatibility/latest-upstream/source-runtime.md)区分函数/类型与实际Remote结果。十一项源码完整构建、实际pnpm/网关/独立Android/Office/传输/Windows测试目录启动/原Host重启与28文件/355资源恢复通过。此前十项的相关报告保持原范围，发布包Web另通过。两种入口另完成[多连接确认归属与重连拒绝](../../tests/support/latest-desktop-connection.ts)，查询在途协议及手机实际撤权范围见上方应用异常入口，不推定所有故障组合通过。独立[手机管理专项](../../tests/latest-plugin-upgrade.test.ts)通过发布与源码入口的实际安装、升级、原Host重启执行新版及卸载；源码使用单独的`--plugin-management`选项，报告与异常边界见[管理证据](../../../plugin/compatibility/latest-upstream/package-management.md)。完整目标仍待验。测试仅结束本次拥有的pnpm进程树，不改日常DSH。

真实Host的超时清理使用[Vitest结束钩子](../../tests/support/latest-host-cleanup.ts)，不依赖测试体的异步finally；[时限回归](../../tests/latest-host-cleanup.test.ts)实际触发超时，确认本测试父子进程消失。Android验证另回收独立测试UID及本次adb reverse，并记录阶段时间。Web和Android专项可分别运行，累计超时不算功能通过，必须保留失败报告并单独完成对应验收。

| 分类 | 入口 |
| --- | --- |
| 系统蓝图 | [整体模块地图](../../../docs/project-knowledge/blueprint/module-map.md)，后端包含 gateway 与 protocol 两个包 |
| 业务域 | [远程访问](../../../docs/project-knowledge/knowledge/domains/remote-access/INDEX.md) |
| 开发规则 | [集合中的后端规则](../../../AGENTS.md#公网后端) |
| 共享知识 | [跨端协议](../../../docs/protocol.md) |
| 长期决策 | [技术栈](../../../docs/project-knowledge/knowledge/decisions/2026-09-22-backend-stack.md) |
| 候选知识 | [桌面接入限制](../../../docs/project-knowledge/knowledge/candidate/desktop-plugin-review.md) |
| 校验方式 | [开发与验证](../development.md)、[部署与运行](../deployment.md)、[验证矩阵](../../../docs/project-knowledge/validation/README.md) |

- [公网临时联调服务器](../../deploy/public-server.md)：HTTP 18787 的实际公网通信、配对/撤销、容器重启与隔离备份恢复通过；不代表 HTTPS 或真实手机/DSH 公网整轮通过。
