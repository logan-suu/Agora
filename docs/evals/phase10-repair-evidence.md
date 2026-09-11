# Task 10.5 评测后修复证据

2026-09-10 UTC。Leader 授权：“发现需要修复的进行修复”。任务仍为 in_progress，尚未 commit/push。本文记录修复，不替代 [v3 正式报告](phase10-final-benchmark-report.md)。v3 的 54 次实验、25 次通过和全部失败保持原值；349 份冻结源码快照复核哈希一致，当前修复源码已与其不同。未追加新的正式对照组。

## 1. REVIEWER advisory 后缺少后续评审

冻结样本 shift-conflicts-parallel-1 已通过累计 62 项 Node 验证，REVIEWER 随后提交合法 concern/advisory，worker 正常 done，但没有 verdict。执行器正确跳过普通角色交付解析，协调器却直接要求 verdict，形成产品衔接缺口。

修复在 L2 协调器完成：只接受当前 REVIEWER dispatch 之后的规范 objection Message，并重用既有 objection 协议规划函数复核它与 State 的不可变 Objection 完整对应；确认 REVIEWER 已 done、当前没有 verdict 后，创建新的 REVIEWER dispatch。并行 assignment 投影核对 advisory 引用并注入固定续评指令，避免通用指令覆盖续评目的；不投原始群聊或异议正文。新 dispatch 记录 advisory 来源，保留当前 validation receipt/commit/control fingerprint 及 root-cause reason，重置 review cursor，计入 iterationCount。旧 worker 保持 done；新 worker 经过正常注册、投影、lease 和执行。第 8 轮升级 Leader。

既有 verdict 不走该分支，仍按 D16 校验；missing/漂移事实、旧 dispatch 的 advisory、普通输出缺 verdict 仍拒绝。blocking 异议优先升级 Leader；根因评审续行后依然不能批准完成。没有新增 State 字段、端口或模型循环。

## 2. 评测包装器缺少上下文容量元数据

MeteredAdapter 原先继承 LlmAdapter.resolveModel 的默认实现，仅提供模型身份，没有 contextWindow。官方 BasicCompactionEngine 在 agent/pre-step 解析容量，缺少容量时无法计算自动压力阈值。该包装器缺陷与正式组的上下文限制失败有关，但证据不足以认定全部 20 个样本均会被本修复挽救。

修复后 resolveModel 透传底层元数据，并暴露冻结上限与底层容量的较小值；底层不提供容量时使用冻结上限。继续由官方 BasicCompactionEngine 执行自动压缩。请求前 65,536 启发式 token 准入、模型请求数/工具数/时间限制及费用预留保持，摘要请求也经过同一 MeteredAdapter。没有自研压缩器、提高上限或删除超限断言。

确定性回归通过受控 provider 容量与长会话历史实际触发官方自动压力压缩，观察摘要请求、后续完成及每次请求费用结算；脚本仅替代外部模型回复，Harness 与计量器均为真实实现。此测试证明压缩接缝恢复，不是压缩质量或正式任务成功率测量。

## 3. 验证

- TDD 红阶段：3 个新增复现断言失败，原有 16 项通过。日志 `/private/tmp/agora105-repair-red.log`。
- 路由/计量定向回归覆盖顺序与并行续评、不可变事实交叉核对、旧 advisory 不重放、pending dispatch 恢复、8 轮上限、blocking 优先、root-cause 与完成终审批界。
- 真实工具链：7/7 通过，51.80 秒；包含新的 advisory → 新 REVIEWER → verdict → D16 完成终审路径，及既有 single/mixed/sparse/公开测试可见性链路。HTTP、Harness、Docker、Git、MCP、持久化、可信验证、gate 与归档均为真实实现，仅外部模型回复脚本化。日志 `/private/tmp/agora105-repair-g5.log`。
- 首次受限沙箱检查因 Docker socket 权限失败，未发出模型请求；取得执行所需权限后按原断言跑完整文件 7 项通过。没有跳过或放宽失败用例。
- G3更正：当时typecheck实际失败（新增测试夹具数组spread导致Message.type拓宽）；先前通过记录有误。2026-09-10连接调整中修复夹具，最新typecheck通过；lint 370文件记录有效。最终完整回归已通过 143 文件 / 1,114 测试（431.64 秒，零失败、零跳过），保留既有 DEEPSEEK_API_KEY，费用计入原 USD20 总额及 USD3 诊断额度。修复前预算占用 USD8.352819564，其中诊断 USD1.251615040。

