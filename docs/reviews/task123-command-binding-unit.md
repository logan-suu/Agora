# 12.3 命令持续绑定与失效收尾

日期：2026-09-16。沿用Leader“继续”、原生有界清理、固定Seatbelt验收目录及Go固定模型测试授权；使用agora-retry-task恢复、agora-sync-docs同步。未改变部署路线或冻结接口，未新增依赖、提交或开放产品入口。

## 规格与实现

详设§12.2.2：“保存授权不是永久活 capability；每次调用核对当前 revision、文件身份、writer epoch 和 task/worker 绑定。”§12.2.6：“发现漂移后不得主动发起下一写入；检查后已经提交的OS操作可能完成，不靠再次检查伪称其未发生。”本单元只增加受信检查和已登记进程收尾，不声称即时撤销已打开fd。

### 不可刷新的内部绑定

`LocalCommandBinding`在受信登记时捕获：project/task/workspace/root/grant/worker身份、grantRevision/writerEpoch、policyVersion及授权/工具链/网络清单hash引用；命令ID、精确可执行路径、argv、策略和输出根形成调用摘要。根及全部父链保存路径/dev/inode/uid/mode；bootstrap、目标、控制helper和系统sandbox-exec保存父链、文件身份/尺寸/时间/模式及SHA-256。工具hash由同一只读fd分块读取，前后元数据和父链复核；拒绝链接工具、多硬链接、组/其他用户可写工具、无执行位、过大文件和输出域内工具。

对象内部保留独立快照，只返回深复制；启动时也复制调用选项和argv，防止受信异步调用者改变正在执行的参数。调用摘要不匹配拒绝，不能把同一活绑定转给另一个命令。当前授权由受信reader接缝重读，检查严格字段及稳定值；不是模型提交的声明，也不新建第二份授权真相源。任一检查失败后对象永久失效，恢复原值不会重新开放它。

启动的admission/spawn/register/release检查在既有授权回调前后执行；放行仍由内核身份约束的SIGCONT完成。监督循环每轮复核绑定，正常退出收尾后再次检查，再持久化观察结果。授权不可读或身份/版本变化为authority_changed；根/父链变化为root_changed；工具变化为tool_changed；当前内核release/架构变化为host_changed。这里绑定的是Node提供的内核release和架构，尚未替代正式OS build/隔离探测门禁。

持续检查使用工具元数据指纹，首次登记保存完整内容hash，不在每轮重复读取整个Node二进制。文件修改、替换、模式或硬链接计数变化使指纹失效；不是对管理员篡改或任意在途OS操作的原子撤销保证。同步文件系统I/O与受信reader也不构成硬实时25ms响应承诺。

### 停止能力也要复查

授权或项目根失效后，可信控制helper仍可用于停止原已登记成员；停止不依赖新授权放行。每次capture/inspect/discovery/signal调用前独立核对控制helper及父链。若helper本身变化，不执行变化后的文件，不回退kill(pid)、新helper或裸命令；返回unknown/needsAttention，保留隔离和阻断。

真实测试把helper替换为固定陷阱二进制：一旦误执行，只在其本身测试路径旁写标记。运行结果要求停止信号为空、状态needsAttention且标记不存在。之后由测试控制器使用预先保全的独立helper对固定fixture真实出生身份清理，并单独记录；这不是产品fallback或生产停止成功证明。

### 持久证据

内部`LocalCommandJournal`升为v3，增加可空binding快照；启动必须先将绑定落盘，再创建bootstrap。写根身份须与预留资源一致，workspace一致；观察摘要升为v2，保存bindingFailure。绑定失败即使主进程exit0也进入control_failure隔离；真实目标退出码/信号仍独立保留，不改写成进程执行失败或工具成功。

旧v1/v2或损坏记录拒绝读取，不自动迁移/清空/授予权限。重复父链、错误父链形状、坏授权字段、绑定与预留写根身份不一致均拒绝。仅旧内部发现/停止原语允许binding=null；新启动闸门必须有活绑定。没有新增正式registry文件，也没有把当前技术日志当Leader授权存储。正式工具结果、目标退出的持久回执、恢复及资源释放仍待companion接合。

