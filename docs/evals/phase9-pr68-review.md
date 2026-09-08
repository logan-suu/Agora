# PR #68 评审修复

评审基线为 `ffd6b6c170fffffa2b26d80ac60731b6fc62ed66`。Leader 于 2026-09-08 授权修复；任务保持 `in_progress`，PR 由人类合并。

## 已修复内容

- 合法异议/Channel 控制在最终结果路径也与普通结构化交付分流，不调用 JSON 格式校验或普通 readTurnMutations 交付解析，独立文件事实读取保留；非法控制仍严格拒绝，不由格式恢复改写。新增测试核对控制消息、单次模型调用和普通交付读取未执行，并验证 TESTER 附带 advisory 时实测失败结果仍提交。
- LocalTemp/Docker 以规范根保存唯一文件 capability，并记录不可变注册别名；规范/别名访问共用根身份，重复注册不刷新 inode/device，别名重定向拒绝。真实 LocalTemp 恢复、Docker bind 及 Docker suspend→别名 resume→createWorktree 读写均纳入回归。
- 同根 SecureFiles 共享宿主写入屏障，覆盖独立 FsService 和 SandboxManager 的写入口。屏障从 Docker pause 前持续到 unpause 后；冻结窗口内同步写入明确拒绝，嵌套与失败退出会正确释放，其他根继续可写。该屏障补齐宿主入口，不替代真实容器进程冻结。原评审只证明并发端口调用的缺口，未声称正常 Harness 串行工具调度已造成生产攻击。
- `repairBudget(evalRoot)` 独立为可直接测试的模块：根目录不存在表示首次运行；匹配历史缺 manifest 明确提示核对记录，未完成/未知/非法费用继续阻断，避免忽略可能已计费的尝试。
- `cacheWriteTokens` 纳入有限、非负校验；非法 usage 返回 unknown，预算保持拒绝继续请求。
- heartbeat 测试有界等待首次写入，再检验真实暂停期间文件不变；保留 Docker 必跑及原冻结断言。
- 故障注入驱动版本化为 `tests/evals/phase9/format-repair.eval.ts`；命令 `pnpm eval:phase9:format-repair`，使用已配置的真实 Flash 凭据、USD0.6 预算，独立于默认测试。
- 蓝图、详细设计、架构、选型同步规范根/宿主写屏障，详细设计同步控制分流/费用历史规则；计划删除过期的“所有新增项仍待实现”，保留默认测试不触发独立 Eval。

## 13 条 CodeRabbit 评论的处理

| 评论 ID | 处理 |
| --- | --- |
| 3962536197 | 已版本化注入驱动并给出重跑命令；原始 session 继续保留在本地，不发布敏感日志 |
| 3962536205 | 已纠正“待实现”；默认测试与独立 Eval 的分离符合既有规定 |
| 3962536212 | 未采纳将 deterministic 费用改为 unknown：脚本 adapter 不调用付费 provider，零模型费用有配置依据 |
| 3962536222 | 未新增默认测试自动构建：AGENTS 已明确首次测试/构建前执行 build:sandbox-native；缺 helper 明确失败，不是静默通过 |
| 3962536230 | 未删除 PM 依赖标识提示：详细设计 §2 明确要求保留；这不新增 Requirement schema 字段 |
| 3962536239 | 已修复最终校验与普通正文读取回调的控制分流，保留独立文件事实 |
| 3962536261 | 已修复规范路径与别名能力索引，保留根身份防护 |
| 3962536267 | 已补覆盖两种正式宿主写入口的共享屏障，不仅修改 Docker.write |
| 3962536273 | 已用有界就绪等待替代固定100ms |
| 3962536280 | 已校验缓存写 token，非法值转 unknown |
| 3962536284 | 未采纳无条件改计时：未到 gate 时 gate/approve 同为0可表示无人工等待，未证明现有分支有错误计时；仍需具体生命周期反例 |
| 3962536292 | 已修复首次目录问题；缺 manifest 明确阻断，不能盲目跳过可能已计费记录 |
| 3962536298 | 未跳过 Docker 测试：与2026-09-07 Leader测试约定冲突，缺运行条件必须明确未完成 |

## 验证记录

完整日志保存在 `.data/review/pr68-*.log`。新增回归先复现6个功能断言失败；历史预算模块另有首次目录/损坏记录的红→绿证据。初次受沙箱限制的 Docker 检查报 EPERM，随后获准访问真实 daemon 执行，不排除用例。

中间版本真实格式 G5：`phase9-format-hook-5b9d53ab-11e0-45c6-9cd4-3a4042f32624`，2请求、1次格式拒绝、pass，USD0.000053996。源码/helper 指纹 `808d7802b46fe18c728d6197cf592b6783975ea50e44fe4aa098d83a4deb375d`。

最终版本真实格式 G5：`phase9-format-hook-e9902832-1779-4cde-b199-c8996e7d6b4c`，2请求、1次格式拒绝、pass，USD0.000078416。源码/helper 指纹 `51d91100857595962b83bb027b83471a4e72f3e58089b148b5ecfe504397da68`。两次官方 session 合计169事件/31962字节全量扫描，Gitleaks 0项、未含开发Key。累计确定性 Eval 在最终指纹下26/26通过；独立命令按名称只选择目标 profile，不将其他未选择的付费 profile 计作已运行。

本轮没有重跑九次 model 统计对照，不把旧版本5/9或此次故障注入当作当前自然任务成功率。累计历史和适用范围继续见 [phase9-model-repair.md](phase9-model-repair.md)。

首轮全量为1008通过/1失败：真实LRU报testing缺testResults。保留目录中实际存在52项/1失败的完整报告，故不是模型没有写文件。追加真实文件+合法advisory的最小回归先红，确认本轮一度将控制分流扩大到独立文件读取会丢失实测证据；已收窄为只跳过普通正文validator/readTurnMutations，保留testResults/subtask事实读取。首轮没有持久化模型最终控制文本，因此不将推断冒充该次session直接证据。最终门禁重新执行，不以单项重跑覆盖首轮失败。

第二轮全量1009通过/1失败，真实LRU通过（254.969秒）；唯一失败为与独立Docker Eval重叠运行时，既有Phase9返工长链触发60秒测试框架超时。未修改源码、断言或超时，停止并行运行两套门禁并把测试文件间maxWorkers从4降为2后，该用例16.527秒通过，11条Phase9并行链全部通过；产品内部worker cap与并行验收不变。完整第三轮结果另记于最终门禁。

最终门禁：`pnpm typecheck`、`pnpm lint`（305文件）通过；`pnpm run test --maxWorkers=2` 为120文件1010/1010通过、0跳过，197.29秒，真实LRU176.073秒；Phase9独立出口及11条并行链均通过。24个交付文件敏感数据扫描0项。两次新增计量G5合计USD0.000132412，连同历史评测累计USD0.853334392；真实默认回归费用仍未单独计量，不包含在该数字中。未执行新的九次model统计对照，任务保持in_progress。
