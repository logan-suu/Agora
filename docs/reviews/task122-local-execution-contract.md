# 12.2 本机执行契约：设计接受记录

**[2026-09-15 架构决策更新] Leader已回复“确认”，接受本设计及限制。** 正式规则已迁入[详细设计§12.2](../详细设计方案.md#local-execution-contract-122)，当前任务状态只查索引，接受与校验记录见[12.2历史](../task-history/12.2.md)。设计完成不代表产品能力实装或G5通过。

以下保留提交审阅时的原文；其中“草案”“待确认”“任务保持in_progress”均描述接受前时点，不是当前规则或状态。原稿SHA-256与[原始源码证据](task122-source-evidence.json)一致：`47f19b22f91871f0f2ba66063e52cbb397045f3342d51031a9f6489b37bc9b3d`。后续规范变更以正式来源为准，不维护此历史原稿作为第二套规格。

<details>
<summary>审阅时点原稿（历史）</summary>

<!-- BEGIN ACCEPTED DRAFT 12.2 -->
# 12.2 本机执行授权与工作区保护契约草案

日期：2026-09-15。状态：**待 Leader 审阅，尚未定稿或启用**。研发任务当前状态只查 `docs/task-status.json`；执行记录见 [12.2 历史](../task-history/12.2.md)。

## 1. 建议与待确认取舍

建议在现有 Harness/MCP 外侧增加受信本机能力层：文件通过带版本的受信写入事务进入实际项目；项目命令通过 macOS Seatbelt 执行；工作区和验证版本有独立类型；所有授权、撤回、接管和交付有持久回执。普通目录无需 Git，独立编码并行才使用真实 linked worktree。

本草案需要 Leader 接受两项实质取舍，接受前不改写既有已定规则：

1. **采用系统 `/usr/bin/sandbox-exec` 作为第一版命令强制边界的候选。** 它不增加第三方运行时依赖，适合按每次命令生成目录/网络策略，但本机手册明确标为 DEPRECATED，SDK 的 `sandbox_init` 标为“No longer supported”。这意味着维护风险真实存在。方案要求逐系统构建/工具链实测与启动探测，机制不可用就关闭执行，绝不裸跑或回退 Docker。Apple App Sandbox + 独立 helper 是替代设计方向，需要另做动态目录授权、子进程继承、签名和现有独立服务组合验证；本草案不声称它不可行，也不把它当作已验证替代品。
2. **外部编辑采用合作接管、版本冲突检测与保全，不承诺控制任意编辑器。** 受 Agora 管理的写者必须严格服从接管；未接管的外部进程持续写同一文件时，系统不能仅靠 watcher、文件锁或 hash 检查提供原子内容比较后替换。检测到冲突停止并保留各版本；真正无竞争的人工编辑应先接管、等“可安全编辑”。原产品规则已允许这一保证边界，但不能把“检测后保全”宣传为所有外部写入都不会被短暂替换。

日常编辑默认仍直达用户目录。依赖安装、构建、测试脚本无权任意改源码；需要修改源码的生成器在临时执行副本产出改动，再经过同一版本写入事务应用。此限制避免“文件工具有保护、npm 脚本却能绕过保护”。

## 2. 控制来源原文

- 蓝图 §22.3.1：“普通会话默认直接编辑用户选择的本机项目目录”，“同一共享目录只允许一项执行工作写入，其他成员可讨论、读取或提出建议。”
- 蓝图 §22.3.1：“已有未提交修改可以保留并继续开发，不强制用户先提交或暂存；记录开始时的状态，应用、撤销 Agent 改动时保护用户工作，无法安全合并的冲突再请用户处理。”
- 蓝图 §22.7.5：“用户接管相关文件后，Agent 在安全点暂停涉及这些文件的工作，其他独立工作继续；界面区分等待暂停与已可安全编辑。”
- 详细设计 §12.2：“实际工具调用必须由受信端口校验，不能只靠提示词；L1 零 I/O、L2 只依赖端口不变。”
- 详细设计 §12.1.6：“直编普通目录无 Git commit 时不伪造 WorktreeRef.branch/baseCommit”，“Git 版本是实测 HEAD；普通目录版本须能证明实测文件集合/内容和外部修改失效”。
- 蓝图 D18：“Worktree 是文件隔离，不宣称宿主命令天然处于操作系统安全沙箱。”

适用 D1/D4/D8/D9/D15/D16/D17/D18、R1/R2/R4/R8/R9/R11/R12、TEST-CLEANUP。第一批保持 task-only、roleSlot 和当前全局 cap=3；不提前实现会话、人力体系或 KB 写入。

## 3. 实现证据与缺口

只读核对基线：`4d4930df97fc5dc3f84ec25dc6518cfeaff21343`。以下是设计输入，不是本机 G5 结果。

| 来源 | 已有能力 | 12.2 必须覆盖的缺口 |
| --- | --- | --- |
| `packages/runtime/sandbox/src/sandbox-manager.ts`、`recoverable-sandbox-manager.ts` | 六个冻结方法及 D4 companion | `Worktree` 强制带 branch，不能代表普通目录；`write` 无 expectedVersion；`run` 是字符串 |
| `packages/runtime/sandbox/src/secure-files.ts`、`native/secure-files.c` | 根 dev/ino 固定、fd 相对路径解析、拒绝越界/特殊文件/多硬链接 | 当前 write 使用 `ftruncate` 再写，无内容版本、恢复 journal 和原子替换；不能直接移植到用户源码写入 |
| `packages/runtime/sandbox/src/local-temp-sandbox.ts` | Phase 0 真临时目录与命令执行 | `runInDir` 不是本机生产权限边界；suspend 不提供命令树收敛证明 |
| `packages/runtime/sandbox/src/workspace-adapter.ts` | Git 与执行工作区统一、累计 base、创建补偿、独立 integration | task-owned 路径假设不能直接接受用户项目；没有 direct 类型 |
| `packages/tools/fs/src/fs-server.ts`、`worktree-registry.ts` | MCP 根白名单和同步文件接口 | 参数不能证明调用者 worker/当前授权；无读版本令牌、接管协议 |
| `packages/tools/git/src/git-service.ts` | 真实 linked-worktree 核验、Git 操作与 stable-files hook；`trustedGit` 已关闭 hooks/fsmonitor/global/system config | 本机用户仓库的 local config/filter、受管 Git 路径、未提交修改与外部 Git 操作必须另审；不能以忽略用户修改建立 HEAD-only 基线 |
| `apps/web/src/server/task-composition.ts` | 统一组合根、D4/worker/归档接缝 | 直接装配 Docker `withStableFiles`；新方案必须替代稳定文件与进程收敛，不能置空 |
| `packages/core/domain/src/state.ts`、`reducer.ts`、`packages/runtime/state/src/json-task-state-store.ts` | 规范 State 合并/校验 | 现有 worker/subtask 和波次证据依赖 Git WorktreeRef；须显式新类型与 serial-only 写入，不能塞假 branch |

既有实现符合其 Docker/Phase 0 使用前提；这些是新本机能力的设计缺口，不据此宣称旧产品已存在同类漏洞。

## 4. 授权和强制边界

### 4.1 授权对象

项目首次打开先展示并确认实际规范根、默认工具类别、下载目的地、可写产物目录及已有修改。授权包含 `grantId/projectId/rootId/revision/policyVersion`、允许动作、根与例外范围、工具链清单引用、网络配置引用、创建/撤回 actionId 和 Leader 消息回执；秘密值不进入授权记录。

普通授权覆盖该项目内编辑、依赖安装、构建、测试；新增根、扩大网络、删除用户已有文件、破坏性 Git 操作、push/发布另行确认。为自身新增文件撤销，也必须核验当前内容仍属于该操作，不删除后来写入的用户内容。拒绝不能伪装成命令成功。保存授权不是永久活 capability；每次调用核对当前 revision、文件身份、writer epoch 和 task/worker 绑定。

授权变更通过 `POST /api/messages` 的受控 Leader 动作提交，沿用 msgId/actionId 及副作用前校验。新增可读动作是 `/workspace grant|revoke|takeover|return|apply|undo`，参数由 UI 显示规范对象/前后对照后生成；不接受模型伪造 Leader 信封。命令解析器只接受对应封闭结构，不把自然语言直接变成宿主命令。注册工作区属于组合根生命周期操作，必须引用已提交授权。

规范请求固定为 `/workspace <verb> <JSON>`，禁止尾随第二个命令；JSON 不接受额外字段。共同字段为 projectId/taskId、actionId、expectedRevision；grant 引用受信 selectionRef 和 policyProposalId，revoke 引用 grantId，takeover 引用 workspaceId/规范相对路径集合，return 引用 takeoverReceiptId，apply/undo 分别引用 deliveryProposalId/fileApplyReceiptId。grant/apply/undo 的可读确认另绑定 proposal 的完整 inputHash 和当前版本；任何新增或变化范围都使旧确认无效。projectId/taskId须与路由和 Leader 主频道匹配。底层共享写域动作不能因来自另一个项目而绕过正在生效的接管。

### 4.2 每次进程的权限

| 资源 | 默认方案 |
| --- | --- |
| 源码 | 当前授权 workspace 的准入文件只读；有版本的受信文件事务是源码写入唯一入口 |
| 构建/测试输出 | 仅本次明确登记的新建或已归 Agora 管理的输出根可写；已有用户 `dist/.next/coverage/node_modules` 不因名称相同自动归 Agora |
| 安装与代码生成 | 在任务专用执行副本运行；lockfile/源码变化走审阅和版本事务；依赖树以独立受控安装产物挂接，不覆盖用户已有目录 |
| 工具链 | 使用 11.4 锁定的 Node/Git/包管理器绝对路径；受管分发只读。项目 PATH 仅追加当前隔离依赖的 `.bin` 和批准的系统工具，不读 shell 初始化文件 |
| cache/tmp/home | 每项目/执行专用可写根；重建 `HOME/TMPDIR`、包管理器 store/cache；不把真实用户 HOME、全局 pnpm/npm cache 作为默认可读或可写根 |
| Agora 状态与凭据 | 项目进程不能读应用状态、官方 session、控制 socket/认证、主密钥或钥匙串；清空继承环境并按白名单重建，关闭多余 fd，不能仅删 API_KEY 环境变量 |
| 项目自身秘密 | 默认排除 `.env`、`.env.*`（明确无秘密的 example/template 可准入）、凭据文件及用户标记的敏感路径；项目秘密若确需用于运行应另行授权并使用专门隔离引用，不进入模型投影/日志。本轮不实现通用秘密管理，也不声称能识别藏在普通源码内的所有秘密 |
| 网络 | build/test/generate 默认禁网；下载经受信代理，仅批准的 origin/method/port，重定向逐跳校验，拒绝私网/元数据/服务端口、任意 CONNECT/Unix socket；包安装不能凭 npm 名称取得全网权限 |
| 本机预览 | 显式服务 capability，仅自己的 loopback 监听端口、已批准输出/代码根；客户端不能连 Agora 后端或其他用户服务。端口先登记再启动，冲突不杀已有进程；不能以 loopback 全放开实现。预览页面在独立 origin/无 preload 和后端认证的受隔离窗口或浏览器显示，不能加载到 Agora 有权限的 renderer 中 |
| IPC/其他进程 | 拒绝任意 Mach 服务、Apple Events、Keychain、调试/注入和对非本次进程的信号；所需系统例外必须固定、最小并实测，不用宽泛 allow-default |

受信 launcher 在 exec 项目代码前安装 Seatbelt 策略。项目脚本即使间接调用 shell、Python、curl 或 `/usr/bin/security`，仍受同一 OS 策略；工具名白名单本身不是隔离。未获准的工具版本或策略不能自动重试为 unsandboxed。受信文件/Git/下载服务不可成为代理绕过：无项目进程可取得其认证，所有输入重验 scope、路径和授权。

传入 shell 字符串只作为受隔离的项目程序，不以字符串过滤器承诺识别所有危险行为。新生产入口首选 `toolId + argv + cwdRef`，控制面操作使用独立方法；不拼接用户字符串到宿主 shell。包生命周期脚本属于不受信项目代码，与根脚本同边界。候选代理和 supervisor 优先使用受管 Node 内置能力及现有 native helper 工程；任何新增第三方依赖仍须按选型 §12 先讨论，不能因本草案提到代理就自动安装外部服务。

### 4.3 机制选择与失败关闭

| 路线 | 判断 |
| --- | --- |
| Seatbelt / sandbox-exec | 推荐进入 12.3 的候选实装和 G5。OS 自带、可按命令制定策略；弃用风险需 Leader 接受。必须验证子孙进程继承、IPC、网络与路径别名，不能凭上游使用过就认定 Agora 安全 |
| App Sandbox 独立执行 helper | Apple 提供的应用沙箱路线；动态目录、执行工具与子进程权限、ad-hoc 分发组合需单独验证。不是给现有 Electron 加一个布尔开关即可替换 |
| 仅 cwd/路径检查/Node 权限/命令字符串检查 | 不足以强制约束任意依赖脚本及其子进程，不能采用为生产边界 |
| Docker/VM/管理员守护进程 | Docker 与已定 D18 冲突；VM/特权服务扩大部署与信任范围，本任务不引入 |

启动时绑定 OS build、架构、受管工具链和策略版本；真实探测隔离允许/拒绝行为。升级 OS/工具链/策略后重做探测。失败显示 `sandbox_unavailable`，保留项目可浏览状态并停止执行；不回退 LocalTemp、裸 shell 或 Docker。探测只在任务拥有的测试目录进行，不读取真实钥匙串秘密来测试拒绝。

## 5. 身份、存储和接口

### 5.1 持久记录的唯一所有权

- 现有项目注册继续保存项目名称与根入口；runtime/sandbox 的受信 registry 只保存 root 真实身份、授权、workspace 技术绑定、writer 占用和文件事务回执，不复制 roster/Channel/需求或任务进度。Phase14 ProjectControlStoreV2 接管项目控制元数据时保留这些 capability 引用，禁止双写两份授权。
- registry 增加一个**版本化、唯一写者的本机能力记录**，放在新桌面状态根内 `local-workspaces/registry.json`，由 JSON 原子快照/CAS 更新。关联项目/任务的是不可变 ID；跨 root 的 writer 冲突在同一原子域判断。大文件内容另存受保护的按 hash 寻址对象，registry 只引用，不作为 KB。
- `schemaVersion='local-workspaces-v1'`，完整记录包含 revision、roots、grants、workspaces、claims、operations；操作 journal 先 durable prepared，再发生文件/进程副作用，最后 observed/applied receipt。记录恢复采用 11.1 prepared/committed 语义，不能以文件存在跳过核验。
- TaskState 新增可选 `localExecution`，其明确版本为 `local-execution-v1`，含 task 根绑定、workspace 引用、worker/subtask 到 workspace 的绑定、最近已提交操作 receipt 引用。只有串行控制面经 `applyMutations` 的新 set 字段可写；worker 模型不能 set/merge 此字段或自行授予权限。旧 Docker State 不转换为有权新状态。
- 两存储的动作在 registry prepared → TaskState canonical 引用提交 → registry committed 闭合；普通执行只接受双方闭合绑定。失败后先按 actionId/inputHash 恢复，不生成第二份 task 或批准记录。文件操作自身的 durable journal 是技术回执，不回写另一份 AppState。

registry CAS 的 revision/epoch 是非负安全整数，变更递增，不能回绕；跨重启先取得现有桌面唯一写者锁，再重放 journal。rootId/workspaceId 等不透明 ID 全局唯一且作用域不可变，授权 revision 更新不重用被撤回的活权限。claim 以规范冲突域和 writerEpoch 标识，只约束文件写入，不代替 GlobalScheduler lease；过期时间不足以证明旧进程已死，不能靠 TTL 抢占。rootId 解析为规范 volume/dev/inode/父链与用户选择回执，不通过字符串前缀判断嵌套。

### 5.2 数据类型草案

下列为新增能力的类型轮廓；`Id/Hash/RelativePath` 均须使用现有规范字符/长度校验和严格 JSON schema。所有路径从受信记录解析，客户端不能给绝对路径取得能力。

```ts
type WorkspaceRefV1 = {
  schemaVersion: 'workspace-v1';
  projectId: string;
  taskId: string;
  workspaceId: string;
  rootId: string;
  grantId: string;
  purpose: 'coding' | 'validation' | 'integration';
} & (
  | { mode: 'direct'; baselineManifestId: string }
  | {
      mode: 'linked-worktree';
      commonDirId: string;
      branch: string;
      baseCommit: string;
    }
);

type WorkspaceVersionV1 =
  | { kind: 'files'; manifestId: string; manifestHash: string }
  | { kind: 'git'; commit: string; manifestId: string; manifestHash: string };

type FileVersionV1 =
  | { kind: 'absent'; parentIdentity: string; name: string }
  | {
      kind: 'regular';
      identity: string;
      sha256: string;
      size: number;
      executable: boolean;
      metadataHash: string;
    };

type FileChangeV1 =
  | { op: 'put'; path: string; expected: FileVersionV1; contentRef: string }
  | { op: 'remove'; path: string; expected: FileVersionV1 };

interface WorkspaceCall {
  projectId: string;
  taskId: string;
  workspaceId: string;
  workerId: string;
  actionId: string;
  grantRevision: number;
  writerEpoch: number;
}
```

`WorkspaceCall` 由受信 transport/worker 绑定补全并复核，不信任模型自报 workerId/epoch。服务用途使用独立的受信调用联合（validation/integration/leader-control），不能伪造 workerId。授权 revision/epoch 不是秘密或 bearer token；活句柄不能序列化给模型。Git `headCommit` 属版本证据，不是另一个 workspace 所有权字段。direct 不进入旧 WorktreeRef 判别器。

### 5.3 新端口与冻结接口

新端口位于既有 `runtime/sandbox`，领域类型放 `core/domain`，编排只依赖 L3，MCP 适配位于既有 `tools/*`；不新增顶层包。

| 新能力及建议签名 | 语义 |
| --- | --- |
| `inspectRoot(selectionRef): Promise<RootInspection>` | 受信目录选择引用；返回规范身份、重叠/嵌套、Git 情况和风险摘要，不授予权限 |
| `commitControl(expectedRevision, command): Promise<WorkspaceControlReceipt>` | 封闭联合 grant/revoke/register/claim/release/takeover/return；稳定 actionId/inputHash、Leader 或组合根来源鉴权；返回持久引用，不返回可任意写根的句柄 |
| `readFile(call, path): Promise<FileReadReceipt>` | 判别联合：file 分支含 content/regular version/readReceiptId，absent 分支含 absent version/readReceiptId；同一次安全打开取得内容与版本，用于安全创建 |
| `applyFiles(call, changes, basisReceiptId): Promise<FileApplyReceipt>` | 完整读写集、预期版本、授权和当前接管逐项验证；同动作幂等；失败不冒充整批成功 |
| `runCommand(call, request): Promise<CommandReceipt>` | request 固定 toolId/argv、输入版本、输出根、networkGrantId、timeoutMs，默认 30000；返回真实退出/超时/副作用状态 |
| `captureVersion(scope): Promise<WorkspaceVersionV1>` | 受信输入清单和内容寻址快照；不能只采集 mtime；稳定性不明就无有效版本 |
| `quiesce(scope, reason): Promise<QuiescenceReceipt>` | 收拢 admission、等待工具/写事务、证明已登记服务和全部后代收敛；不取消 Harness token 流 |
| `resumeBinding(scope, receiptId): Promise<WorkspaceRefV1>` | 验证根、授权/版本/接管与 D4 引用后重新取得活能力，不恢复旧 lease |
| `prepareDelivery(scope, version, targetVersion): Promise<DeliveryProposal>` / `applyDelivery(leaderCall, proposalId): Promise<FileApplyReceipt>` | 用户可读前后对照，绑定精确实测产物和目标当前版本；过期拒绝 |

这些是设计建议的新方法，不是已经存在的导出。`CommandReceipt` 包含 RunResult 原四字段、commandId/inputVersion/policyHash/工具版本、开始结束时间、输出引用与收敛状态；原始命令输出按 D15 不直接进入通用 Trace，秘密过滤不替代访问隔离。

新增 receipt 的共同字段为 schemaVersion、receiptId、actionId、inputHash、projectId/taskId/workspaceId、grantRevision、writerEpoch、stage、createdAt 和 canonicalSourceRef。`FileApplyReceipt.stage` 为 prepared/applied/partial/conflict/recoveryRequired，逐项记录 expected/observed/result 版本及备份对象引用；`CommandReceipt.stage` 为 starting/running/exited/timedOut/needsAttention，退出后另有 quiescent 布尔值。prepared/running 不是可验证成功；同一 terminal receipt 不覆盖历史事实，后续恢复用引用它的新事实。stdout/stderr 在现有 RunResult 消费点可受限返回，在持久记录中使用对象引用与大小上限，不能把 trace DTO 当原始输出库。

`localExecution` 的 worker/subtask 绑定只保存 workspaceId 和创建/恢复回执；`workspaces` 是不可变 WorkspaceRefV1 引用集合，技术生命周期从 registry 读取。`TestResults`、completionCandidate、验证/归档 receipt 统一新增带版本判别的 `workspaceVersion` 引用；新本机状态禁止同时以旧 worktree 字段与新 workspaceId 双重解释同一执行。旧 Git 字段只在旧路径或无损适配的已登记 linked-worktree 内有效。State load、applyMutations、投影、恢复和 D16 必须拒绝版本混搭，不能仅在 UI 隐藏旧字段。

冻结 `Executor/TaskStateStore/SandboxManager` 方法全部保留。linked worktree 可由 adapter 实现旧六签名，但旧 `write/run` 必须经过已绑定的本机新端口；没有版本基线或调用 scope 时明确拒绝，不能制造“当前版本”让陈旧写入通过。direct 全程用新端口；旧方法不返回带假 branch 的 direct Worktree。旧 `integrate` 仅承载已登记 Git integration，普通目录通过文件版本交付能力收敛。

新增 MCP `workspace_read/workspace_apply/workspace_run` 是版本化工具集合；旧 `fs_write`/无基线 `git_apply`/`sandbox_run` 不注册到本机生产 worker，不能同时保留旁路。已有五类 MCP 包复用 transport、解析/错误结构和服务功能。`workspace_apply` 必须给 expectedVersion/readReceipt；快照不改变时可重用，文件一经改变必须重读。WorkerRuntime/角色白名单/投影/恢复、State 校验、TestResults、D16 和归档均需同步这个类型边界，而不改变 Harness loop。

## 6. 文件版本与受控写入

### 6.1 根和文件身份

首次打开固定 volume/device、inode、规范路径及父链身份。不同路径、大小写别名、symlink、嵌套项目、同一 Git common-dir 必须映射到同一冲突域；不能证明独立则拒绝并发写。首版候选只承诺本机 APFS 普通目录；网络盘、同步文件提供器和不支持所需原子操作的卷先明确不可执行，不能退化为普通 path 检查。此范围须随 §1 的方案一并确认。

文件 helper 继续从受信 fd 解析每层。用户源文件写入拒绝 symlink 路径分量、多硬链接、设备/socket/FIFO、权限异常以及根/父链替换；只读访问如需项目内 symlink，必须验证终点仍在准入根。依赖内部的 pnpm 链接单独按 task-owned store 绑定校验，不能为解决依赖链接而放开源码任意链接。

### 6.2 开始基线

启动写工作前记录 tracked、staged、unstaged、untracked 及明确纳入的 ignored 文件；用户 index 与 HEAD 保留原样。内容基线 B、Agent 改动 A、应用时用户当前内容 U 分开记录。敏感文件排除并在范围清单披露；基线不能悄悄漏掉需参与构建的文件。快照内容与备份不喂模型、不进 task-status/KB；仅给 fileRefs/差异和必要结构化事实。

基线记录普通文件 hash/字节数/可执行位、目录/路径集合、排除规则与工具/依赖配置指纹。拒绝未支持的元数据/文件类型写入；安全替换必须保留该文件应保留的 mode、ACL/xattr，无法保留则冲突提示，不把 inode 改变当内容损坏。文件时间戳只用于快速提示，不是版本证据。

### 6.3 单文件事务与竞争保证

1. 服务取得规范写域 claim，持久 prepared（actionId、输入 hash、expected、目标父身份、临时项/备份位置）；拿不到 writer 或文件已接管则不开始。
2. 从同一已打开文件取得版本并核验 expected；先将新内容写入同卷受保护临时文件、保存元数据并 flush。旧内容先保存可验证恢复副本。创建用 no-replace 语义；删除视为移入受保护隔离位置，不原地 unlink 用户内容。
3. 替换优先使用同卷 `renameatx_np(..., RENAME_SWAP)` 保留被替换的实际 inode；检查被移出的版本及实际目标，成功后才写 applied receipt。不是 `stat → writeFile`，也不把 rename 的原子性称为 compare-and-swap。卷不支持则拒绝；临时父目录不能由项目脚本写入。
4. 竞争发生后，不盲目用旧版本回滚覆盖新目标；保留 B、Agent 版本、实际被换出版本、当前路径和 journal，置 conflict/recovery_required，停止后续应用并让用户选择。打开旧 inode 的外部编辑器仍可能继续写该 inode，不能立刻删除被换出对象或只留一次 hash。
5. prepared 后崩溃，恢复先比较目标/临时/备份身份与 hash；只在唯一可证明结果下补记。用户文件已变或证据不全则停，不能重放破坏性写入。任何读到 incomplete journal 的工作都不继续。

整个目录在陌生进程任意 rename/reparent 下的完整安全性不能由路径前后检查证明。helper 的 syscall 组合必须在 12.3/12.5 做根/父目录置换竞争测试；不能证明授权根以外不受副作用时，相关 direct 写入不得启用，回到设计修订，不能仅通过“用户同意风险”放开既定越界保护。不能声称抵御同 UID 恶意进程控制 Agora 本身或持续破坏用户文件。

同卷事务暂存区由根登记时明确建立：用户根内保留受保护的 `.agora-operations` 技术目录，已存在同名目录则拒绝占用并要求选择另一空闲保留名；项目代码和模型文件工具均无读写权限。其位置/身份写入 registry，内容不进入构建/交付 manifest。应用状态可以在另一 APFS 卷，原子交换所需临时对象始终在目标同卷；最终证据复制至受保护对象库后核验 hash。不会把普通 `/tmp` 文件与用户外置卷直接 rename。只有无活 fd/引用且回执闭合的事务对象才可清理，已有用户目录不移动或重建。

多文件应用不是文件系统全局原子事务：先校验整批，逐项留证；中途失败返回 partial/冲突和已完成条目，禁止下游验证/交付。恢复仅对仍匹配自身写入的条目撤回，其他条目保全后人工处理。目录 rename 展开为可审阅的文件操作集合，不直接对含用户文件的整目录执行覆盖移动。

撤销是反向补丁，以原操作 B/A 和当前 U 三方比较；U≠A 时可安全合并才继续，否则冲突。禁止 `reset --hard`、`clean -fd`、自动 stash、覆盖用户 index 或整树恢复作为常规撤销。

### 6.4 真实验证版本

watcher 只标记可能失效。最终验证从**独立、固定的输入快照**运行，源码只读，测试/构建输出写独立根，记录输入 manifest、依赖锁/实际依赖树、工具链、命令/策略、真实退出结果和控制指纹。快照本身逐项 hash 并冻结，不能用“源目录前后 hash 相同”证明运行途中从未变化。

Git 路径继续绑定精确验证 HEAD，另记录 untracked/依赖/排除范围；修改源码的测试生成步骤必须先提交为新候选再重测。direct 以 `WorkspaceVersionV1.kind='files'` 绑定同一完整输入，不伪造 commit。普通开发目录运行的快速测试可展示结果，但没有固定输入证据时不能当最终可信 receipt。

受测快照与当前用户目录的映射必须在提交审阅、Leader批准和应用前各自复核。外部新修改使旧验证对“当前目录”的资格失效；保留旧实测事实，重新验证新版本。用户文件是否再次变化不能靠按钮点击时一次检查保证，实际应用仍走文件事务。D16 终审和 artifact 引用同一有效版本，公开报告区分“已验证快照”和“用户目录当前状态”。

## 7. Direct 与 Worktree

direct 根同一时刻只有一个编码工作写 claim；Tester 在验证快照工作、Reviewer 只读候选，不抢占 Coder 的 workspaceId。项目脚本无源码写能力；运行代码生成器时从固定基线建立执行副本，在隔离根内允许生成，结果作为 diff 候选回传，不能自动覆盖源码。

需要独立编码并行时先确认启用 Git（未初始化目录），记录用户所有未提交修改，不自动替用户提交。通过单独 index 和受信 plumbing 构造包含准入工作文件的私有 baseline commit/ref，用户原 HEAD/index 保持不变；保留 staged/unstaged 区别用于交付保护。基线引用与用户实际起点的映射不可丢失。Git filters、hooks、credential helpers、external diff/fsmonitor 与任意项目配置不能在受信 Git 进程中执行；受信 Git 使用明确配置和清理后的环境。需要的配置先解析白名单，用户配置文件保持原样。

所有工作区由同一受信 Git 管理者创建，实际 linked worktree 的 common-dir、规范 worktree list 唯一路径/branch/HEAD 与归属逐项匹配；项目代码不能写 `.git`/common-dir。用户仓库 refs/index 操作串行，遇外部 Git lock/HEAD 改变停止重读，不抢锁。已有 user linked-worktree 不被冒认成 Agora 创建。

独立工作从上一 accepted 验证 HEAD 开始；集成只在专用 integration worktree 进行，保留原 D17 wave/attempt/base、顺序 progress、冲突 abort 和精确 receipt。外部依赖/挂载不能绕过工作区隔离；不同 worker 的服务端口独立登记。

应用到用户目录使用 B（开始基线）、A（累计验收产物）、U（用户当前目录）的逐文件对照；仅同一受测候选可发起 delivery proposal。若合并产生 A 之外的新内容，形成新版本，重新测试/审阅/Leader终审，不能继续复用 A 的完成批准。用户确认后写入文件，默认不替用户提交、切分支或 push。保留用户 index；有 stage 冲突明确展示，不擅自解决。

direct→worktree 切换先停写并形成基线，持久新 workspace 绑定后再释放原 claim；失败保留原绑定并拒绝重复执行。worktree→direct 只通过确认应用；不直接更换路径掩盖身份。清理只针对已登记且停用的 Agora worktree/ref，不能回收用户项目根；失败保留可恢复证据。

## 8. 接管、撤回、进程及恢复

接管状态：`requested → draining → heldByLeader → returning → released`；中间失败为 `needsAttention`，不能跳到“可安全编辑”。控制记录包含 actionId、scope/path 集合、epoch、涉及的工作与读写集、旧/新版本和回执。

1. 接管 action 先持久化并关闭受影响范围新命令/写入 admission，固定受影响 cohort。不依赖随后模型“记得停”。
2. 请求 Harness 安全点，等待当前 token/工具 Step 自然闭合、canonical commit/flush/checkpoint；受影响文件写事务全部收尾。读写集不明确的命令按整个 workspace 处理，不能猜只碰某文件。
3. 已获宽写权限的活子进程不能靠修改 registry 缩权；要等其结束/按命令超时规则停止并证明无后代可写，再开新策略进程。长期预览先停止或证明其源码只读且不持有相关可写能力。工具超时停止工具进程不是硬杀 LLM 流。
4. 只有无在途写、相关命令收敛、held 回执已落盘才显示可安全编辑。独立 workspace 工作可继续；如果一个宽范围命令关联多个文件，UI 明确说明扩大暂停的实际范围。
5. 交还时重读实际文件集、生成新版本、使受影响验证和投影失效，重新计算依赖；单任务非阻塞重投影沿用既有语义，若经 humanGate 则按 D4 真 Fork/新 lease 恢复。不能把“交还”当作重新授予已撤销授权。

授权撤回先关闭新操作；在途按上述安全点/工具收敛结束，界面区分撤回请求和已生效，不声称立即中断 token。撤回后未获新授权不取执行 lease。正常退出/重启服务的完整用户协议归 13.2；本契约提供 quiesce/resume 证据，不提前实现全团队恢复。

命令 supervisor 持久登记 commandId、启动时间、进程身份、父子关系、授权/策略版本和输出根。默认 30s，到期停止工具及后代、收集真实结果，不能仅杀 shell 就宣称完成。`setsid`、double-fork、父进程先退出等必须纳入 12.3 G5；仅 PID/进程组不是永不逃逸的证明。无法证明子树收敛则保持 needsAttention、不释放可复用写根/端口、不回收文件，直到用户处理或有可信停止证据。恢复不能凭旧 PID 杀进程，必须核验出生身份避免 PID 复用。

## 9. 可观察失败

| 错误 | 行为与解除条件 |
| --- | --- |
| `grant_required` / `grant_revoked` / `grant_stale` | 不开始新副作用；显示范围差异，由 Leader 授权或重读 |
| `root_identity_changed` / `workspace_scope_mismatch` | 关闭该绑定，不自动跟随新路径；受信重新选择/登记 |
| `workspace_busy` / `file_taken_over` | 等待当前写者/交还；不绕过配额或另起同路径 writer |
| `file_version_conflict` / `delivery_stale` | 保留当前用户内容和候选，展示版本差异；重新读取/验证/确认 |
| `sandbox_unavailable` / `policy_denied` | 无权限提升重试；策略缺失不执行，命令内拒绝按真实失败留证 |
| `unsupported_workspace` / `unsupported_state_version` | 明确类型/卷/版本不支持；不填假 Git 数据、不迁移旧 Docker 任务 |
| `operation_conflict` / `recovery_required` | 同 ID 异输入、半事务或坏回执拒绝；只开放已验证恢复动作 |
| `command_timeout` / `process_not_quiescent` | 留真实退出/副作用不确定状态；后代未收敛不做成功回执或资源回收 |
| `preview_port_in_use` / `network_denied` | 可选择新的批准端口/网络范围；不杀用户服务、不放开所有网络 |

DTO 只含错误码、相对路径/操作 ID、可读原因和下一步；不透传包含命令参数/令牌的底层异常。必要原始日志保存在受保护任务证据中并按访问边界读取，D15 通用 Trace 仍只白名单投影。

## 10. 后续 G5 矩阵与分工

本表全为**待实装实测**，不是通过清单。现有回归在 Docker 退役前继续执行；13.3 按 12.1 的 V01–V12 替换 Docker 专属覆盖。本机用例必须实际走新生产端口和 OS 边界，不以 mock 或仅端口单元测试替代。

| ID | 真实场景与必要断言 | 责任任务 |
| --- | --- | --- |
| L01 | 非 Git 普通目录直接编辑；安装依赖、构建、测试；编辑器可见同一源文件；无假 branch/commit | 12.3 /12.6 |
| L02 | 文件与项目脚本尝试 `..`、绝对路径、符号/硬链接、根/父目录置换、特殊文件；未授权外部哨兵不可读写；策略拒绝可见 | 12.3 /12.5 |
| L03 | 项目脚本/孙进程尝试读模拟凭据根、环境、fd、Keychain/Mach/Unix socket；只用测试哨兵，拒绝无秘密输出 | 12.3 |
| L04 | build/test 直连网络及用户服务拒绝；批准依赖下载成功，跳转/私网/CONNECT 拒绝；不以禁网测试代替安装成功 | 12.3 /12.6 |
| L05 | 安装生命周期/生成脚本改源码、用户已有输出根、全局 cache 被拒绝；暂存改动按版本应用；受管 pnpm 链接真实可用 | 12.3 |
| L06 | 文件预期版本冲突、原子创建、替换中崩溃、父目录竞争；旧/用户版本保留，重复 action 无重复破坏；不支持卷拒绝 | 12.3 /12.5 |
| L07 | 多文件半完成、删除/撤销、编辑器打开旧 fd 持续写、watcher 丢失/事件合并；回执不假报原子成功，全部可观察版本可追溯 | 12.5 |
| L08 | staged/unstaged/untracked/纳入 ignored 原修改；启动、生成 baseline、应用和撤销不修改用户 index/HEAD 或丢内容 | 12.4 /12.5 |
| L09 | 路径别名、大小写、嵌套项目、同 common-dir 双开，规范写域只一份；独立 worktree 真并行，全局 lease cap 不变 | 12.4 |
| L10 | 两 Coder + 累计 integration + 独立 Tester + Reviewer；精确 HEAD/manifest、坏引用、过期批准拒绝、Leader终审 | 12.4 /12.7 |
| L11 | 外部修改发生在取快照、测试期间、批准后和应用瞬间；验证只绑定固定输入，当前目录变化使资格失效，新合并内容重验 | 12.4 /12.5 /13.1 |
| L12 | 接管请求时存在 token 流、在途文件写/工具/预览；等待状态准确，held 后受管理写者不能碰接管文件，独立工作继续 | 12.5 |
| L13 | 交还新增/删除/重命名文件，旧授权已撤销；重新读取、依赖/证据失效、D4新 Context/lease，不能借交还恢复授权 | 12.5 /13.2 |
| L14 | shell→孙进程、setsid/double-fork、超时、端口占用、停止失败、PID复用；无孤儿有权写根，不杀用户进程，失败不回收 | 12.3 /13.2 |
| L15 | 故意错误/缺失策略和不兼容 OS/工具版本；执行入口关闭，无裸跑/LocalTemp/Docker回退；最低及当前支持系统分别实测 | 12.3 /12.7 /13.4 |
| L16 | grant/claim/journal 与 TaskState 各提交点中断；重放幂等，异输入拒绝，双方闭合前不执行；新桌面状态升级连续 | 12.3 /13.2 |
| L17 | 用户目录应用三方冲突、外部 Git index/ref lock、恶意 hook/filter/credential helper；不执行配置回调、不抢锁、不自动提交/push | 12.4 /12.5 |
| L18 | 无 Docker 安装环境跑全链路、固定候选 DMG、授权/配置/证据升级、正常退出主动恢复、清理后重新构建可核验 | 13.3 /13.4 |

12.3 的首个小单元应先做 launcher/文件事务可行性验证，不接普通产品入口；L02/L03/L05/L06/L14/L15 任一关键保护不能成立则停止依赖实现，回到本契约修订。不得边带着已知保护缺口边批量实验。测试用目录必须在实际运行前明确批准；本设计接受不授权任意宿主路径执行。

测试按当前 Leader 配置使用 Go `deepseek-v4-flash`（需要真实模型的链路）；不增开 Benchmark、不静默换模型。每轮先留版本/来源/hash/日志，再确认进程/挂载停用、清理专用下载/构建/依赖副本，记录路径与空间变化。用户项目、正常依赖、共享缓存、产品状态和钥匙串不在清理范围。

## 11. 来源核验、验证与接受后的同步

外部资料读取日期：2026-09-15。只用于核验系统/工具机制；本草案权限策略是 Agora 的设计建议，不能由上游项目替 Leader 批准。

- 本机 Apple `man sandbox-exec`（March 9, 2017）和 SDK `sandbox.h`：确认弃用标记；系统为 Apple Silicon/macOS26.5。本轮没有执行 sandboxed 项目命令，没有获得隔离有效性的实测证据。
- [Apple App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox) 与 [entitlement/子进程继承](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html)：官方替代路线有进程/授权继承要求，不是普通 cwd 限制。
- [Apple 文件协调](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileCoordinators/FileCoordinators.html)：文件协调参与者合作；不能据此推断任意第三方进程都遵守 Agora 写域。
- 本机 Apple `man rename`：确认 `RENAME_SWAP/RENAME_EXCL` 及文件系统支持条件；这些原语不提供按内容 hash 的 CAS。本机新 SDK 出现的标志不自动视为 macOS15 可用。
- [Git 环境变量](https://git-scm.com/docs/git)、[Git 配置](https://git-scm.com/docs/git-config)、[read-tree](https://git-scm.com/docs/git-read-tree)：独立 index 和受控配置是构造基线的机制输入；具体所有 Git 命令组合尚待实测。
- [OpenAI Codex Seatbelt 实现](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs)：只核实当前上游采用 `/usr/bin/sandbox-exec`；这是可变分支观察，不是固定版本依赖或 Agora 的验证背书，不引入外部 Agent。

本轮检查范围：规格/实现接缝静态核对、上述来源阅读、文档本地链接、`task-status check`、Git diff 格式；无产品/测试/构建脚本变更，无 G5 和付费实验。开工不等于设计接受；任务保持 in_progress。

接受后通过 `agora-sync-docs` 按顺序更新：蓝图 §21 D18/§22.3.1/§22.7.5 → 详细设计 §12.2（完整正式契约）及 §12.1 引用 → 架构 §10/选型 §12/§14 → 计划 §18.2/§18.3 与索引/历史 → AGENTS.md 的 D18 阶段边界（如获批范围要求）。本报告届时保留审阅证据，正式约束只引用来源文档，不形成第二套当前规则。

本任务设计接受后可按非代码规则标 done 并级联；后续源码、测试、native helper、MCP/状态 schema 实装须经过各自代码门禁与人工 PR 合并。当前无 commit/push/发布授权。
<!-- END ACCEPTED DRAFT 12.2 -->

</details>
