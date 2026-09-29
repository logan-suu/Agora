# 12.4 完整回归执行范围核对

2026-09-29；用于明确本轮完整回归授权边界，不是通过报告。

执行命令为 `pnpm run test --reporter=verbose --bail=1`：先运行7项追踪测试，再按现有Vitest配置运行298个测试文件。无筛选、不改断言/超时、不恢复正式Benchmark；首失败自然停止，未执行项不计通过。

## 外部模型请求

真实模型统一由 `tests/helpers/live-model.ts` 选择已有OpenCode Go凭据、`deepseek-v4-flash`，地址为 `https://opencode.ai/zen/go/v1/chat/completions`。缺配置或失败报错，不切换提供方。凭据用于认证，不作为模型输入或日志内容。

已检查该入口的全部调用点；`live-model.test.ts` 与 `live-model-wire.test.ts` 使用伪凭据及本地替代HTTP，不是真实外传。真实调用范围如下：

| 调用点 | 模型输入及工具范围 | 原期限 |
| --- | --- | --- |
| `packages/runtime/executor/test/g5-real-chain.test.ts` | 固定2+2问题、角色投影；无用户项目文件 | 120秒 |
| `packages/runtime/executor/test/channel-summary-g5-real-chain.test.ts` | 固定虚构Channel及一条结构化决策事实；无工具 | 120秒 |
| `packages/core/__tests__/e2e/lru-cache.test.ts` | 固定LRU/TTL需求、角色投影、专用LocalTemp工作区内生成的实现/测试及工具结果 | 600秒 |
| `tests/integration/phase12/phase12-3-live-workspace.test.ts` | 固定LRU源码夹具与5项测试、受控Seatbelt工作区工具结果；固定伪secret用于拒绝访问测试 | 原测试配置保持 |
| `tests/integration/phase12/local-delivery-harness-fixture.ts` | 固定算术/文件交付夹具、结构化控制事实、新生成修复文件及工具结果；专用授权目录 | 各普通目录360秒、Git场景900秒 |
| `tests/integration/phase12/local-initial-git-review-harness-fixture.ts` | 固定working/untracked文件、算术及文件测试、结构化需求/验证事实；受控Git工作区 | 900秒 |

这些是测试程序自行构造的输入，不读取用户业务仓库作为模型任务。角色规格/投影协议属于已授权的Agora角色提示。模型生成内容随本测试工具结果回传；不将业务仓库源码或真实凭据文本作为模型载荷。默认Vitest只匹配 `.test.ts`，正式 `.eval.ts` Benchmark不在默认运行范围。

## 本机副作用与清理

现有真实测试会创建专用临时目录、Git仓库/worktree、测试状态与Harness日志；启动测试子进程、受控Seatbelt命令、Docker测试容器及本地HTTP测试服务。Git原生集成使用受管工具链；不对用户项目提交/push，不创建PR，不自动合并，不安装/替换用户应用。Docker可能按现有测试配置获取所需镜像；共享缓存不清理。

结果与必要日志保存于Git忽略的 `test-outputs/`；先留版本/hash及失败依据，再按原夹具归属和停用检查清理专用临时资源。正常项目依赖、全局共享缓存、产品数据和用户项目不在清理范围。上述清单不把完整测试视为一个无副作用操作，也不替代G4实际结果。

## 当前状态

最终结果：session90159自然退出0，298文件2458项及追踪7项全部通过，零失败/跳过。完整证据见[最终验收](task124-final-acceptance.md)。以下启动/拒绝记录保留原发生时点。

Leader随后明确回复“批准”；相同完整命令已获审批并启动session90159，结果待定。以下拒绝记录保留原发生时点。

首次Git审阅修正后定向通过310994ms，静态检查与7项追踪测试通过。完整回归启动被自动审批拒绝：其认为多个真实模型/Git/Seatbelt/Docker路径的全量网络副作用范围尚未逐项明确。被拒命令未启动；本清单提供复核证据，不表示审批已通过。原完整69045失败及296文件未执行保持记录。
