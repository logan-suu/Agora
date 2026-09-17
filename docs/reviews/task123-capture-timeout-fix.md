# 12.3 helper 冷启动与身份捕获超时修复

日期：2026-09-16。Leader明确要求“审查原因并修复”；沿用固定临时目录及Go固定测试外发授权。使用agora-retry-task恢复、agora-sync-docs同步；未提交或开放产品入口。

## 原因与证据

原失败发生于bootstrap发ready后、创建项目目标前：第一次control helper调用超时，尚未登记出生身份或调用release撤权检查。原始1477过/1失败、随后原文件12/12通过的记录保留于[上一轮报告](task123-workspace-identity-unit.md)，不能将那次单独重跑视为修复。

按三假设审查：宿主调度/首次加载迟缓、过早查询/进程身份竞态、workspace改动的间接影响。失败路径11份源码与此前通过版本一致，尚未调用workspace registry。新增真实故障探针后又捕获自然超时：`capture-error-lblbgP.json`第一次超时且没有查询入口记录，第二次才进入探针并返回固定非超时错误；不能把所有超时都归为内核身份查询失败。

独立诊断将实际native helper包在仅输出entered/returned时序标记的入口中，编译12个新二进制，每个执行3次（36次）；目标仅为诊断控制器自己的PID。首次153.4–229.2ms，后续1.5–3.6ms；不进行身份查询的invalid-command对照同样出现首次加载开销。诊断本轮没有超时，不能作为原失败的完整系统调用跟踪，也不证明特定OS组件（例如代码签名服务）有缺陷。

**确认的代码层原因：将helper首次程序加载与短时身份查询共用250ms单次执行超时，缺少独立的就绪阶段。** 冷启动成本已接近这个上限；仅重试还会反复终止尚未就绪的helper。真实冷启动用例`descriptors-V2Nnxu.json`曾连续3次超时，证明重试本身不足以解决问题。系统为何在原失败时更慢仍无法从旧日志回溯，本修复不声称消除所有宿主调度延迟。

## 最终修复

1. 在原5秒启动窗口内，先执行受信helper的`ready`，只接受`{schemaVersion:'local-control-ready-v1'}`。它不查询项目身份、不启动项目、不授予权限。初始化使用剩余窗口，返回后复核deadline及绑定；失败不创建bootstrap。原5秒窗口不刷新，后续identity/children/signal调用仍配置250ms上限。
2. bootstrap已经ready、尚未收到`s`时，首次身份捕获仅对明确ETIMEDOUT最多尝试3次，每次仍使用250ms并检查剩余预算。错误结果、非法身份、撤权、取消、工具漂移不重试，写入或信号不重试。内部诊断记录ready耗时及各capture尝试耗时/枚举结果，不把底层路径异常透传为DTO。
3. 每次返回后处理退出事件，再通过原私有控制端点发送`p`并等待新的ready响应。只等待一次事件循环不足以保证child.exitCode已更新，真实退出故障曾复现多查询一次PID；新增握手使token接受和重试均依赖同一私有端点仍存活。此时项目尚未创建，端点不会由项目子进程继承。握手共用原deadline，失败仍阻断。
4. 仍先登记内核身份/父子关系，再接监督和复核授权后SIGCONT。init或capture失败继续持久隔离，不签发checked、不沿用未证实PID发信号。冻结的公共端口与TaskState/registry权限边界未改变。

## 真实验证与中间失败

- 用实际native helper源码构建故障wrapper；成功身份来自原内核查询，无模拟成功结果。固定350ms延迟复现旧代码：新增7项失败、原12项通过。只读超时恢复加入后18/19通过，退出故障暴露child事件滞后，随后加私有通道存活确认。
- 新增精确错误/次数测试曾被“自然冷启动超时+人工350ms延迟”叠加干扰。临时只给故障探针预热，但原冷启动descriptor用例仍连续3次超时。该中间方案及日志保留，最终移除全部测试专用预热，改用上述生产ready路径；新增测试全部从新编译的helper开始。
- 新增12项：350ms初始化成功、初始化耗尽5秒失败、坏ready拒绝；瞬时capture恢复、持续3次超时阻断、恢复后撤权拒绝、非超时查询错误不重试、授权变化/helper替换/取消阻断、bootstrap退出拒绝、控制面检查耗尽启动窗口拒绝。
- 最终24项启动（原12+新增12）与12项绑定测试全通过，36项/43.86秒。原12项测试正文与此前冻结版本逐字一致，原20秒测试期限、250ms查询配置、5秒启动及既有停止/发现期限未放宽；准确次数与错误断言均保留。typecheck、lint（521文件）和native构建通过。
- 冻结17份源码后原始完整pnpm test退出0：7项脚本、200文件/1490项测试全部通过，0skip，900.75秒。本次24项启动在全量环境再次通过（30.13秒）；LRU406.313秒、Harness4.223秒、群聊摘要9.741秒均Go deepseek-v4-flash。原LRU600秒期限未改，没有运行正式Benchmark。冻结源码与实测版本一致。

## 证据

[旧代码红测](task123-capture-evidence/tdd-red.log)、[退出竞态](task123-capture-evidence/start-green.log)、[额外冷启动超时](task123-capture-evidence/start-binding-green.log)、[仅重试不足](task123-capture-evidence/start-binding-calibrated.log)、[独立冷启动诊断](task123-capture-evidence/cold-diagnostic.json)、[最终36项](task123-capture-evidence/readiness-green.log)、[原测试正文哈希](task123-capture-evidence/original-test-assertions.json)、[类型](task123-capture-evidence/typecheck-readiness.log)、[Lint](task123-capture-evidence/lint-readiness.log)、[源码冻结](task123-capture-evidence/source-checkpoint.json)、[完整回归](task123-capture-evidence/full-regression.log)。

12.3整体仍in_progress；本修复只解决已识别的启动处理缺口，完整生产授权、TaskState闭合、companion/D17和恢复等原剩余范围未扩大或完成。

## 清理与收尾

279个固定fixture（启动147个，含失败/修复和独立诊断）保存结果/来源/版本/hash后核验删除。完整回归另152个确认停用目录删除、31个证据不足保留；APFS可用空间观察+6754304字节，不作为独占回收量保证。诊断C wrapper与清理控制器均归档、核验后删除；无用户服务/项目、正常依赖/缓存、应用或产品数据清理。

[回归结果](task123-capture-evidence/regression-result.json)、[fixture清理索引](task123-capture-evidence/unit-fixture-cleanup-index.json)、[回归目录清理](task123-capture-evidence/full-regression-cleanup.json)、[控制器清理](task123-capture-evidence/temporary-controller-cleanup.json)、[最终汇总](task123-capture-evidence/summary.json)。本轮G3/G4及本修复的真实启动验证通过；12.3整体尚未完成，未commit/push/PR。
