# Task 9.5 真实模型失败审查与修复

2026-09-08，Leader明确要求审查修复真实模型失败项。本文是追加记录，原九次结果保留在 `phase9-baseline-summary.json`，不替换失败、不混算不同配置的成功率或时延。

## 审查结论

1. 原八次PM均收到provider的`max-tokens`结束原因；七次没有正文，一次正文截断。8192总输出窗口无法稳定同时容纳high推理和最终JSON。修复为32768，保持同一Flash/high路由，manifest、实际请求及最高费率费用预留同源。
2. 原ARCHITECT以`stop`正常结束，但多层模块对象未闭合，严格JSON解析拒绝正确。第一轮诊断仅增加窗口及一般指引后，PM恢复但ARCHITECT再次缺括号；因此补充完整可解析的双顶层键示例，要求模块使用小型扁平对象数组、引用需求ID而不重复全文验收，明确conventions与architecture同级。没有自动补括号、放宽schema或替模型填写计划。
3. 原meter缺少结束原因，故失败诊断只能回查session。新增finishReason/outputTruncated/sessionId，只记录统计与身份，不新增产品Trace或暴露推理文本。
4. 原model入口的通过只表示九份final结果已写完，易被误解为模型成功。修复为先保存全部计划attempt，再对失败Outcome返回非零退出。阶段出口仍不新增事后成功率/加速比门槛。
5. Eval原先要求每条历史验证均通过、波次历史恰好两条，与允许返工并统计返工次数的规格冲突。应保留历史失败，以最终accepted回执、固定DAG及独立归档验收判定完成；已修复，缺失/失败/过期accepted回执、拆分首波、未知/重复assignment及缺少依赖后继重跑均拒绝。

原组官方session通过`sessionPersistence.inspect`展开完整事件后重新审计：10 sessions、76883事件、12584331字节，Gitleaks 0项，未含开发Key。不能将Node一次`zstdDecompressSync`返回的首帧header当成完整多帧session证据。

6. 完整回归另外复现两项Git清理测试失败：仍查找旧staging布局。实现按规格使用独立回收slot，故修正测试到本次新slot，核对准确目录、保留内容和inode；不依赖可能存在的历史目录。原样单独复跑亦失败，修正后Git26/26通过。

## 验证与预算

- 新诊断使用`pnpm run eval:phase9:verify-model`，cap3，与公开五模块DAG及真实HTTP/Harness/Git/Docker链相同。诊断费用累计上限USD2，重跑时读取全部既存诊断的final费用后再预留；未完成/unknown拒绝继续。
- 第一次命令在Docker连接阶段失败，没有创建model attempt或发起API请求；恢复已有Docker Desktop后继续。
- 诊断1：`phase9-wide-pipeline-model-a1-80887f1a-883e-4700-bc93-8fb4ad98b5b1`，PM通过，ARCHITECT未闭合JSON；4请求、6工具，USD0.011451272，失败保留。
- 诊断2：`phase9-wide-pipeline-model-a1-d834bd17-eb89-44a1-b699-ebb03c4d4f4b`，使用完整结构示例，通过：58请求，USD0.085542492；实际首波18项、累计26项、D16终审后fresh Docker独立9项通过，约356.7秒。此诊断独立留档，不计入九次对照。
- 诊断完成后才冻结新九次对照，cap顺序仍为1/2/3、2/3/1、3/1/2，组预算USD7.94，其他attempt限额沿用原值。旧组USD0.056531336加两个新阶段的上限2+7.94，小于Leader原批准的USD10。既有必跑回归费用仍单独报告。

本轮不commit/push/发布Issue，不推进Phase10；后续格式恢复的验证与旧对照分开留档。

## 第二次九次对照前的回归证据

第二次九次对照的源码/helper指纹：`db55ce0c22844aa73711eae42614059fdca66ae352a21e7210d5f0080e9de429`。

| 验证 | 结果 |
| --- | --- |
| 新增参数/预算/截断和返工grader测试 | 6项通过；截断记录缺失、合法返工被误拒绝的旧行为先红后绿 |
| Git正式回归 | 26/26；两项旧staging断言已转为本次树的精确内容/inode校验 |
| 完整默认回归 | 118文件988项通过，0跳过；三个既有真实Flash用例全部执行，LRU用例233.6秒 |
| Phase9累计确定性Eval | 26/26，包含最终grader下cap1/2/3完整出口 |
| 静态与构建 | typecheck、Biome300文件、Next生产build通过 |
| 泄漏扫描 | 当前52个修改/新增文件0项；旧组及两个诊断共22个官方sessions/138406事件/24028550字节0项，未含开发Key |

新对照组为`phase9-comparison-9804daf4-ae8c-4dd9-a2b8-e4522895f6a2`，逐次核对上述指纹。机器摘要见 [phase9-repaired-summary.json](phase9-repaired-summary.json)；九次摘要现为`complete:true`、无pendingRuns，费用计全部final结算attempt。

## 已完成九次对照的失败审查

