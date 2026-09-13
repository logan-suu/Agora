# T10.6 交付门禁证据

日期：2026-09-12（本地时间）。Leader显式调用agora-commit，授权提交、推送及创建面向dev-1.0.0的英文PR；不授权自动合并。交付分支`feat/phase10-natural-chat-demo`从当前dev基线`45ae0985b69d0173c01e5f08fc0db71415975fdb`建立，保留本轮完整优化和已接受媒体。

| 门禁 | 本轮结果 |
| --- | --- |
| G1 规格 | 蓝图、详细设计§11.9/§11.10、架构、选型、开发计划、AGENTS和任务索引已同步；E01–E12及来源/验证路径通过静态核对 |
| G3 类型/Lint/构建 | `pnpm build:sandbox-native`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @agora/web build`全部成功 |
| G4 全量回归 | `pnpm run test --config /private/tmp/agora106-qa/commit-regression.config.mjs --maxWorkers=2`：166文件、1246测试全部通过、0skip，213.77秒；临时配置完整继承仓库include/setup，仅增加用量审计，无测试排除 |
| 真实模型 | 保留既有凭据，17次官方DeepSeek请求全部HTTP200且usage已记录，估算USD0.009645558；未运行新Benchmark、未设置撤销的临时费用上限 |
| G5 执行链 | 全量内真实Web/Harness/MCP/Docker/Git/State/SSE及跨阶段链通过。另对录制9的真实归档在只读、无网络Docker复跑18项产物测试＋8项独立检查，全过；6文件逐字匹配获批15b4aa96，任务linked worktree/容器均0 |
| G5 录制版本 | 420项源码hash逐一核对，与已接受的真实Go录制完全一致。自然语言输入、确认、返工、Leader批准及归档原始证据保留；不将本次归档复验冒称重新执行了整段模型任务 |
| G6 证据 | 本文及任务notes记录交付门禁；原片/State/session/日志在私有本地审计区，公开演示索引只提供安全事实及媒体/产物hash |
| G7 敏感信息 | 精确交付文件文本快照Gitleaks 0项；产物独立扫描通过，源码/测试只在受控沙箱执行；不提交.data、环境文件、密钥、会话推理或本机辅助脚本 |

首次使用`pnpm test --config …`被pnpm自身参数解析拒绝，测试尚未启动。随后改为上表正确的`pnpm run test`入口，保留相同测试范围和全部断言；没有把入口失败当成测试通过。

## 日志身份

私有目录：`.data/demos/task106-20260911/audit/delivery-validation/`。

| 日志 | SHA-256 |
| --- | --- |
| typecheck.log | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| lint.log | `ece741acc3cbd1e65d23e66d88cbb039def96c4365f1813e8f99ba1271ee0afa` |
| full-test.log | `724a3e021433d5c703de1e439b2423caaaf29cbf388819f25325603c10dc6ae8` |
| build.log | `bf21f50a26ad7a76084aceac647a093a74eba651ec04621f3ff6e1dbb42605ef` |
| g5-archive.log | `c223b41c22e3ab92d1d206cca1ce8964b766a191854f8ded77b32ac85529ba95` |
| secrets.log | `b913b8eb385e14ce418687f7777798d911578e57246db78b94f202cf71f78b64` |

新版视频已获Leader接受，详见[演示与产物证据](task106-natural-chat-demo.md)；出口预期见[文档核对报告](../reviews/task106-doc-acceptance-audit.md)。T10.6包含代码变更，PR合并前仍为in_progress；10.7依赖未满足，仍pending。本次交付不改10.5冻结结果，不替代Phase10出口。
