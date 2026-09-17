# 12.3 可信父子关系发现单元

日期：2026-09-15。承接Leader“继续”，沿用已确认原生有界清理、专用fixture及固定Go测试授权。使用agora-retry-task/agora-do-task恢复及执行，agora-sync-docs同步检查点。

## 实现与理由

`local-process-control.c`新增内部`children`查询。受信控制器先核验已登记父进程的完整audit token，再用`sysctl(KERN_PROC_ALL)`快照筛选父PID相符的候选。每个候选的当前`KERN_PROC_PID`父子关系查询都被两次子进程audit token读取包围；同UID、PID、完整身份和当前父PID必须一致。所有查询结束后再次核验父身份，父身份变化/退出时丢弃本次新关系。项目输出只承担固定fixture的时序同步，不提供任何被信任的PID或成员关系。

全局快照只用于候选发现，不保存无关进程名称、参数或身份。快照最多16MiB；单父查询最多256条关系，溢出、结构长度不符、查询错误、候选竞态均明确不完整。对已经成功核验的子身份可以保留，但仍返回不确定状态。空快照不证明后代收敛。

TypeScript内部`discoverLocalProcessCohort`从调用者已证明属于命令的seed开始，有界遍历当前父子关系；总共最多256个身份、发现期限1秒、单helper调用最多250ms，剩余发现预算不足一次完整调用时停止并标记不完整。返回`assurance=bounded-observation`、`observationState=observed|needsAttention`及身份/关系，不返回cleanup checked。空seed、坏身份、重复seed拒绝；helper失败、已退出父进程、身份不匹配或期限/容量不足均保持needsAttention。身份拷贝后冻结，不按后来复用的PID重新绑定。

发现后已登记的子、孙身份即使随后失去原父关系仍保留，可由既有按audit token的停止原语核验和停止。发现前已被重新托管的后代、扫描间新生进程仍可能漏检；这是已批准有界发现的限制，不能宣称任意后代全部退出。身份因exec等变化而无法继续核验时保持不确定，不自行继承新身份。

## 接口与兼容性

SDK中的`libproc.h`自带接口可能变化的警告；SDK存在不等于永久稳定承诺。本轮没有新增`proc_listchildpids`等libproc枚举接口、私有结构或coalition能力，发现采用SDK声明的sysctl MIB。既有停止原语的libproc依赖不因此获得额外兼容性证明；仍须最低系统、签名应用及能力探测验证，错误关闭能力，无裸跑后备。

公开阅读来源：[Apple XNU sysctl定义](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/sysctl.h)、[Apple libproc头文件](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.h)。链接为阅读时main地址，不冒充固定源码版本；实际运行绑定本机SDK头文件hash、macOS版本与clang版本，见[SDK记录](task123-discovery-evidence/sdk-source-record.json)和各fixture。

## 真实验证

固定Seatbelt payload建立父→子→孙；子进程调用setsid离开原进程组，三个进程保持存活供内核关系观察。另启动同UID、同可执行文件的同级进程作为不应入组的正对照。测试覆盖：

- 精确发现三成员/两条关系，按身份停止，独立同级进程仍存活。
- 先发现，再让中间父进程退出并由根进程waitpid回收；孙进程仍活且由原登记身份停止。
- 错误父出生版本、缺失helper保持needsAttention且真实树仍活。
- 已停止父进程查询不返回observed；空/坏/重复seed在系统查询前拒绝。
- 实际发现身份写入LocalCommandJournal，重开后仍blocked；资源仍quarantined/discovery_incomplete，不因这次有限观察就放行。

TDD先因fixture缺失而红；首次typecheck发现fixture字段名births与既有birthIdentities不一致，纠正读取字段后通过。首次4项进程实测通过，再补输入和退出边界；修复前本地Phase12为6文件39项通过、25.80秒，typecheck/lint（508文件）/native构建通过。无mock、skip或弱化断言。运行宿主macOS26.5 arm64，clang最低目标15.0不代表已经在macOS15实测。

### 累计回归暴露的停止预算缺陷

首轮原始pnpm test为194文件通过/1文件失败、1378项通过/1项失败，641.05秒；唯一失败是既有ignore-term测试。其原始回执在1001.69ms返回unknown、只有TERM，进程最终SIGALRM退出，未执行KILL。该失败按原样保留，不能归为提供方故障或放宽断言。

