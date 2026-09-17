# 12.3 命令后代收敛：规格评审与机制 Spike

日期：2026-09-15（原始运行时间以 JSON 中 UTC 为准）。范围：macOS 26.5 / 25F71、arm64；固定受信控制器与专用测试探针。未实现产品 supervisor，未开放普通项目入口。

> **后续结论（2026-09-15）**：下文保留首次候选评审与实测事实。Leader随后同意先核对成熟Agent、暂缓coalition私有SPI接入；当前结论与新增公开接口复验见[命令监督对照](task123-agent-supervision-comparison.md)。下文“建议接受”不表示当前已接受或仍在请求批准。

## 结论与待决项

“父进程退出不代表后代退出”的规格合理，应保留。只按 PID、父链或进程组清理不能满足它。本轮排除了两条不成立的简化路线，找到一个有实测支持的新候选：**每命令临时用户级 launchd job + 独立审计会话 + Darwin resource coalition 内核计数 + 按 audit token 停止进程**。

候选需要新增对 **macOS 私有 coalition SPI** 的依赖。它不在此前已接受的 Seatbelt 弃用风险之内，不能把一次探针成功写成已批准的生产选型。需 Leader 决定是否接受这项额外兼容性风险后，才把候选写入正式契约并实现。当前仅保存评审与实测事实；既有文件事务继续保留，依赖命令收敛的产品接入暂停。

## 控制规格原文

详细设计§12.2.6：

> 命令 supervisor 持久登记 commandId、启动时间、进程身份、父子关系、授权/策略版本和输出根。默认 30s，到期停止工具及后代、收集真实结果，不能仅杀 shell 就宣称完成。`setsid`、double-fork、父进程先退出等必须纳入 12.3 G5；仅 PID/进程组不是永不逃逸的证明。无法证明子树收敛则保持 needsAttention、不释放可复用写根/端口、不回收文件，直到用户处理或有可信停止证据。恢复不能凭旧 PID 杀进程，必须核验出生身份避免 PID 复用。

详细设计§12.2.2.3：

> 启动时绑定 OS build、架构、受管工具链和策略版本；真实探测隔离允许/拒绝行为。升级 OS/工具链/策略后重做探测。失败显示 `sandbox_unavailable`，保留项目可浏览状态并停止执行；不回退 LocalTemp、裸 shell 或 Docker。

本轮没有发现应当删除后代收敛要求的产品理由；不能为了让简单 launcher 通过测试而降低要求。

## 已排除的路线与真实结果

| 路线 | 证据 | 结论 |
| --- | --- | --- |
| kqueue 自动递归追踪 | 本机 SDK `sys/event.h` 明确 NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD 自 10.5 起不再支持；NOTE_FORK 不提供可直接用于递归跟踪的 child PID | 不以该能力设计 supervisor |
| 只禁止 setsid/setpgid 系统调用 | [10场景原始记录](task123-command-evidence/process-group-UiqBqr.json)：直接调用被拒绝，但 posix_spawn 的 SETSID/SETPGROUP 选项仍成功脱离组 | 不足以封闭进程组；没有宣称 Seatbelt 文件/网络边界被绕过 |
| 一并禁止 posix_spawn | [原生记录](task123-command-evidence/process-group-1mRIFc.json)证明可拒绝；[受管 Node 记录](task123-command-evidence/node-spawn-SKGXqE.json)中 EPERM 导致子进程启动失败，ENOSYS 导致 libuv SIGABRT | 不能作为现有 Node 工具链的透明兼容方案，不修改锁定工具链绕过 |
| 普通 SessionCreate 调用 | [记录](task123-command-evidence/security-session-aOPSG8.json)：返回 100001，ASID 未改变 | 本机该调用未建立独立会话；不推断所有系统上的根因 |
| 只扫描 PID 得到空集合 | 已读 XNU `proc_listpids` 实现存在预分配与扫描的竞争，不能仅由用户缓冲区未满推断内部未截断；无法读取的身份也不能忽略 | 仅可用作发现候选，不能独立签发 quiescent |

Node 来源为已安装 Agora 的受管 `node/bin/node`，版本 v24.20.0 / libuv 1.52.1；二进制 SHA-256 与该安装的 manifest 一致，未修改安装文件。首次正对照 `/bin/sh` 因系统选择器路径未获准失败；随后一次修正出现字符串转义错误；两次失败均保留。最终 [Node→Node 正对照](task123-command-evidence/node-spawn-pbB3vt.json)真实启动、输出 `child-ok` 并退出 0，不能把此前失败隐去。

## 新候选的实测支持与局限

