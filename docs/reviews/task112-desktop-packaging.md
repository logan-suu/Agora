# 11.2 Electron 打包、受管工具链与桌面升级方案

日期：2026-09-14。状态：**Leader已接受设计**。在确认双击应用即可自动启动受管本地服务后，Leader回复“好的确认”。正式契约已同步至[详细设计§12.3](../详细设计方案.md#desktop-contract-112)、[选型§12](../技术选型文档.md#desktop-versions-112)及蓝图/架构/开发计划；本稿保留接受依据与实测快照，后续契约以正式来源为准。接受不表示产品已实现或发布，任务当前状态以索引为准。

## 1. 结论与范围

已接受采用 **Electron 主进程管理窗口与生命周期，独立受管 Node 子进程运行 Next custom server、既有后端与 Harness**。应用运行环境、用户项目工具链和持久状态分别管理；继续使用 SSE/HTTP，不把后端搬进 renderer，也不改为静态导出。

已接受的首批构建目标为 **macOS 15.0 及以上，arm64 与 x64 分开构建和发布**，不用 Universal/Rosetta 作为原生验证替代。支持清单只列经过 11.5 实测的平台；当前仅证明 arm64/macOS 26.5 的开发机 Spike，不宣称 Intel 或 macOS 15 已通过。13.5 是本轮 Node 二进制技术下限，不作为产品支持承诺；15.0 是已接受的产品支持基线，须在构建产物和安装说明中一致表达。缺少任一目标平台证据时，该目标的发布保持未完成，不静默缩减支持承诺。

Phase 11 的最终安装包只开放安装、环境检查与故障反馈；本 Spike 复用现有群聊界面检查渲染，所有产品写请求被验证外壳拒绝，因此它**不是 Phase 11 发布候选**。11.3 必须提供与范围相符的预览界面和服务端能力门禁。Phase 12 在明确授权的验收范围验证本机执行，Phase 13 才开放完整普通项目开发并退役 Docker。

控制来源原文：

> “保留真实最小验证证据，更新选型表后才引入依赖。”——开发计划 §18.2 / 11.2
>
> “不可假设 Web 静态导出就能承载现有 API。”——详细设计 §12.3
>
> “新桌面状态升级须保留身份/配置/证据；不兼容旧Docker任务不授权丢弃新桌面状态或自动删除用户文件。”——蓝图 §21 / D18 / 11.1

## 2. 平台、版本和构建矩阵

| 对象 | 本轮接受基线 | 当前证据与发布要求 |
| --- | --- | --- |
| Electron | `44.3.0`，内含 Chromium `152.0.7977.78`、Node `24.20.0` | 官方 arm64 分发已校验并真实运行；x64 分发存在但本轮未运行。发布前复核支持期和安全补丁，变更版本须重验 |
| 服务 Node | 官方 `24.20.0`，独立可执行文件 | 脱离宿主 Node 运行 clean HEAD 的 Next 生产构建及服务；不能直接以 Electron 内置 Node 代替命令行工具链 |
| 用户项目默认 Node | 同一锁定 `24.20.0` 版本，按用途选择绝对路径 | 可以复用只读分发文件；项目版本选择不改变服务 Node。特殊版本须经准备流程获取并校验，不静默忽略项目约束 |
| 包管理器 | pnpm `9.15.9`；npm `11.19.0`（该 Node 分发附带） | pnpm 分发 integrity 匹配，pnpm/npm 版本命令均真实运行。pnpm/npm 安装依赖链在 11.4 验证；本轮未验收项目安装生命周期脚本 |
| Git | Git `2.53.0`，`desktop/dugite-native v2.53.0-4` / `4098283` | arm64 便携分发的 init/commit/linked worktree 成功；x64 待真机运行。保留已有 simple-git 端口使用方式，不引入 dugite JS 替代业务库 |
| React/Next/Harness | 复用锁文件；Next `15.5.24` | 不在打包任务顺带升级前端或 Harness；本次清洁构建成功 |
| 正式应用包组装 | `@electron/packager 20.3.0`，仅构建依赖 | 官方 registry 已核实版本及 Node `>=22.12.0` 要求；**尚未安装或运行**。11.3 按获批实现计划精确加入 devDependencies/锁文件并实测。Spike 使用官方手工 `.app` 布局，不冒充 Packager 结果 |
| 原生 helper | 仓库 `secure-files.c` / `keychain.c`，固定源码提交 | 两者以 `-arch arm64` 和 `-arch x86_64`、`-mmacosx-version-min=13.5` 编译；arm64 已执行，x64 仅证明编译产物存在。产品最低系统由 app 清单限定为 15.0 |
| 构建工具 | macOS 构建机的 Apple clang、SDK、codesign、ditto/hdiutil、notarytool | 记录实际 Xcode/CLT/SDK 版本；用户启动应用不需要编译器。当前 Apple clang 为 `21.0.0 (clang-2100.1.1.101)`，SDK 为 26.5，不能据此代替最低系统实测 |
| 安装介质 | 每架构签名 `.app`，分别生成 DMG 和 ZIP、校验和 | 本轮已形成 ad-hoc `.app` 并通过签名完整性验证；DMG/ZIP、隔离下载、安装及发布仍归 11.4/11.5 |

[Electron 44.3.0 发布页](https://releases.electronjs.org/release/v44.3.0)、[Node 24.20.0 平台定义](https://github.com/nodejs/node/blob/v24.20.0/BUILDING.md)、[便携 Git 发布及校验和](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4)、[Packager 20.3.0 元数据](https://registry.npmjs.org/@electron%2fpackager/20.3.0)。这些来源确认分发与工具要求；产品最低系统和发布范围是本轮接受的产品决定，不是上游替 Agora 作出的支持声明。

所有下载固定版本、架构、来源、哈希与许可证清单。Electron 和 Node 官方分发、Git 便携包包含的附属组件均需进入发布物料清单，保留适用声明及对应源码来源；不能只记录顶层 npm 包。候选 checksum 和实际校验记录见 [downloads.json](task112-packaging-evidence/downloads.json)。未签名元数据经 TLS 取得的哈希匹配不冒充独立发布者签名验证；正式构建还须校验适用的上游签名和最终 Agora 签名。

## 3. 目录和进程契约

已接受新增 `apps/desktop/` 作为交互层的 Electron 组合根，与 `apps/web/` 并列；它不是新的领域包。主进程只调用受信生命周期和既有服务入口，L1–L3 的依赖与 Executor/TaskStateStore/SandboxManager 公开方法不变。具体代码文件在 11.3 计划中确认。

| 位置/进程 | 唯一职责及边界 |
| --- | --- |
| `Agora.app/Contents/Resources/app.asar` | 正式 Electron 主进程、最小 preload、安装/故障界面等应用代码。受签名保护，不存状态或用户项目 |
| `Resources/service/` | Next 生产资源、自定义启动入口及完整运行依赖；普通 Node 不能把 ASAR 当普通目录，服务文件放在真实目录 |
| `Resources/toolchains/<platform>-<arch>/` | 固定版本 Node、pnpm/npm、Git 和 native helper；可执行文件不藏在 ASAR 中，不写入用户全局 PATH |
| `~/Library/Application Support/com.agora.desktop/` | 新桌面稳定应用目录，显式设置 Electron userData；子目录区分 `state/`、`profiles/`、`cache/`、`upgrade/`。产品版本和渠道不改变 canonical state 路径 |
| 用户项目目录/工作区 | 按 11.1 的项目、工作项、workspace 身份管理；应用升级不移动根目录、不重建 worktree、不重授文件权限 |
| Electron 主进程 | 单实例、窗口/菜单、受管服务 spawn 和 IPC、可信目录选择。没有模型工作循环，不读取 API Key 正文，不提供任意命令执行 IPC |
| Node 服务进程 | Next/API、凭据服务、领域/编排/Harness；在同一进程内建立既有 `__agoraLocalBootstrap` 后执行 Next instrumentation |
| Renderer | Web UI；`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`，preload 只暴露逐项校验的有限操作 |

应用服务、项目 Node 与 Git 使用受信绝对路径。服务环境由允许项重建，移除 `NODE_OPTIONS`、`NODE_PATH`、`ELECTRON_RUN_AS_NODE`、调试端口及供应商密钥等继承入口；项目命令不得继承 Agora 凭据。PATH 仅供具体受管子进程使用，保留必要系统工具，不读取 shell 初始化文件。是否允许项目 PATH 扩展由 12.2 的本机执行权限决定，不能在 11.4 默认放开。

## 4. Next 打包、连接和生命周期

### 4.1 打包方式

保持既有 custom server 模式。Next 的自动 standalone 服务器不等同于现有启动器；后者初始化钥匙串、设置 bootstrap、验证请求来源并清理资源。官方说明 standalone 不追踪自定义 server，因此本稿不采用“复制 standalone/server.js 就完成迁移”。参见 [Next custom server](https://nextjs.org/docs/app/guides/custom-server) 与 [Output File Tracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)。

构建必须从固定 Git 提交建立干净输入，安装锁定依赖并预编译 helper，然后生产构建。打包输入包括明确的 Next runtime files、`.next/server`、`.next/static`、`public`、custom server 和 instrumentation 依赖；对外部包依赖闭包和 pnpm 链接另作检查。禁止把整个工作区、整个 `.next` 缓存或任意 trace 列表未经审查塞进产品。构建脚本须对 `.env*`、`.data`、`.git`、测试凭据、外部绝对链接及未知额外文件失败关闭。

本次原开发目录 trace 有 35,016 个路径且包含 `.data`；clean HEAD 的 15 个 trace 仅收集到 3,889 个候选文件，没有禁入路径。第一版复制这些 trace 后仍缺 custom server 的 `next` 解析入口。补齐五个运行入口及其依赖后，在完全位于 `.app` 的服务目录中运行成功。它证明需要单独覆盖 custom server 依赖，不证明任意 API 的动态资源已完整覆盖。

Spike 为验证采用宽松的完整依赖包复制，约 2.2 GiB，含未裁剪分发和重复资源；**不是最终下载体积或可发布成本承诺**。11.3/11.4 使用正式 Packager、生产依赖闭包和单架构输入收敛体积，保留第三方声明，补测所有对外入口及 native module/外部包动态加载。不得靠删文件让体积达标却不重跑脱离源码的验证。

### 4.2 本机通信

主进程启动绑定 `127.0.0.1:0` 的子服务，子服务只通过继承 IPC 返回本次启动的实际地址、协议版本和 readiness。仅拿到端口不代表服务可用：凭据初始化完成或得到明确受限状态、状态格式校验完成后才能报告 ready；凭据不可用时仅允许恢复/诊断和适用无认证连接，沿用既有错误语义。

每次启动随机生成的会话 capability 只在主进程和服务内存中，通过私有 IPC 传递。Electron 网络层仅为精确本机 origin 注入认证头，覆盖 HTTP、SSE 和资源请求，不放在 URL、localStorage、磁盘或通用 renderer IPC 中。服务验证 capability、精确 Host/Origin 和跨站来源；禁止外部导航、新窗口及未经批准的权限。新窗口或重定向不得把认证头带给其他 origin。Loopback 不代表 OS 沙箱，也不承诺防御同用户恶意进程的全部能力。Electron 的 renderer 隔离建议见 [官方安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

服务重启必须销毁旧 Web session/认证注入配置再建立新的 origin/capability，不重用旧端口作为服务身份。正式 CSP、nonce、webRequest 注册冲突、SSE 断线和 IPC sender/frame 验证由 11.3 测试；Spike 没有完成这些安全验收。

### 4.3 单实例与失败

应用 ID 与 userData 根跨新桌面版本保持稳定，先取得 Electron 单实例锁，再建立服务资源。使用既有规范数据根的服务控制锁；无有效所有者证明的旧控制记录返回可恢复故障，不能凭 PID 数字或文件年龄删除后启动第二个服务。不同安装位置/版本仍不得同时写同一 state 根。[Electron app API](https://www.electronjs.org/docs/latest/api/app) 提供单实例原语，后台服务唯一写者仍需要 Agora 自身约束。

生命周期记录区分 `starting`、`ready`、`draining`、`stopped`、`failed`。ready、停止回执、子进程退出是三个独立事实；收到 stopped 后不得再次向已关闭 IPC 发送 stop，也不能在子进程未退出时报告所有资源已回收。崩溃/IPC 断开立即禁止新请求并进入安全收尾；不得自动重跑工作或自动重试不可确定的外部副作用。Phase 11 无模型工作和用户开发子进程，11.3 验证空闲正常关闭/崩溃反馈；Phase 13.2 接既有安全点、持久保存和用户主动恢复，不用 timeout/强杀冒充安全暂停。

## 5. 受管工具链准备协议

- 应用启动依赖随安装包齐备；安装检查不得要求用户先安装全局 Node/Git/pnpm/clang/Docker。依赖缺失或签名损坏显示具体组件和修复方式，不能回退到全局命令。
- 便携 Git 同时指定 `GIT_EXEC_PATH` 和 `GIT_TEMPLATE_DIR`；本次第一次运行出现默认 template 前缀无效的警告，指定分发内路径后消失。任务内部 Git 操作继续隔离全局配置、禁止未经授权 push。用户项目自身的 Git 配置处理由既有工作区契约及 12.2 决定，不能把 Spike 的 `/dev/null` 测试配置直接覆盖用户配置。
- 项目准备读取已授权的 `packageManager`、lockfile、`.node-version`/`.nvmrc`、`engines`；互相矛盾或未支持的版本明确阻塞。服务 Node 版本保持固定，用户项目版本切换不重写全局环境或修改项目声明。具体支持的附加版本进入受管清单后再启用。
- 基础 pnpm/npm 随包提供；其他管理器/特殊编译依赖属于明确的项目准备结果。下载进入应用 cache staging，校验来源/版本/架构/hash，成功后原子发布到版本目录；失败/取消只清理本次未发布 staging，不动已可用版本或用户文件。活动工作引用固定工具链版本，升级不得替换它正在使用的可执行文件。
- `install`/构建脚本是执行用户项目代码，不属于纯环境检查。必须等本机授权和文件/命令保护生效；11.4 可以在批准的临时测试项目验证准备能力，不能据此开放普通项目执行。用户模型凭据不进入工具链或项目进程。

## 6. 签名、公证和更新来源

正式发布按架构独立构建，应用 bundle 标记产品最低系统。预编译 helper 和所带 Node/Git/native modules 进入受信清单；签名需覆盖 Electron helpers/frameworks、应用自有 helper 与外部工具可执行文件。按嵌套顺序签名后验证整个 bundle，逐类评估最小 Hardened Runtime entitlement，不给普通文件 helper 加 JIT/调试能力。正式构建不以 `codesign --deep --force` 代替明确的嵌套签名计划；本轮该命令只用于 ad-hoc Spike。

优先使用 Developer ID 签名、notarytool 公证和 stapler；再验证隔离属性下首次启动与离线 ticket。上游说明见 [Electron macOS 签名流程](https://www.electronforge.io/guides/code-signing/code-signing-macos) 和 [Apple 公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。密钥/certificate/token 只由构建机安全存储或受控 CI 注入，不进入仓库、日志、应用或用户子进程。

当前宿主返回 `0 valid identities found`，本次没有签名账户、公证权限或 Intel/干净旧系统环境。ad-hoc 完整性检查通过不等于 Gatekeeper 接受或公证通过。§18.11 允许明确记录预览安装限制；如 Leader 选择受限预览发布，说明必须如实披露，并由人完成适用系统授权，不自动关闭 Gatekeeper、删除 quarantine 或宣称普通安装体验达标。正式签名和最低平台安装证据仍由 11.4/11.5 交付。

首版采用 **用户手动下载新版本并替换已退出的应用**；不引入 updater 服务、后台静默更新、自动发布或新账户体系。正式 Electron ASAR integrity 与相关 fuses（禁 run-as-node、Node options、inspect；启用 ASAR 完整性和限定载入）在 11.3 接受设计后通过构建工具配置并验证，不能破坏独立 Node 服务。当前 Spike 没有启用全部生产 fuses。[官方 fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)。

## 7. 新桌面安装升级与持久状态协议

### 7.1 不变项

安装包替换只影响 `.app`，稳定 `state/`、用户项目及工作区不跟随 app 版本改名或迁移。新桌面使用新的凭据 service ID，固定为 `com.agora.desktop.credentials`，当前用户 account 不变；所有后续新桌面版本保持此标识和签名身份关系。既有 `com.agora.local.credentials` 属旧产品配置，不自动导入、覆盖或删除。正式签名升级仍需验证同一钥匙串项的访问连续性，系统要求授权时明确提示。

模型连接、API Key 密文、角色/默认模型配置及不可变版本引用保留；不得重置为当前默认模型或重新加密掩盖旧 key 丢失。TaskState、project/control/collaboration 的 ID/revision、workspace 受信根引用、Harness JSONL/lineage、不可变验证与交付回执保留。安装目录可以变化，workspace 的 dev/inode/规范路径和 Git common-dir 不能因为升级被重建。

### 7.2 格式和升级事务

应用版本、桌面持久格式版本、组件 schema 版本分开；首个新桌面格式为 `1`，每个应用版本声明可读范围、可写版本和允许的逐步迁移。根级格式清单只属于产品存储，不给研发 `task-status.json` 添加字段。

升级顺序：

1. 用户明确退出旧应用，等待正式停服与进程退出。新应用取得同一唯一写者锁；有旧运行/未闭合操作、未知 workspace 归属或安全点证据不完整，阻止迁移并保留恢复入口。
2. 读取格式清单及待迁移文件身份/hash/revision，确认存在适用转换；无转换、版本更新于本程序或无法无损处理的活动工作返回 `upgrade_required` / `unsupported_state_version` / `upgrade_requires_quiescence`。不尝试把未来字段当旧格式接受。
3. 在 `upgrade/<operationId>/` 写入受限权限的迁移清单和所需原文件备份；记 `prepared`、from/to、文件列表、原/目标 hash、源版本、转换器版本。备份只包含受影响状态文件及密文，不复制明文 key。先完成可恢复备份和校验，再开始正式替换。
4. 对可变 JSON 文件逐项执行受控临时写/flush/原子 rename，并以持久 journal 记录进度；所有读写入口在事务闭合前保持关闭。跨文件没有全局原子 rename 的假设，重启依据逐项 hash 和 journal 判断继续/回滚，异值失败关闭。最后复核所有目标、原子提交新格式清单及 `committed` 回执，再允许常规读取。
5. 校验引用闭合与凭据可用性，展示升级结果；未完成工作仍由用户主动选择恢复，不自动调用模型、重取 lease 或重跑命令。14.1/15.1 负责 task-only 向会话/成员模型的实际转换，不伪造历史作者。

不把整棵 state/workspace 复制到“新代目录”后切 symlink，因为这会改变 Git/workspace 路径或受信根身份。不可变会话和证据不覆写、不重新生成；确需改变格式时新建版本化表示并保持源引用，由对应设计明确。

### 7.3 失败和回退

| 情形 | 必须行为 |
| --- | --- |
| 下载/校验/复制 app 失败 | 旧应用与状态保留；丢弃或保留本次下载 staging 供重试，不开始状态迁移 |
| 用户直接覆盖仍运行的 app | 启动检查发现旧进程/控制锁即拒绝并提示退出旧版；不并发迁移，不保证 Finder 外部覆盖行为可由应用拦截 |
| 磁盘不足/权限变化/迁移写失败 | 状态入口关闭，记录具体失败；依据 durable journal 恢复原文件或继续，不能仅改格式号宣称成功 |
| 新版本启动失败且迁移未提交 | 用可核验的旧文件备份回退本次改写；旧版本在确认回退完成后才能打开 |
| 迁移已提交后运行失败 | 保留新格式和备份，展示修复/恢复选择；禁止旧版静默写入新格式。回退必须有明确逆转换或完整、经过校验的升级前恢复方案 |
| 密钥缺失/锁定/拒绝/密文不匹配 | 保留配置与证据，沿用 D8 的明确恢复语义；不生成新 key 掩盖、不明文 fallback |
| 旧 Docker `.data` 存在 | 不导入、不执行、不删除；新桌面独立根。Docker 退役工程清单仍由 12.1/13.3 控制 |
| 第一次发布/没有前一桌面版本 | 升级安装测试记“不适用”，但新格式拒绝、事务失败和配置保留测试不能自动免除 |

升级备份在成功核验前保留；自动回收策略不在本稿默认开启。用户主动清理和磁盘配额需明确可恢复边界，不把升级当数据清理工具。

## 8. 本轮真实 Spike 与边界

基线提交：`58ef611e91ed27e7d05aebbcd9024190f50d99f3`。宿主：Apple Silicon / macOS 26.5 (25F71)。最终结果见 [result.json](task112-packaging-evidence/result.json)，截图见 [window.png](task112-packaging-evidence/window.png)，全部证据 hash 见 [manifest.json](task112-packaging-evidence/manifest.json)。

已验证：官方分发哈希；干净源码生产构建；真实 `.app` 身份；受管 Node/pnpm/Git；真实 linked worktree；编译后的 arm64 文件 helper 读写与越界拒绝；真实临时钥匙串经生产 instrumentation 初始化；真实动态设置 API；无认证/跨来源请求拒绝；产品写请求关闭；现有 React 页面与 renderer 无 Node；后端停止回执及进程退出；停服后同钥匙串 key 保持；测试钥匙串删除；包无外部符号链接和 `.env*`/`.data`/`.git` 目录；ad-hoc bundle 完整性。

未验证：Intel 执行、macOS 15 真机、无开发工具的干净机器、DMG/ZIP 安装、公证/Developer ID、签名升级后的钥匙串 ACL、实际 pnpm/npm 项目依赖获取、SSE 实时尾流、重复启动竞争/孤儿服务恢复、正式 Packager/fuses/CSP、升级事务故障注入、产品安全退出/真 Fork/模型/本机代码执行。未运行模型请求，没有调用既有模型凭据，没有测试或启用 Docker 退役。上述缺口按任务矩阵承接，不记录为通过，也不据此使 11.3–11.5 自动完成。

失败记录：

1. 手工包保留 `Electron` 可执行文件名，`app.isPackaged=false`；统一可执行文件名和 bundle 元数据后通过。原始 [attempt1.json](task112-packaging-evidence/attempt1.json) 保留。
2. 仅按 Next trace 复制导致 custom server 无法解析 `next`；补入口依赖闭包及内部相对链接。便携 Git template 前缀同时显式修正。原始 [attempt2.json](task112-packaging-evidence/attempt2.json) 保留；不是放宽断言。
3. 第三轮已到渲染，清理分支重复发 stop 造成 `EPIPE` 与 Electron 错误弹窗。查看弹窗确认原因后关闭。UI 工具检查期间发生额外启动，共用旧证据目录的结果被该启动覆盖，因此**第三轮不计完整通过**；其堆栈采样和截图仅作诊断。改为每次独立目录、逐检查点记录、区分 stopped 和 exit，并捕获 IPC 错误；最终新一轮全部 16 项通过、进程退出码 0、临时钥匙串删除。未伪造丢失的第三轮完整报告。

原始四个验证/构建脚本、构建日志与第三轮故障采样已随PR归档于[reproduction/](task112-packaging-evidence/reproduction/README.md)，字节与历史hash保持一致。manifest不再依赖gitignored本地路径；新checkout可完整校验全部证据。它们是实验材料，不作为生产实现，但因实际新增可执行脚本，交付按代码门禁等待人工合并，设计接受事实保持。

复现步骤和构建机要求见[复现说明](task112-packaging-evidence/reproduction/README.md)。运行`reproduce.mjs`从固定Git提交导出干净源码、用下载的受管Node/pnpm安装锁定依赖并重新构建；在新临时根运行历史验证外壳，保留全部16项断言，不依赖开发者原node_modules或旧应用包。独立机器的构建工具要求不等于最终用户免预装验收。

## 9. 接受条件与后续任务

| 任务/门禁 | 本稿提供的输入 | 仍须执行 |
| --- | --- | --- |
| 11.2 design | 版本/平台、服务边界、目录/工具链、签名矩阵、升级/故障协议、真实最小 Spike | Leader已接受，正式来源已同步；PR修复新增脚本后按代码交付等待人工合并，不替代后续产品验收 |
| 11.3 code | Electron + Node 组合根、认证连接、单实例/故障与预览能力范围 | 正式 Packager、生产依赖闭包、所有启用 API/资源、CSP/fuses/IPC、重复启动与停服失败测试 |
| 11.4 code | 版本化工具链、helper 预构建与签名、PATH、介质及升级协议 | 两目标架构安装产物、项目准备成功/失败、无全局工具环境、签名钥匙串连续性、升级事务与配置保留 |
| 11.5 exit | 本阶段预览范围、平台/版本/提交/产物/兼容清单 | 干净最低系统及当前系统实际安装、跨包集成、全部适用累计 G1–G7、发布候选记录；不以 Spike 代替 |
| 12.2/13.2/13.3 | 工具执行/身份/退出/旧数据的既定边界 | 本机授权与真实保护、安全退出和主动恢复、Docker 退役及本机替代回归 |
| 14.1/15.1 及各后续出口 | 稳定 state 根、格式事务、历史身份及配置保留 | 各自无损 schema 转换与前版安装升级；无法转换的活动工作先收敛或阻止升级 |

本次文档检查验证来源映射、依赖和索引结构、证据 hash 及 diff；未运行完整 `pnpm test`/G5 产品闭环，不声称 G1–G7 全量通过。纯设计没有编造 TDD；请求提交时仍须执行 AGENTS.md §3.1.3 的完整提交门禁。未 commit、push、建 PR、tag 或发布。


## 10. 提交时复验

2026-09-14用户调用agora-commit后，在正常桌面权限下重新运行同一隔离应用包，16项检查通过、进程exit0、临时钥匙串清理完成，ad-hoc签名完整性再次通过。新增结果见[delivery-result.json](task112-packaging-evidence/delivery-result.json)；完整提交门禁及首次工具沙箱失败记录见[任务历史](../task-history/11.2.md)。复验不扩大§8的支持平台或正式安装验收范围。


## 11. PR审查修复：交付完整复现材料

修复P2“复现材料仅存于本机”：6份原始材料纳入版本控制、保留原hash，补充固定下载来源/源码/锁文件和全新目录复现入口。设计内容未变；本PR已包含验证/构建脚本，11.2交付状态改为in_progress等待人工合并，11.3回pending。原§9的纯文档检查是接受时点记录；最新修复门禁和复现实测见[任务历史](../task-history/11.2.md)。

复现实测：固定提交的干净源码在新目录安装锁定依赖并重新构建，16项检查再次通过、临时Keychain已清理、签名和资源边界审计通过；见[reproduction-result.json](task112-packaging-evidence/reproduction-result.json)。只复制仓库证据目录即可完成19项hash校验；缺文件、坏hash与越界引用均明确拒绝。


## 12. 新增评审：输入证据范围与启动中断

CodeRabbit两条评论已核实：历史结果16份输入与后来19份清单的时点缺乏说明；启动未完成时停止可能关闭未初始化HTTP并遗留Node子进程。原结果字节见[historical-reproduction-result.json](task112-packaging-evidence/historical-reproduction-result.json)，16份范围与后补3项说明见[historical-reproduction-scope.json](task112-packaging-evidence/historical-reproduction-scope.json)。当前结果冻结实际输入manifest/hash/file列表，不将后产出的结果自身计入输入。

原始两份运行脚本保存在reproduction/historical/，当前入口修复启动/停止互斥与检查，超时只回收独立的非模型验证进程组，且记录为失败。三项真实子进程单元回归通过，fixture用于可控启动等待，不冒充真实Next/Keychain；原16项真实G5断言保留。完整回归、最新G5和逐条英文回复证据见[任务历史](../task-history/11.2.md)。


## 13. 2026-09-14测试提供方调整后的复验状态

Leader指定后续真实测试优先OpenCode Go，并明确V4.1当前ID为`deepseek-v4.1-flash`。已同步测试路由、原生reasoning兼容识别及当前Eval配置，保留官方凭据、历史模型绑定和原测试断言/期限。45项相关离线回归、typecheck/lint通过；两项真实Go回归及一次脱敏时序诊断均120秒超时。时序证明请求使用正确Go地址/模型并返回HTTP200，尚无有效完成回复，具体原因未定。当前G4仍未通过，修改保留本地、未commit/push，评审会话待交付后关闭；详情见[本轮记录](task112-go-test-routing.json)及[任务历史](../task-history/11.2.md)。这次Go调用失败不修改前述已完成的桌面16项实测结果，也不把历史官方超时改判为Go模型更名造成。


## 14. Leader暂定Go V4 Flash后的复验

当前通用真实回归固定为`opencode-go/deepseek-v4-flash`，缺Go凭据明确失败；测试断言、原生思考/容量及期限保持。首次全量运行暴露Go工具后续流片段清空身份的问题，测试adapter现复用既有`normalizeGoToolStream`处理公开stream与prepareCall两入口；离线回归先红后绿，真实LRU单独通过（186.742s），12项benchmark集成及typecheck/lint通过。更名涉及的V4.1离线fixture修复不启动V4.1实网或正式Benchmark。

随后完整默认并行回归仍有频道摘要120秒及LRU600秒超时；频道摘要单独复验10.147秒通过。关闭测试文件并发后，LRU仍在600秒超时，故不能只归因于文件并发，也不承诺换模型即可解决所有停滞。供应商内部排队/调度/容量尚无服务端证据；完整结果、源文件与日志hash见[本轮V4回归记录](task112-v4-regression.json)。G4未通过，停止追加实网重试，PR修复保留本地，未提交推送或关闭评审会话。


## 15. 全面审查后的完整 G4 通过

2026-09-14在修复分支cd9e99a完整运行原测试集合及默认并发：Node7/7、Vitest171文件1284/1284，0失败/跳过；三个Go V4 Flash实网用例均通过，LRU200.198秒。typecheck/lint及3项启动关闭回归通过，27份打包manifest哈希一致。本轮没有修改源码、断言、思考/容量或期限。详细审查、逐层统计及限制见[完整G4报告](task112-g4-review.md)。历史超时仍未确定根因，不改写此前失败；11.2恢复in_progress，后续修复PR人工合并及Phase11出口仍待完成。