## 4. 其余失败的处置边界

真实合并冲突与 blocking 架构异议仍要求 Leader，未自动解决或绕过。非法 objection 控制格式仍 fail-closed；字面 DSML 标记不作为实际工具调用执行。两次传输失败没有足够证据定位 provider 或本机网络根因，保留 inconclusive 及原未知用量审计。现有格式恢复与请求重试保持有限，不以延长循环消除失败记录。

修复后的真实模型诊断和全量回归结果如下。未经新的预注册重复对照，不能从上述修复推导修复后成功率、并行提速或总体效果提升。


## 5. 独立真实模型诊断

`answer() = 42` 自有小题（不使用公开 Benchmark 或 holdout）实际运行通过，341.34 秒，24 次模型请求，费用 USD0.070106456，全部取得 usage；最大输入为 22,672 个 Harness 估算 token。该小题不用于验证压缩质量或更新正式成功率。

真实模型按诊断协议先产生 1 条 REVIEWER advisory；规范 State 保存该事实，随后创建第二个 REVIEWER worker，并给出 1 个有效 verdict。两个 reviewer 最终均 done，iterationCount=2；经过正常 D16 gate、完成绑定、归档和独立 Docker 验题（exitCode=0、未超时），任务 phase=done，最终 lease=0。模型回复没有被脚本替换。原始证据保留于 `.data/evals/phase10-driver-diagnostic-mixed-model-a3-a7d37d44-0555-42af-9d22-8905cc502f06`，摘要及哈希见 [修复诊断指标](phase10-repair-metrics.json)。日志 `/private/tmp/agora105-repair-live.log`。

首轮全量回归 142 文件通过、1 文件失败，1,113 项通过、1 项失败（397.86 秒）：执行期间新增的续评投影测试读取了该进程缓存的修复前投影实现，复现通用指令覆盖问题；完整失败日志保留于 `/private/tmp/agora105-repair-regression.log`。新源码定向复验 8/8 通过后，真实模型诊断也确认后续评审完成。随后以固定最终源码重新运行全套：143/143 文件、1,114/1,114 测试通过，431.64 秒，零 skip。日志 `/private/tmp/agora105-repair-regression-final.log`。新增投影断言与真实 advisory 工具链在本轮全部通过。


## 6. 最终门禁与交付状态

- G1/R12：蓝图、详细设计、系统架构、技术选型、开发计划、standing_decisions 与 Task10.5 notes 已同步。最终正式报告明确说明 v3 包含容量元数据缺陷，不能代表正常启用官方自动压力压缩后的表现。
- G3更正：当时pnpm typecheck失败，旧记录误报通过；夹具类型错误已在后续OpenCode Go配置变更中修复并重新检查通过。原pnpm lint通过，370个lint文件零违规；日志 `/private/tmp/agora105-repair-types-final.log`、`/private/tmp/agora105-repair-lint-final.log`。
- G4：143 文件 / 1,114 测试全通过，包括现有真实模型 LRU、跨阶段回归及新增覆盖；未排除文件、删除凭证或降低断言。
- G5：真实模型 advisory 续评与独立验题通过；真实 Docker/Harness/MCP/Git/State/D16 集成路径通过。官方自动压力压缩以脚本化外部 provider 精确触发，真实 Harness 与计费接缝均被执行，压缩质量未作效果声明。
- G6/G7：v3 349 份冻结源码逐项哈希一致；新诊断 final/pass、清理完成；候选变更没有匹配到现有 API 凭据，也没有 .env/secret 文件进入候选。修复源码指纹、诊断指标及哈希见 phase10-repair-metrics.json；私有审计见 `.data/evals/phase10-repair-final-audit.json`。

最终累计预算占用 USD8.472523904 / 20：正式 USD7.101204524 保持不变，诊断/回归 USD1.371319380 / 3；本次修复增量合计 USD0.119704340（包含两轮全量回归与真实模型诊断），无未结算或未知请求。原有未知用量的保守上界审计继续保留，没有改写历史用量。

业务修复与1114项测试结果有效；历史G3漏报已于后续OpenCode Go配置变更中纠正，详见phase10-opencode-go-config.md。未重跑新的 54 次正式组，旧 25/54 结果及所有失败保留；没有据修复诊断宣称新的总体成功率。Task10.5 保持 in_progress，尚未 commit/push、创建 PR 或标 done。
