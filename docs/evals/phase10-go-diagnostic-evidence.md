# Task 10.5 OpenCode Go 在线诊断

2026-09-10，Leader“好的请开始”授权小规模在线诊断。正式 54 次评测仍暂停。本次最多 20 个请求、USD0.50 Go 订阅配额折算诊断额度，不混入旧官方 DeepSeek 账本。

顺序为两个模型的真实 Harness/沙箱读文件工具调用，再分别以两个自有长审计文件形成会话压力，触发官方自动压缩，并检查压缩后是否保留 `answer() = 42` 与当前页标识。模型回复不脚本化，不修改 65,536 上下文准入上限或官方 0.8 压力阈值；不使用正式题或 holdout，不据此声明任务成功率。文件只通过 LocalTempSandbox 工具读取，未执行模型生成代码；它不替代后续 Docker/Git/多角色完整流程验证。

首次运行 `phase10-go-diagnostic-ebb37f76-488d-4cd6-8db4-56685a630e23` 在首个模型请求后立即停止：V4 Flash 返回工具调用及输入 674 / 输出 65 token，但适配器输出缺少缓存命中拆分，原严格计量返回 unknown。没有启动第二个模型或压缩测试。排查考虑了 provider 不提供标准缓存拆分、adapter 字段映射遗漏、尾部 usage 丢失三种可能；证据确认标准 adapter 的输出没有缓存细项且保留完整输入总数，不能据此认定原始响应中所有非标准字段的内容。

修复使用可审计的额度上界：缓存拆分存在时按实际拆分计量；缓存拆分缺失而输入/输出有效时，按全部输入未命中缓存计算，并记录 `costBasis=uncached-input-upper-bound`。不改写原 usage，不把缺字段伪造为零命中事实；缺输入/输出或非法数值仍拒绝计量并停止。回归先红后绿。首个失败保留，人工审计将原预留 USD0.0589824 保守计入同一账本，历史 unknown 原因保留；后续运行复用该账本与累计请求数，未重置额度。

日志：首次 `/private/tmp/agora105-go-diagnostic-live.log`；第一次修复后 `/private/tmp/agora105-go-diagnostic-resume.log`；工具夹具修复后 `/private/tmp/agora105-go-diagnostic-tools-fixed.log`；最终成功运行 `/private/tmp/agora105-go-diagnostic-identity-fixed.log`。详细请求、官方 Harness 会话及计量证据保存在各诊断 `.data/evals/phase10-go-diagnostic-*/` 目录。

随后两次工具排查也各自在失败后停止。离线先发现诊断夹具的 `output.render` 误把第一个参数 arguments 当成结果，修复为 `render(_args, value)`；它不是产品业务工具的缺陷。第三次运行的官方会话进一步证明 Go 接入兼容问题：初始 tool delta 有稳定 id/name，后续 delta 的 id 为空且 name=null；锁定 DeepSeekAdapter 将其覆盖，最终产生 `unknown tool ""`。新增前置检查在看到工具错误后阻止下一次模型请求，因此该轮只发出一个请求。

Go Eval 层新增 `normalizeGoToolStream`，仅复用同一 block index 已明确出现的非空 id/name，原 arguments 不变。冲突或始终缺少身份则拒绝执行；先自然读完 provider 流再发布工具块，错误不截断在途 token 流。现有 Harness loop/官方序列化和 SSE 解析保持。离线真实 SSE parser 回归复现 null/empty 延续片段，验证身份恢复；冲突用例证明完整消费后拒绝且不发布工具块。11 文件 / 31 项离线测试通过，含真实 Harness/LocalTempSandbox 工具检查。日志 `/private/tmp/agora105-go-identity-tests.log`。

## 最终结果

成功运行：`phase10-go-diagnostic-4303803a-4e0d-4acb-aced-833708294e23`，41.78秒、14次真实模型请求，四个诊断单元全部通过：

| 模型 | 接入与真实工具调用 | 自动压力压缩 | 压缩后页标识/约束 |
| --- | --- | --- | --- |
| deepseek-v4-flash | 通过 | 1次 | 通过 |
| deepseek-flash | 通过 | 1次 | 通过 |

两个压力会话的官方JSONL均存在闭合的compaction/start、compaction/summary、compaction/end；两份真实模型摘要均保存answer()=42约束，后续工具调用和最终回复正确。最大已发送请求为31,603个Harness估算输入token，包含摘要请求；自动压缩在下一次主请求前完成，未放宽65,536上限。第二页也包含相同约束，因此最终回复本身不构成单独的记忆保留因果证明；约束保留另由实际摘要核对。这是专门夹具上的真实压缩接入验证，不代表复杂任务上的压缩质量或成功率。

包含三次停止的诊断运行，共19次请求；同一账本最终保守占用USD0.078770214 / 0.50，零未结算请求。其中首个失败的原预留上界USD0.0589824保留，其余18个请求合计USD0.019787814（部分为无缓存拆分的上界），不能当作精确现金账单。未重置预算、扩展请求上限或重跑正式54次组。Executor清理和LocalTempSandbox teardown均完成，官方会话保留。

静态检查：pnpm typecheck通过；pnpm lint通过（377文件）。日志 `/private/tmp/agora105-go-diagnostic-final-types.log`、`/private/tmp/agora105-go-diagnostic-final-lint.log`。未运行默认全量真实模型回归；下一阶段的单模型/混合模型完整Docker/Git/角色协作试跑仍未执行。Task10.5保持in_progress，未commit/push。

后续进展：Leader继续授权后，single与mixed完整流程已完成，详见[下一阶段证据](phase10-go-flow-evidence.md)。上段“未执行”描述本接入诊断结束时的状态，不代表当前进度。
