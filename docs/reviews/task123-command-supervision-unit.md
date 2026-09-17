# 12.3 持久父子关系与内部命令监督单元

开始日期：2026-09-15。承接Leader“继续”，使用agora-retry-task/agora-do-task恢复既有12.3检查点，沿用获批原生有界清理、固定Seatbelt夹具和Go固定测试外发范围；agora-sync-docs同步实现事实。

## 实现

### 持久关系与观察回执

`LocalCommandJournal`内部格式升为v2，保留原出生身份列表，新增`birthRelations`和可空`observationReceipt`。新增关系要求父身份已经在同一命令登记，子身份在全部命令中未使用；父身份在登记序列中先于子身份，一个子身份只能有一个首次观察父关系。身份与该关系同一原子文件事务落盘，revision CAS拒绝过期写入。读取时复核关系引用、顺序、重复身份和跨记录唯一性，循环/坏关系不能靠重算外层hash通过。

v1或坏记录拒绝读取，保持阻断，不迁移、清空、释放或重新授权。版本变化只针对尚未接产品入口的内部文件格式；冻结SandboxManager方法不变，历史证据不改写。

完成观察时，单次事务保存结束原因、执行/进程输出收尾时长、发现次数/失败标记、主进程结果、输出字节数/hash/截断和错误、按身份停止结果。stdout/stderr内容不复制进1MiB日志，只记录摘要；观察回执本身为v1。所有这种记录都进入quarantined，正常观察也保留discovery_incomplete，因为完整授权/根/源码版本及正式清理回执尚未接入。没有checked、释放资源或工具成功能力。

### 内部监督器

`superviseLocalCommand`只接收可信launcher已经创建的本进程ChildProcess对象、对应登记身份、当前command/revision及单调时钟启动时间，不接受只凭重启日志PID恢复。入口要求该命令reserved且只有已登记主身份。它不负责创建/授权进程，不公开导出，不接web/desktop/MCP入口。固定夹具在控制管道收到启动字符前保持等待，因此先接管输出观察再释放测试载荷；生产launcher对应的受信出生/启动握手仍待实现，不能把已运行任意命令后附加观察当完整捕获。

运行时循环检查取消/主退出/期限，按当前内核身份检查仍活成员，再有界发现后代；每轮间隔至少200ms，每次发现及身份复核共给1秒预算，不在执行期限末端强塞新扫描。关系先核验并落盘，再进入后续登记cohort；落盘失败关闭后续观察，仍尝试停止本轮已核验的内存身份，保留磁盘reserved/隔离状态。总身份上限256；满载不扩张停止cohort，标记不完整并隔离。已核验退出的身份保留在日志，但不把它再次作为活父进程扫描种子；扫描期间消失/变化或查询失败仍保守拒绝，不把漏检风险抹掉。

每轮发现前重读日志，revision变化、被控制面隔离、坏记录或遗留锁都停止依赖观察。默认执行30秒，内部参数只允许1–30000ms；实际启动时点由受信调用者传入。主退出、超时、取消或观察失败均进入收尾，最后一次发现和已登记进程停止共享额外5秒截止点；沿用TERM1秒/KILL复核2秒及完整250ms查询预算。同步的最终日志fsync是独立落盘步骤，`cleanupMs`记录进程/输出收尾，不以此声称最终生产companion整体时限已验。

输出收集增加内部停止观察信号。当出生身份不符、停止失败或剩余收尾期限耗尽，关闭本方读端并标记truncated；主进程未被观测退出时返回`command_observation_incomplete`，不虚构退出码，也不无限等EOF。未知身份不发信号；回执落盘失败返回durable=false，不能将进程停止与持久闭合混为一谈。

## 验证与失败记录

TDD先因fixture尚不存在而红。首次格式检查发现新增关系校验函数缺结束括号，修正后typecheck及lint通过，没有靠格式忽略或降级断言通过。

固定Seatbelt程序建立root→child→grandchild，子进程setsid，时序控制管道只发送字符而不提供成员PID。首5项真实测试通过：主进程正常退出后停止后代、默认30秒超时、取消、错误出生身份拒绝且主进程仍活、有向关系与旧格式/损坏记录拒绝。随后加入最终回执持久化失败场景，Phase12为7文件46项通过、61.73秒；固定锁只由测试私有控制器注入，观察结束后只恢复该固定故障，生产无删锁旁路。

代码复核补运行中的日志revision/隔离状态检查，新增控制面已隔离时停止执行观察的真实用例。最终单元7项全通过、35.73秒，typecheck/lint（511文件）通过；原始pnpm test在2026-09-16退出0：7项脚本测试、196文件/1387项Vitest测试全部通过、0skip，566.90秒。真实LRU97.627秒、Harness单回合21.070秒、群聊摘要3.815秒，均为OpenCode Go deepseek-v4-flash；无提供方切换、额外Benchmark或测试期限/断言弱化。新增7项监督测试在完整环境也全通过。默认30秒使用真实时间与真实进程，不用假时钟；外部故障注入不替代内核查询/信号。编译目标macOS15不代表最低系统已实测，当前仍为macOS26.5 arm64。

## 剩余边界

- 可信生产launcher的出生握手、可执行文件/工具链身份、持续grant/源根版本、继承fd及环境/网络/IPC边界。
- 正式companion中mainResult/outputState/cleanupState/resourceState的完整证据闭合、产物固定复制和源码接管资格；本单元仅内部观察，始终隔离。
- 将阻断范围、D17 lease/composition admission、正常退出及主动恢复接入运行时；同步观察调用和最终存储I/O仍需结合生产调度验证。
- 多种真实项目命令、快速短命后代/exec竞态、高容量边界、最低系统与签名应用、完整L01–L18及生产G5。

任务保持in_progress，未commit/push/PR。已完成的内部单元不替代12.3或Phase12出口验收。

## TEST-CLEANUP

每个固定fixture记录OS/编译器、源码/二进制/策略hash、实际身份/关系/回执，核验路径归属、无句柄/无挂载后删除。40秒自退出alarm只用于本固定源码的失败清理后备，不用于证明任意项目后代收敛。完整回归清理与最终证据索引在结束后追加。

最终验证：[完整回归](task123-supervision-evidence/full-regression.log)、[最终监督单元](task123-supervision-evidence/supervision-final.log)、[Phase12检查点](task123-supervision-evidence/phase12-regression.log)、[类型检查](task123-supervision-evidence/typecheck-final.log)、[lint](task123-supervision-evidence/lint-final.log)、[native构建](task123-supervision-evidence/native-build.log)、[源码快照](task123-supervision-evidence/source-checkpoint.json)。

2026-09-16清理完成：本轮103个单元fixture（监督25个）全部留证并删除；完整回归另删除152个来源/身份/内容hash/无句柄/无挂载确认目录，31个停用证据不足目录保留。APFS空间观察+8642560字节，不当作精确回收量。未停止用户服务或删除用户项目、正常依赖、共享缓存、安装应用及产品数据；临时清理控制器留档后删除。见[单元清理索引](task123-supervision-evidence/unit-fixture-cleanup-index.json)、[回归清理](task123-supervision-evidence/full-regression-cleanup.json)、[证据汇总](task123-supervision-evidence/summary.json)。