排查先列三个假设：helper查询超时、退出复核失败、出生身份变化。代码发现TERM尾部仍用可能仅1ms的剩余窗口启动新helper；超时被记为未知身份，随后停止流程不再发KILL。最小复现的shell 180ms和初次native 200ms包装器在capture前就超时，native130ms第一次也在TERM初次调用失败，均未证明目标根因。将已知进程capture走原native helper、固定130ms延迟包装器先只读预运行后，真实内核查询复现TERM末端1003.15ms、signals=[TERM]、unknown，与原失败路径一致。首次启动延迟的具体OS原因未独立确认，不宣称已定位系统校验机制。

修复没有延长250ms helper/1s TERM/2s KILL限额：剩余阶段时间不足完整250ms时不启动新查询，让TERM阶段按原计划转到KILL；KILL阶段已无完整预算时留下未确认状态。发现遍历采用相同预算准入规则，不能把期限不足算observed。真实查询错误与身份不匹配仍保持needsAttention，未清空错误后强行判成功。

新增真实延迟包装器回归，内核查询和信号均仍由正式native helper执行；包装器只在受信fixture控制器中增加启动延迟，不作为G5替身。修复后完整Phase12为6文件40项通过、25.68秒，延迟测试2.301秒内完成包括编译/清理；typecheck/lint再次通过。定向诊断通过-t只选择复现用例，不能作全量结果；后续Phase12无筛选、无skip。修复后的原始pnpm test退出0：7项脚本测试、195个Vitest文件/1380项测试全部通过、0skip，559.43秒；LRU（137.636秒）、Harness单回合（22.503秒）、群聊摘要（4.971秒）全部为OpenCode Go deepseek-v4-flash。完整回归中的原ignore-term及新增延迟回归也通过，未改提供方/模型或恢复正式Benchmark。

首轮失败用例完成后曾新增回归测试，Vitest最终错误片段按磁盘新行号显示；具体失败身份以日志用例全名、原始JSON和旧源码检查点为准，不以该片段新行号定位旧执行代码。没有修改首轮断言或原始日志。

## 尚未完成

- 当前父子关系保存在发现回执和测试证据；资源日志持久化身份，尚未落正式版本化父子关系/完整发现与停止回执。
- 生产launcher握手及全生命周期连续发现、命令默认30秒/安全取消、收尾共同预算与完整结果闭合。
- 持续grant/源码根绑定、继承fd、正式受管工具链/签名兼容、网络/IPC及包管理器路径。
- 工作区/全实例阻断范围、D17 lease/admission与退出恢复、正式companion/registry/MCP和完整G5。

本单元不公开导出、不接web/desktop入口、不发布工具成功或资源释放回执。12.3保持in_progress，未commit/push/PR。

## TEST-CLEANUP

每次fixture在删除前保存源码/二进制/policy hash、OS/编译器版本、实际内核身份/关系和停止结果，再核对目录归属、句柄和挂载。八秒alarm只属于已知固定测试程序的失败清理后备，不作为任意项目进程已退出的证明。完整回归结束后按来源与停用证据清理，本节追加汇总。

首轮完整回归清理152个来源/身份/hash/无句柄/无挂载已证明目录，31个保留；APFS空间观察-3878912字节不当作精确回收量。清单见[首轮回归清理](task123-discovery-evidence/full-regression-cleanup.json)。修复后第二轮同样清理152个目录、31个保留，空间观察7389184字节；两轮累计删除304个回归目录、62个留待停用证据。详见[修复后清理](task123-discovery-evidence/full-regression-after-fix-cleanup.json)。另162个本轮原生/事务/日志fixture已逐份核验清理（其中发现20个），见[单元清理索引](task123-discovery-evidence/unit-fixture-cleanup-index.json)。用户项目、正常依赖、共享缓存、安装应用、产品数据及用户服务均未清理或停止。

最终证据：[首次完整回归失败](task123-discovery-evidence/full-regression.log)、[目标路径复现](task123-discovery-evidence/deadline-reproduction-warm-red.log)、[修复后Phase12](task123-discovery-evidence/phase12-after-deadline-fix.log)、[修复后完整回归](task123-discovery-evidence/full-regression-after-fix.log)、[最终源码快照](task123-discovery-evidence/source-checkpoint-final.json)、[类型检查](task123-discovery-evidence/typecheck-final.log)、[lint](task123-discovery-evidence/lint-final.log)。

收尾：67份证据文件和10份最终源码快照核验通过，旧45+23+44份历史hash保持；两个临时清理控制器副本已删除。汇总见[证据索引](task123-discovery-evidence/summary.json)。
