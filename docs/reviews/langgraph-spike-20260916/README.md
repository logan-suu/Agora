# LangGraph / Harness 前置实验记录

日期：2026-09-16（America/Chicago）。用户授权：在独立方案基础上开始前置实验。代码基线、依赖精确版本/完整性、结果、失败、会话hash、模型用量和源码hash见[results.json](results.json)。解读与方案调整见[独立方案§24](../../langgraph-harness-design.md#section-24)。本目录保留复现所需最小源码和结果，不修改产品依赖、规格或任务索引。

## 实际范围

- LangGraph 1.4.15、core 1.2.11、checkpoint 1.1.5、SQLite saver 1.0.4、better-sqlite3 12.11.1、Zod 4.6.5。
- Node24.20.0 / macOS26.5 / arm64；另用已安装Agora的受管Node加载搬迁后的独立依赖包。
- 确定性图探针、真实GlobalScheduler、真实Harness与官方会话持久化、真实MCP fs_read/fs_write。
- 真实模型保持OpenCode Go / deepseek-v4-flash；只发送虚构文件任务，不执行模型生成代码。工具限定实验根，不开放宿主命令。
- 7个成功的native Harness Step、5次实际文件工具调用，分别来自两Agent初始暂停、两Agent恢复以及一Agent故障收尾。继承的parent seed事件不重复计量。
- 未宣称生产WorkerRuntime/D9/D4/TaskState联调、D18本机Worktree集成、全量回归或DMG升级验收通过。

## 必须保留的失败与修正

1. **框架默认失败行为不符合直接接入要求。** 一个节点抛错后，兄弟节点收到abort，图先于兄弟结束返回。官方安装包`dist/pregel/runner.js`可追踪`exceptionSignalController.abort()`；文件hash已保存。结构化业务失败可避免这种早退；未知异常仍须外层supervisor关闭新准入、请求安全点并等待所有调用收敛。真实Harness故障探针已验证后者，不能转发graph signal到模型传输。
2. **首轮真实模型网络失败。** 受限环境DNS为ENOTFOUND，Harness返回TRANSPORT。提高网络权限后相同提供方/模型成功；没有换模型、降低断言或重设模型容量。首轮探针没有显式等待兄弟调用收尾，已补supervisor后再运行；旧测试进程已确认退出。原失败摘要与生命周期事件保留在results.json。
3. **探针类型错误。** `map(JSON.parse)`的回调签名不满足TypeScript，改为显式单参数回调；最终定向tsc与只读重复resume检查通过。未改变业务断言。

## 复现入口

应从记录的Agora代码基线和匹配开发依赖运行；使用全新实验目录，不复用已经运行完的checkpoint来冒充新实验。源码按原相对结构复制到Git忽略的`test-outputs/langgraph-spike-20260916/`：

```text
test-outputs/langgraph-spike-20260916/
  runtime/package.json
  runtime/package-lock.json
  src/framework.mjs
  src/scheduler.mjs
  src/live.test.ts
  vitest.spike.config.mjs
  tsconfig.spike.json
  results/
```

`sources/`中的文件复制到`src/`；本目录的两份配置复制到实验根。安装只作用实验目录：

```sh
npm ci --prefix test-outputs/langgraph-spike-20260916/runtime --cache test-outputs/langgraph-spike-20260916/npm-cache --no-audit --no-fund
pnpm build:sandbox-native
```

`framework.mjs <mode> <scenario-directory>`提供如下独立场景；同一行的mode共享场景目录，按顺序运行。正常返回0，故意退出的返回值列在括号中；父测试必须检查它，不能把所有非零结果忽略。

| 场景目录 | mode顺序 |
| --- | --- |
| raw | raw |
| wrapped | wrapped |
| pending | pending-start（73）→ pending-inspect → pending-resume |
| gate | gate-start → gate-inspect → gate-resume → gate-duplicate |
| effect | effect-start（74）→ effect-resume |
| effect-bad | effect-start（74）→ effect-corrupt |
| gap | gap-start（75）→ gap-resume |
| stream | stream |

这些退出注入只发生在无模型的独立测试进程内。文件效果与收据是固定fixture，用于验证恢复机制，不冒充生产Git/文件事务。

真实Harness分别使用新的Vitest进程执行，所需Go凭据经仓库既有helper读取，不写入本目录：

```sh
LG_SPIKE_MODE=initial pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
LG_SPIKE_MODE=inspect pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
LG_SPIKE_MODE=resume pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
LG_SPIKE_MODE=duplicate pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
LG_SPIKE_MODE=audit pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
LG_SPIKE_MODE=failure pnpm exec vitest run --config test-outputs/langgraph-spike-20260916/vitest.spike.config.mjs
node test-outputs/langgraph-spike-20260916/src/scheduler.mjs
pnpm exec tsc -p test-outputs/langgraph-spike-20260916/tsconfig.spike.json
```

initial/resume/failure使用真实模型；inspect/duplicate/audit不调用模型。audit使用官方`loadSafePoint`校验已有child及错scope拒绝，不靠解析压缩文件的物理行数判断seed：官方日志存在压缩/合并事件，其物理记录数不等于逻辑seq。

S06复现：将runtime/src复制到另一个独立目录，使用`/Applications/Agora.app/Contents/Resources/toolchains/darwin-arm64/node/bin/node`，从`/private/tmp`作为cwd运行gate-start/inspect/resume。受管Node hash和实际结果已留证；这不创建新DMG，不修改已安装应用。

## 清理

完成后先保留版本、源码、结果、必要失败、session与依赖hash，再确认测试进程/文件句柄停用，只清理本实验创建的依赖、npm专用缓存、搬迁包、fixture工作区及原始输出。正常项目依赖、共享缓存、已安装Agora、产品state和Keychain不在范围。实际清理回执见[cleanup.json](cleanup.json)；已清理的实验目录和原始session不是可下载交付物。