第2次（cap2）在最终TESTER结束时进入needs_attention，错误为`invalid agora objection: malformed JSON`。官方session证明provider以stop正常结束，无输出截断；异议argument字符串被`</argument>`错误闭合，缺少JSON的引号及右花括号。该异议针对PM自行增加的错误分页示例（把降序后的第2个记录写成最低分记录），而固定公开GOAL不包含这个错误示例。严格解析没有误判；即使语法正确，这也应交由Leader处理需求冲突，不能在固定对照中由runner猜裁决或改写需求。该次已失败final留档，不作为成功或从分母中移除；源码及配置继续保持冻结。

第5次（cap3）PM正常完成（19302 output tokens，其中17661 reasoning tokens，证明8192窗口不足以覆盖该实际回复）；ARCHITECT以stop正常结束，但在JSON字符串中直接写正则`/\s+/g`，`\s`不是合法JSON转义，故在位置406失败。没有截断，也不是解析器误判；现有提示约束不能保证模型输出永远符合JSON语法。该失败完整保留，未用自动转义修补改变模型输出。

第8、9次分别为cap1/cap2：官方工具正确报告初始空工作树，ARCHITECT最终返回完整JSON之前添加了英文说明段，违反原始JSON交付契约；并非Git/fs业务失败。两次provider均正常stop，严格解析拒绝正确。

九次新对照已全部final：**5/9通过**，cap1为2/3、cap2为1/3、cap3为2/3，费用USD0.586264760。原组、两个诊断与此组累计USD0.739789860（既有真实回归未单独计量）。组前后源码指纹db55保持一致，九次失败全部保留，model命令因四项失败正确返回exit 1。该组证明窗口修复恢复了执行链，仍未证明格式可靠性；不能将5/9当作之后新代码的成功率。

## 第二步：复用官方回合结束钩子

九次完成后才修改执行源码：在PM/ARCHITECT/REVIEWER严格纯解析校验失败时，经官方turn-stopping/steer至多再运行两个模型Step；每个纠正请求仍经过既有meter，纠正期间工具不可用。固定格式反馈随当前投影进入，未把raw群聊或宿主解析错误填入上下文；自身生成历史由Harness正常维护。不会调用I/O mutation读取器做试探，也不会把未通过的候选写入State。保留严格异议/Channel协议失败与Leader裁决边界，因此此修复不宣称自动解决第2次的需求冲突。

新增定向测试先红后绿覆盖前置说明、非法转义、两次上限、失败不触发mutation读取、控制块拒绝、抢占优先、工具权限恢复和空turn不复用旧结果。最终回归与独立真实验证见下文。该验证属于新的源码版本，原组不改写或替换。

当前有界恢复版本源码/helper指纹：`914b12e65fda04745fd1f6e8d4e89571d281af1e8259bf4fec33cd06401e66ff`。完整默认回归119文件995项通过、0跳过（真实LRU264.8秒）；26项deterministic、typecheck、Biome301文件、Next生产build通过。

真实格式故障注入为`phase9-format-hook-458fbcee-b9c5-4a29-8d37-7ae8fb1630a8`：直接请求真实Flash首次返回非JSON，官方纯校验拒绝后steer第二次请求返回合法JSON，仅提交最终一条消息；2请求、1次拒绝、USD0.000164168，未替换adapter或修改provider返回文本。驱动在`.data/plans/task95-format-g5.eval.ts`，官方session与结果在`.data/g5/<runId>/`。这是一项明确的故障注入正确性验证，不是自然任务成功率样本。

原组9次+两个诊断+修复后9次共20 runs、87 sessions、501463事件/91786108字节，经官方inspect完整展开并Gitleaks扫描0项，未含开发Key；包括新诊断与故障注入的最终全量审计见下文。

## 最终修复验证与限制

独立自然任务验证 `phase9-wide-pipeline-model-a1-c5ceab98-9611-426e-9727-bae8538cf470` 已通过：首波30项、累计45项、REVIEWER→D16正常批准→归档fresh Docker独立9项，费用USD0.113247952。任务运行结束lease=0、cleanupErrors=[]；只读核对现存容器挂载，Phase9模型评测容器无残留，其他8个容器未操作。

当前源码下的默认回归995/995、确定性26/26、真实格式故障注入和独立完整五模块验证全部通过。机器证据见 [phase9-format-repair-summary.json](phase9-format-repair-summary.json)，指纹运行前后相同。**当前有界恢复版本没有再跑九次统计对照**；前一版本5/9及其四个失败保留，不能宣称它们因本次代码修改而变成通过，也不能宣称当前模型稳定成功率。无效异议控制与实质需求冲突仍按严格拒绝/Leader裁决处理，不由普通JSON重生成绕过。

最终审计覆盖22 runs、98个官方sessions、564853事件、103775237字节：Gitleaks 0项、未含开发Key。当前修改和新增文件亦扫描0项。原始组+修复诊断+第二次九次组+真实格式故障注入的累计计量为**USD0.853201980**，低于原USD10；三个既有真实回归的费用未单独计量，不在此值内。

任务保持in_progress。未提交、推送、创建Issue或推进Phase10。
