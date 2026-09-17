# 12.3 目标退出事实持久化

日期：2026-09-16。沿用Leader“继续”、固定Seatbelt验收目录及Go固定模型外发授权，使用agora-retry-task恢复、agora-sync-docs同步。冻结接口、产品入口与部署边界保持；未提交。

## 缺口与来源

上一检查点的bootstrap退出、输出摘要、停止与绑定失败已落盘，但目标程序的真实exit/signal只在`runHeldLocalCommand`的内存返回值中；重读日志不能重建这一事实。详设§12.2.3.3要求：“同一 terminal receipt 不覆盖历史事实，后续恢复用引用它的新事实。”§12.2.6要求：“main exit 0不等于工具成功”。

这两条合理且相容：目标退出是事实，授权/输入有效、收尾完整和工具成功资格是另外的判断。因此本轮补技术事实，不改授权设计，不签发checked或正式CommandReceipt。

## 实现

- 内部日志升级v4，新增可空`launchReceipt`，版本为1：已登记目标出生身份、是否放行、目标exit/signal、受限错误码。bootstrap结果仍在`observationReceipt.mainResult`，两者不混用。v1–v3拒绝，无自动迁移或清除隔离。
- 监督/有界停止结束并保持quarantined后，通过revision CAS追加一次启动结果。`recordLaunch`不能覆盖已有终态，不接受旧revision；revision耗尽拒绝，不回绕。重读从已有快照获取事实，不重新执行命令。
- 写入和读取都核对目标身份与已登记bootstrap父子关系、有活绑定的登记事实、released与结果的相容性；exit和signal严格互斥且有界。正常返回必须有目标结果及无绑定失败；撤权后实际exit0仍与`command_binding_invalidated`并存。模型不能提交此内部回执。
- 返回新增`launchDurable`明确区分最后事实是否成功落盘。锁/落盘失败保留实际内存结果，持久记录继续阻断，不以bootstrap成功或观察结果已落盘推断启动结果也已保存。原始异常文本不入新回执，仅存受限错误码，未知异常归command_start_failed。
- 两次持久写之间崩溃可能留下观察事实而缺少启动终态。缺项不是成功，也不重放项目进程；资源保持隔离，完整恢复协议待后续接合。

本记录没有完整产品receipt的actionId/TaskState canonical引用、固定输入清单及持久输出对象；只保存现有内部command绑定下的进程事实。输出仍为有界内存字节和持久摘要，未宣称正文可在重启后恢复。

## 验证

TDD原8项启动测试通过，新增3项失败（缺少持久字段/校验），原始红测保留。实现后启动+持续绑定23项真实测试通过（15.38秒）。随后补观察结果提交后、启动终态提交前的真实锁故障；最终24项通过（16.08秒）。测试控制器在受信completion检查的微任务中写固定lock，未替换journal方法或mock持久实现；运行返回后仅恢复该测试自己创建的锁。

覆盖真实非零退出7、信号30、放行前拒绝、登记失败、终态不可覆盖/旧revision、重建journal实例重读、重算封套hash仍拒绝目标身份篡改/未放行却有结果/exit与signal同时出现/旧v3、收尾撤权保持exit0事实、观察已落盘而最终事实被锁阻断。真实文件、Seatbelt、内核身份和原生bootstrap，无test double；固定授权reader仍是内部接缝，不代替正式产品授权。

类型检查、Lint（517文件）、native构建通过。初次Biome发现finally中的throw（已被本地catch包含），改成显式缺失分支，无规则忽略。冻结16份源码后原始完整pnpm test退出0：7项脚本测试、198个Vitest文件/1411项测试全绿，0skip，662.01秒。真实LRU178.173秒、Harness20.207秒、群聊摘要9.449秒，均Go deepseek-v4-flash的既有固定载荷；未放宽断言/期限、未切换模型或运行正式Benchmark。16份受测源码hash保持。

## 后续接合

正式registry与TaskState prepared/committed闭合、Leader入口、固定输入/工具链及OS探测、workspace端口/companion、D17、完整恢复和L01–L18仍未完成。12.3保持in_progress，内部回执不替代完整G5。当前macOS26.5 arm64证据不等于最低系统实测。

## 证据与清理

[红测](task123-result-evidence/tdd-red.log)、[首轮23项](task123-result-evidence/focused-first.log)、[最终24项](task123-result-evidence/focused-final.log)、[类型](task123-result-evidence/typecheck-final.log)、[Lint](task123-result-evidence/lint-final.log)、[原生构建](task123-result-evidence/native-build.log)、[源码快照](task123-result-evidence/source-checkpoint.json)、[完整回归](task123-result-evidence/full-regression.log)。

每个固定fixture沿用来源/二进制/策略hash与真实结果留档，核验路径归属、句柄、挂载后清理；本轮最终清理和hash索引随后补记。保留此前失败与各版本证据，不改历史summary。

最终TEST-CLEANUP：128个固定fixture（启动46、绑定36、其余46）逐份核验hash与删除结果；完整回归另152个确认停用目录删除、31个证据不足保留。APFS可用空间观察增加11829248字节，不作独占回收量保证。临时控制器源码/hash归档后删除，未停止用户服务或触碰用户项目、正常依赖/共享缓存、应用及产品数据。35份本轮汇总证据、16份源码快照及128项fixture索引校验通过；7组历史hash保持。

[最终汇总](task123-result-evidence/summary.json)、[fixture清理索引](task123-result-evidence/unit-fixture-cleanup-index.json)、[回归清理](task123-result-evidence/full-regression-cleanup.json)、[临时控制器清理](task123-result-evidence/temporary-controller-cleanup.json)。