## 测试与失败证据

TDD先因fixture缺失而红。首次类型检查通过；首次lint发现控制字符正则和表达式内赋值，改为逐字符检查及显式失效方法，无忽略规则。首轮绑定10项+既有启动8项真实测试全通过（12.27秒）。

随后补停止helper替换与坏持久记录两项。第一次Phase12累计为66通过/1失败（73.60秒）：旧格式已拒绝，重复父链被接受。该运行期间增加了重复父链唯一性检查和新用例，磁盘source hash不等于进程已加载模块版本，不能据此称当前源码已完成一致验收。按“旧模块缓存/校验遗漏/夹具写入不符”三假设复核，旧校验确实缺显式唯一性判断，当前判断与故障写入已检查；首轮失败原样保留，不仅靠更改磁盘代码宣称修复。

冻结14份源码后，12项绑定场景全部通过（8.06秒），原重复父链断言不变，停止helper陷阱无执行标记；typecheck和lint（517文件）通过。随后原始完整pnpm test退出0：7项脚本测试、198个Vitest文件/1407项测试全部通过、0skip，764.29秒；新增12项绑定测试在完整环境全通过，源码hash保持冻结版本。真实LRU236.684秒、Harness单回合70.077秒、群聊摘要15.294秒，均OpenCode Go deepseek-v4-flash；native构建通过。未换提供方、放宽期限/断言或恢复正式Benchmark。

fixture使用真实文件、Seatbelt、内核身份/信号和持久日志；授权reader是明确标注的固定受信JSON接缝，不冒充尚未完成的产品registry/G5。全量G4通过不抹去首轮失败，也不表示12.3完成。

覆盖：运行中grant revision/worker/writer epoch变化及授权文件损坏、放行前根替换、运行中祖先移动及替换域未改、启动前工具替换、失效后恢复原值仍拒绝、参数不匹配、正常进程退出后授权失效、运行中控制helper替换、旧日志及重复父链拒绝。macOS26.5 arm64真实执行；编译目标15.0不等于最低系统实测。

## 剩余工作

- 正式Leader授权registry及TaskState prepared/committed闭合、文件基线/完整输入清单、授权根来源、接管及writer冲突域；当前reader及hash引用还没有接入这些真相源。
- 工具链锁定清单与实际分发的关联、OS build及允许/拒绝探测、文件系统适用性与源码内部链接/硬链接清单准入。目录身份检查不替代这些门禁。
- 完整workspace/companion、持久目标退出及工具成功资格、D17额度/阻断范围和恢复；网络/IPC、实际项目依赖/服务场景及完整L01–L18。

所有资源继续隔离，不签发checked、源码安全接管或可回收证明。12.3仍in_progress，完整生产G5未完成。

## 留证与清理

每个fixture归档来源/二进制/策略hash、绑定/观察/失败及测试专用清理结果，再核验路径归属、句柄和挂载后清理。本轮没有用户项目、安装产物或测试下载；正常依赖/缓存/应用/产品数据不在清理范围。

[首次18项](task123-binding-evidence/binding-first.log)、[首次累计失败](task123-binding-evidence/phase12-regression.log)、[冻结后12项](task123-binding-evidence/binding-frozen.log)、[完整回归](task123-binding-evidence/full-regression.log)、[类型检查](task123-binding-evidence/typecheck-final.log)、[Lint](task123-binding-evidence/lint-final.log)、[源码快照](task123-binding-evidence/source-checkpoint.json)。

最终TEST-CLEANUP：162个单元fixture（其中绑定46个）逐份核验留证并删除；完整回归另删除152个确认停用目录，31个证据不足目录保留，APFS可用空间观察增加12455936字节（不是独占回收量保证）。临时清理控制器源码/hash留档后删除，未停止用户服务。77份本轮证据hash、14份源码快照与全部清理回执已核验；6组历史证据hash保持。

[最终证据汇总](task123-binding-evidence/summary.json)、[单元清理索引](task123-binding-evidence/unit-fixture-cleanup-index.json)、[完整回归清理](task123-binding-evidence/full-regression-cleanup.json)、[临时控制器清理](task123-binding-evidence/temporary-controller-cleanup.json)。
