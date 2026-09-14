# 完整 G4 的脱敏证据

对应报告：[task112-g4-review.md](../task112-g4-review.md)、[task112-g4-review.json](../task112-g4-review.json)。

- `test-files.json` 记录全部 171 个实际测试文件、源码 SHA-256、断言数量与通过状态。
- 三个 `*.test.ts.json` 为实网用例的白名单观测：请求状态、时序、字符／token 计数、会话哈希及沙箱命令耗时。没有模型正文或工具参数。
- `full-summary.log` 摘取原始日志的测试汇总；完整本地日志与 Vitest JSON 保存在 `.data/diagnostics/agora112-full-g4-review/`，其 SHA-256 记录于报告。
- `typecheck.log`、`lint.log`、`startup-stop.log` 为对应命令的完整结果。
- `vitest.config.mjs`、`select.setup.ts`、`observe.setup.ts` 保存实际观测配置。复现时将三文件复制到 `.data/diagnostics/agora112-full-g4-review/`，再运行报告中的命令；它们不是默认产品／测试入口。观测器沿用上一轮 v2，增加按测试文件选择及独立输出目录，并修正沙箱退出码字段为 `exitCode`。

请求输入和响应字节原样传递；不更改断言、原生思考、容量、测试期限或并发。运行需已配置的 Go 凭据及真实 Docker／本机依赖；本次验证只使用 Go V4 Flash。
