# LRU超时诊断复现

这两轮运行只测既有`packages/core/__tests__/e2e/lru-cache.test.ts`，输入、真实Harness/LocalTempSandbox、Go V4 Flash、原生思考/256000输出及600秒期限均不变。probe透明观察真实fetch流与执行器/沙箱方法；不生成假响应、不增加模型请求、不保存请求正文/模型正文/推理/工具参数或结果。输出只包含计数、时间、状态、角色、模型标识与会话ID哈希。

`observer-v1.setup.ts`对应run1；v2额外记录会话头哈希、User-Agent存在性和响应模型名。两个JSON中的`request-abort`均出现在同请求DONE之后，是原生SDK完成流后的consumer清理，不是测试中途取消。run1未采集会话头/返回模型，缺字段表示未知，不表示缺失。sandbox事件只直接观察LocalTempSandbox方法；MCP fs工具可走注册文件入口，不能据此把sandbox事件数量当作全部工具调用次数。

复现第二轮（现有Go测试凭据由原helper读取；不会打印密钥）：在拥有相同锁定依赖的仓库根准备`.data/diagnostics/agora112-lru-timeout/run2`，将`observer-v2.setup.ts`复制为该诊断根的`observe.setup.ts`，将本目录`vitest.config.mjs`复制至诊断根，随后执行：

```sh
pnpm exec vitest run --config .data/diagnostics/agora112-lru-timeout/vitest.config.mjs
```

已有同名输出时先归档，避免覆盖旧证据。`run2/progress.json`每20秒更新，`run2/events.jsonl`记录起止；原用例仍负责验收并按原期限结束。复现第一轮使用v1并读取诊断根下的输出。不得把诊断单例通过当作完整G4，重复实网执行须符合当前任务授权；本轮没有自动重试完整测试集。

精确源文件hash、结果与结论见上级`task112-lru-timeout-diagnosis.json`，解释见同名Markdown。