1. 临时 user-domain job 使用 `SessionCreate=true`，创建独立审计会话；[外部查询](task123-command-evidence/launchd-session-NxjwWY.json)取得同一 ASID 与 pidVersion。普通权限可完成，没有 sudo、管理员服务或登录项安装。
2. 固定 payload 始终在 deny-default Seatbelt 内执行。double-fork、setsid、setpgid 后，孙进程被重新托管给 PID 1、处于不同进程组，但仍保留本次 ASID。launchd 已显示主 job `not running` 时，孙进程仍存活。因此 launchd 的普通退出状态同样不是收敛证明。
3. [停止实测](task123-command-evidence/audit-cohort-pOKOq3.json)：改错 pidVersion 的 token 返回 ESRCH，目标仍存活；从 OS 读取的真实 token 可停止目标。探针同时绑定本次 ASID、uid 和 pid，未对用户其他进程发信号。
4. 首次扫描有两个无法读取 token 的系统进程；没有当作“零后代”。后续用 OS 单调出生时间证实其早于本次 job 准入，仅排除这些不可能由本命令新生的对象。新生或无法证明身份的对象仍属于不确定。该排除不能解决枚举截断问题。
5. [内核计数实测](task123-command-evidence/audit-cohort-bLCYaU.json)：父/中间/孙进程具有相同 resource coalition；父进程退出后计数 `started=6/exited=5`，停止孙进程后变为 `6/6`。外部只读 SPI 可取得该计数，不依赖扫描集合是否为空。
6. 最新探针通过 `/usr/bin/env -i` 重建环境，避免 launchd 继承环境进入 payload。早期 `launchctl print` 保存了本 job 的系统环境描述（含 SSH_AUTH_SOCK 路径，无凭据内容）；后续控制器只保留 job 状态行，不再保存整段环境。未访问该 socket。

**仍未证明**：最低系统/其他 OS build、完整后代继承不变式、跨会话/coalition 迁移拒绝、可信 job 身份登记与防伪、启动前 durable prepared、稳定锚点与重启恢复、丢回执、超时与持续 fork、进程执行中失去可观察性、IPC/网络/凭据隔离、pnpm 安装与脚本、完整产品端口。当前扫描计数的正结果不是上述项目的替代证据。

## 建议接受的后续方案范围

- 保留 Seatbelt 作为文件、网络、IPC 强制边界；审计会话/coalition 仅用于命令归属与生命周期，不冒充访问隔离。
- 每命令一次性用户级 job，不写 LaunchAgents 自启目录、不安装管理员服务。受信 launcher 在运行任何项目字节前清理环境/fd、安装策略并登记本次 OS 身份。job 重放与不明身份失败关闭。
- 采用已固定 OS/ABI 的只读 coalition SPI。普通进程扫描负责发现，audit token 负责避免 PID 复用误杀；最终收敛还需已登记且不再启动新代码的 job/锚点与内核计数相符。计数失败、归属变化、未解释差异都保留 needsAttention。
- OS/工具链升级重做真实正反探测；SPI 缺失、布局或语义不符即停止命令执行。不得悄悄只剩 PID 扫描，也不回退裸跑/LocalTemp/Docker。
- 先完成上述危险边界的固定 fixture 与受管 Node/pnpm 实测，再接 registry/MCP/产品入口；当前探针不能直接拷贝为生产 supervisor。

若 Leader 不接受新增私有 SPI，保留已有产出，继续研究其他边界；不声称已证明所有公开 API 路线都不可行，也不自行启用被现有契约排除的 VM/特权服务。

## 一手依据

- 本机 Apple `launchd.plist(5)`：SessionCreate 与 AbandonProcessGroup 条目；[Apple SessionCreate 文档](https://developer.apple.com/documentation/security/sessioncreate(_:_:))说明会话继承与调用范围。
- [XNU kern_exec.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)：spawn 属性在内核执行 session/group 修改，解释直接 syscall 过滤不足。
- [Node v24.20.0 的 libuv process.c](https://github.com/nodejs/node/blob/v24.20.0/deps/uv/src/unix/process.c)：spawn 系统调用返回 ENOSYS 的断言与支持的 fallback 边界。
- [XNU proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)：PID 列表的预分配/锁内扫描及 audit-token 信号入口。该源码审查提示潜在漏项，未进行 fork bomb 实测。
- [XNU coalition.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)、[sys_coalition.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c)、[私有身份声明](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h)：归属、计数、读取接缝及其私有性质。上游 main 仅作实现分析，不能冒充本机二进制对应提交。

## 验证与清理

每轮记录控制器/原生源码/binary hash、OS、真实 stdout/stderr、编译与 job 状态。变更前源码副本保留；汇总与完整性检查见 [summary.json](task123-command-evidence/summary.json)。固定探针自带短时退出保护；不会以此替代生产命令的收敛协议。

先留证，再核对 job 已 bootout、路径 uid/dev/inode/realpath、无句柄和挂载，最后删除测试专用目录。本轮不下载依赖、不改已安装应用、用户项目或系统服务。初次控制器因 lsof 自身 cwd 命中而保留目录，后续单独复核清理；空间变化仅为 APFS 可用空间观测，不作为精确释放量。

本轮为机制评审/固定 Spike；没有改变生产命令入口。此前文件事务全量回归结果仍归属其源码版本，不把本次诊断数量或单机候选结果写成任务 G5/阶段验收通过。
