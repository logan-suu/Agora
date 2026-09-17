# 12.3 本机 Agent 命令管理对照与公开接口复验

> 历史报告：保留架构/故障分析价值，不代表当前任务状态；文中已精简的旧相对证据路径从[固定历史提交](https://github.com/logan-suu/Agora/tree/05987ccbd20e6a55a553750577a900f44bc353d0/docs/reviews)按原路径读取。当前验收见[task123-acceptance.md](task123-acceptance.md)。

**[2026-09-15 后续确认]** Leader已确认原生有界清理及残余风险；本报告“未生效/待确认/强保证保持”为此前研究时点。当前以详细设计§12.2.6及蓝图D18为准，历史来源/探针不改写。

日期：2026-09-15（本机时区；原始日志为 UTC）。Leader在竞品对照建议后授权“按照你的建议继续”：暂缓 coalition 私有 SPI 接入，核对成熟方案，验证替代机制；保留无法确认后代退出时不复用工作区的保护。本次不是采用私有接口或降低保护的授权。

**续研说明**：Leader随后要求“多参考市面上的现成方案继续研究”。本轮扩展到pi、Goose、GitHub Actions、Jenkins、Bazel、Nix及OS级机制，结果见§六–九。当前任务继续研究，不再以“等待Leader选择降低保证”为下一步；§四仅保留历史草案，没有生效。

## 一、来源能支持什么

| 对象 | 可核实的机制或承诺 | 不能由此推出 |
| --- | --- | --- |
| [Codex Seatbelt](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs) / [进程组管理](https://github.com/openai/codex/blob/main/codex-rs/utils/pty/src/process_group.rs) | 本机 macOS 使用系统 sandbox-exec；所查 Unix 清理函数围绕进程组发信号，macOS 有按组成员补发的分支，注释明确为 best-effort | 不能由这些函数证明脱离进程组的任意后代都退出；也不能用单个文件概括产品全部路径 |
| [Claude Code 沙箱](https://code.claude.com/docs/en/sandboxing) / [后台任务](https://code.claude.com/docs/en/interactive-mode#background-bash-commands) | Seatbelt / bubblewrap 提供访问隔离；当前后台任务文档明确覆盖停止 setsid/timeout 等脱离 shell 的进程 | 没有查到对应完整生产清理实现及“零后代证明”的公开契约，不能推断其使用 coalition、环境变量或某一种内核机制 |
| [Anthropic sandbox-runtime CLI](https://github.com/anthropics/sandbox-runtime/blob/main/src/cli.ts) | 开源包包装沙箱命令；所查 CLI 的 SIGINT/SIGTERM 处理向 child 转发信号 | 开源隔离包不等于 Claude Code 完整 supervisor，不能拿它否定 Claude Code 文档承诺 |
| [Gemini CLI process-utils](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/process-utils.ts) | 所查 Unix 路径递归 pgrep -P 收集后代，再对进程组和收集到的 PID 发信号，可升级到 SIGKILL | 父链断开/扫描竞争/PID 重用不由该算法自动消除；注释中的所有后代目标不是内核级完整性证明 |
| [Cursor 本机模式](https://cursor.com/docs/agent/security/run-modes) / [云端模式](https://cursor.com/docs/cloud-agent) | 本机 macOS Seatbelt；云端使用隔离 VM | 云端环境生命周期不能直接移植为本机无 VM 的保证；文档不足以确认其全部清理细节 |

这些是阅读时的官方文档和 main 分支源码，不是已固定发行二进制的全面审计；本轮没有运行竞争产品、逆向闭源程序或把社区问题报告当当前实现事实。不新增第三方运行时依赖。

**合理性判断**：后代清理是成熟产品的真实需求，不能称为无意义的过度设计；但“尽力终止可识别进程”和“对不受信任程序证明全部退出、随后安全复用写根”应有不同证据等级。现有对照不能把 coalition 定为必选，也不能作为删除现有保护的依据。

## 二、公开审计查询候选：有界真实复验

### 假设与最小验证

1. SDK 公开的 `auditon(A_GETSINFO_ADDR)` 能查询已登记审计会话；会话消失或可作为不依赖进程枚举的信号。
2. 后代退出后，会话可能因其他引用暂时存在；因此“仍存在”不等同“仍有活进程”。
3. EINVAL 也可能源于 ABI/参数错误；因此“查询失败”不能直接签发 quiescent。

[XNU audit_syscalls.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/security/audit/audit_syscalls.c)显示该 GET 路径不要求 root，并对错误结构长度及查找失败都返回 EINVAL。[audit_session.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/security/audit/audit_session.c)分别维护进程数与引用数；[audit_sessionport.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/audit_sessionport.c)的发送权也持有引用。由此只能得出查询不是进程计数，不能推断本次会话保留的具体原因。SDK 声明 `auditon` 自 macOS 11.0 起弃用，不将它宣传为稳定、无兼容性风险的替代。

### 实测

复用已授权 fixture、临时用户级 launchd job 与固定 Seatbelt double-fork/setsid payload。只查询本轮登记会话和调用者自己的正对照；不修改系统审计设置，不安装管理员服务。

- [第一轮](task123-command-evidence/session-lookup-AVa3pC.json)：后代存活、按出生身份停止后、job bootout 后三次查询均成功；自身会话正对照成功；故意错误结构长度返回 EINVAL。
- [第二轮](task123-command-evidence/session-lookup-u9AUO2.json)：相同结果；bootout 后每隔 3 秒追加观察，共 9 秒，仍查到会话。没有将延长等待或“没有观察到进程”改写为通过。
- 编译保留 3 条弃用警告；仅诊断编译将该类警告从 Werror 降为可见 warning，未修改项目构建规则。所有其他编译警告仍按错误处理。
- 本轮结论为 **未证明可用**：没有得到可用于有界命令完成的正结果，不进入生产。没有证明该接口在所有版本上永远不可用，更没有证明所有公开 API 路线都不可能。

## 三、已接受的当前方向

1. 保留 Seatbelt 作为权限边界，清理机制与权限边界分开评估。
2. coalition 原探针作为历史候选保留，暂缓生产接入；不请求再次批准已暂停的候选。
3. 主进程退出、输出 EOF、进程组不存在、扫描为空、launchd job 不运行，均不单独证明全部后代退出。
4. 未形成有效收敛证据时，沿用 needsAttention、不复用/不回收写根和端口、不宣称可安全编辑。
5. 当前 launcher 可行性门禁仍未通过，依赖它的 registry/MCP/产品接入继续暂停。此前文件事务结果有效；本轮不重复无关付费回归，不把诊断结果算作任务完成。

## 四、历史契约取舍草案（未采用、未生效）

若产品首版优先采用成熟 Agent 常见的进程组/发现式清理，应明确接受以下契约变化，而不能把算法替换伪装成满足旧保证：

> 命令停止采用已登记身份、进程组及可发现后代的有界终止与复查。记录主进程结果、已处理成员、发现失败和残留；存在残留或检查错误时保持 needsAttention、关闭相关范围复用。无残留被观察到只表示“清理检查完成”，不保证主动脱离、快速衍生或隐藏的任意后代已全部退出。若允许据此继续使用工作区，必须明确接受漏检后后台进程仍可能写入其已获授权输出范围的风险，不再对该状态声称强保证的“可安全编辑”。沙箱越界、源码受信事务、凭据隔离要求不变。

这是对旧“证明收敛才允许复用”的实质降低，**当前授权不包含该变化，不能自动实装**。如果保留旧强保证，则继续冻结依赖入口；尚需找到并验证可靠的 OS 生命周期边界，不能承诺只靠公开进程组/扫描就能交付。私有 SPI、特权服务或 VM 均不在本轮新授权范围内。

## 五、归档与清理

本轮两套 fixture 均在日志留存后确认 job 卸载、路径身份、无句柄/挂载并删除。前轮保留的 UiqBqr 目录复核原 dev/inode/uid、二进制 hash、全部 waitpid 结果和无句柄/挂载后清理；独立回执见 [cleanup-retained-fixture.json](task123-command-evidence/cleanup-retained-fixture.json)，不修改旧 removed=false 事实。可用空间变化只是 APFS 观测，不当作精确回收字节。全部诊断源码版本、控制器对应关系与 hash 见 [summary.json](task123-command-evidence/summary.json)。其他回归中由用户虚拟化服务持有的 31 个目录不在本次清理范围。

## 六、扩大到 Agent、CI 和构建系统

本节源码按固定提交读取，具体commit、路径、SHA-256及定位行见[来源清单](task123-command-evidence/market-source-manifest.json)。只读公开源码，不安装或运行外部产品；不能把单条源码路径概括为整个产品的安全承诺。Goose最初路径404保留，随后通过同一commit目录定位真实文件。

| 对象 / 固定来源 | 所查实现 | Agora可借鉴及适用边界 |
| --- | --- | --- |
| [pi shell.ts](https://github.com/badlogic/pi-mono/blob/60e7e76bd7ea25cad1dd6f3f1ce0d18814a42759/packages/coding-agent/src/utils/shell.ts#L216) | Unix先向负PID对应的进程组发SIGKILL，失败再尝试单PID；Windows调用taskkill | 简单的进程组清理层；不能据函数名killProcessTree推定任意脱组后代都被覆盖 |
| [Goose shell.rs](https://github.com/aaif-goose/goose/blob/abb47465996cd1041c4dbb83decf3f27216d3007/crates/goose/src/agents/platform_extensions/developer/shell.rs#L557) | shell超时/取消调用child.start_kill并wait；输出收集另设期限及output_truncated。后台sleep测试在工具返回后另用KillOnDrop清理 | 借鉴“命令结果”和“输出是否收齐”分开。输出收集停止只证明不再等待管道，不能充当后代退出回执；此结论限该shell路径 |
| [GitHub Actions runner](https://github.com/actions/runner/blob/80bb1fb827fa44d489263061e71ef4adba7ad8cd/src/Runner.Worker/JobExtension.cs#L880) | 作业开始前记录已有进程并设置tracking环境变量；结束时扫描新进程、读取标记，匹配则Kill，读取失败记录后继续 | 标记可跨普通reparent帮助发现遗留成员，但环境由子程序控制、枚举有竞争，不是不可逃逸身份。这里只核查runner作业清理，不等于托管平台隔离层 |
| [Jenkins ProcessTree](https://github.com/jenkinsci/jenkins/blob/81dc9a3e13a3ec4c4f74bedb772e3382b8de0760/core/src/main/java/hudson/util/ProcessTree.java#L753) / [机制说明](https://wiki.jenkins-ci.org/JENKINS/ProcessTreeKiller.html) | Unix按继承环境匹配后递归清理；官方说明明确允许改变cookie让daemon保留 | 适合合作式作业清理；不能把可变cookie当不受信项目程序无法伪造/删除的归属证明 |
| [Bazel process-tools.cc](https://github.com/bazelbuild/bazel/blob/2d7ad551c15a7c3037aeffdc0d7843f6851fbe2b/src/main/tools/process-tools.cc#L87) / [沙箱分层](https://bazel.build/docs/sandboxing) | 所查通用KillEverything向进程组发送TERM/KILL；不同平台沙箱另有实现 | 可复用超时/信号升级思路，但通用清理函数不证明macOS后代完整性；不把Linux专属能力算到Darwin路径 |
| [Nix多用户模式](https://nix.dev/manual/nix/2.34/installation/multi-user) / [killUser实现](https://github.com/NixOS/nix/blob/6f0275142d206cfa291e8176451dc60e7e8cff93/src/libutil/unix/processes.cc#L172) | root管理的daemon及专用构建UID池；killUser切换目标UID后按用户清理进程，Darwin还存在专用系统调用分支 | 借鉴独立、受控身份域，而非父链推断。需要管理员安装/专用用户和相应部署审计；不能在Agora的真实登录UID上照搬，也不是当前无特权方案 |

**推论**：成熟项目常将权限隔离、命令返回、输出收集和遗留进程清理分成不同层。源码里叫“kill everything”不等于满足Agora的收敛契约。环境cookie可作辅助诊断；本轮不将其加入产品，以免扩大宿主进程环境读取范围。

## 七、OS级边界及新的Apple公开API

| 机制 | 官方能力 | 对当前12.3的判断 |
| --- | --- | --- |
| [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) | cgroup.kill覆盖子层级，并处理并发fork/迁移；cgroup.events的populated反映层级内是否仍有活进程 | 是值得参考的生命周期原语；仍须确保启动即准入、子程序不能提前迁出、服务不能代启动逃逸进程，并验证空域后才复用。当前macOS不提供该接口，本轮未做Linux实测 |
| [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | 默认CreateProcess后代加入job，支持整job终止和KILL_ON_JOB_CLOSE；可配置breakaway | Windows方案须禁止breakaway、受控准入并防止经外部服务代启动；官方指出WMI创建不自动加入。通知并非全部保证送达，不能只等一条通知判定收敛。本轮未做Windows实测 |
| [Apple container](https://github.com/apple/container) | Apple Silicon上以轻量Linux VM运行容器 | 可参考整个隔离环境销毁的生命周期；它不是macOS原生目录命令的直接替代，不能绕过现有无VM路线自行引入 |
| [GitHub hosted runner](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners) | 除单CPU runner特例外，作业采用新VM实例 | runner内部尽力清理和平台的作业隔离是两层，不能只抄前者却宣称得到后者的边界 |
| [Apple es_new_descendants_client](https://developer.apple.com/documentation/endpointsecurity/es_new_descendants_client%28_%3A_%3A%29) / [entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.endpoint-security.client) | 观察调用者及已有/未来后代；后代支持授权与通知事件；不要求root或TCC，但要求向Apple申请的Endpoint Security entitlement | 新的公开候选，不能再笼统说“ES都需要root”。官方DocC标注macOS27引入；当前26.5 SDK无声明、运行库无符号，尚无授权或实测。不是当前最低macOS15/ad-hoc交付方案 |

Apple官方DocC来源hash、版本元数据、本机SDK头文件hash与运行库符号查询见[只读核验](task123-command-evidence/apple-descendants-api-review.json)。搜索渲染页出现Beta提示，实时DocC的beta字段为false；两者存在展示差异，不据此断言正式发布状态。**明确可用性事实是introducedAt=27.0、当前宿主26.5不存在符号**，没有安装新SDK、申请权限或调用监控API。

即使后续取得ES准入，也还需验证事件丢失/序号缺口、注册与启动顺序、短命双重fork、退出事件闭合、客户端崩溃后的恢复、外部服务代启动，以及最终无法再产生副作用的判定。观察整棵后代树这一能力不等于已经完成强制停止和零后代证明。该路线优先级高于继续猜私有计数，但属于未来平台候选，当前不改变最低版本或签名要求。

## 八、launchd卸载补测：成功bootout仍不代表全部退出

前轮检查了主进程结束后的job状态；本轮补齐“后代仍活着时直接卸载job”的独立对照。

- 原批准临时fixture内启动随机命名的用户域job，显式AbandonProcessGroup=false；固定payload始终在Seatbelt内，执行double-fork/setsid/setpgid，主进程先退出。
- 卸载前从OS读取孙进程audit token；bootout成功且再次查询job显示不存在后，**同一PID、ASID和pidVersion的孙进程仍存活**。因此不是PID复用造成的假阳性。
- 原始记录[launchd-bootout-9XEfTa.json](task123-command-evidence/launchd-bootout-9XEfTa.json)，源码及控制器hash一并保存；只证明当前macOS26.5/build25F71、该job配置及payload的结果，不推广为所有版本/config均相同。
- 随后按已登记出生身份停止，等待固定自退出保险期限；确认job不存在、路径uid/dev/inode、无句柄/挂载后删除fixture及编译副本。cleanup.removed=true；没有停止用户服务。此前两轮审计查询及旧失败证据保持不变。

## 九、针对Agora的研究结论与下一步

**本轮尚未找到能在“macOS15+、普通用户、现有签名条件、无VM、任意不受信命令”全部约束下直接采用、并已验证完整收敛的现成方案。** 这是当前证据范围的结论，不是宣称不存在任何公开机制。

1. **立即借鉴的设计原则**：独立记录主进程状态、输出收集、清理尝试、残留/不确定性和可复用证据；取消/超时应有期限，输出管道不无限拖住UI。不新增另一套Agent loop，不改变冻结SandboxManager接口；这些原则不解锁生产入口。
2. **不再重复验证的方向**：单纯换递归扫描库、添加环境cookie、等待更久或只卸载launchd job，都没有填补已发现的证明缺口。当前不因竞品“也这样做”而降低保护。
3. **值得继续的设计研究**：以Nix的独立身份域、cgroup/Job的内核归属和VM生命周期为参照，明确每条可落地路线需要改变哪些部署条件；Apple descendants API作为未来macOS候选单独追踪。下一轮优先收敛这些路线的成本/兼容性，不再只堆叠PID发现算法。
4. **仍需区分的产品取舍**：引入专用构建用户/特权服务、提高系统/签名门槛、使用VM，或放宽全部后代收敛保证，都会改变已接受契约。本轮只比较，不自动选择；Leader已要求继续研究，无需再次重复上一轮二选一问题。

已按来源层级同步研究状态，强保证、Seatbelt边界和未知不复用保持。12.3继续in_progress，launcher可行性仍未通过，registry/MCP/产品执行入口暂停。未改产品代码、未重复付费回归、未提交或推送；新增探针只是诊断，不能算完整G5。


## 十、部署路线细化

Leader继续研究后，已完成Nix专用UID池/降权/停止调用链及Tart/VZ停止完成条件的固定源码复核。具体比较、推荐理由、尚未生效的原生契约和分步验收见[部署路线与原生方案草案](task123-native-execution-options.md)。该草案明确保留残留资源风险，不把有界清理说成全部后代退出；尚未修改现行保护或进入代码。
