# Task 9.5 出口证据（2026-09-08）

最新失败修复与证据见 [phase9-model-repair.md](phase9-model-repair.md)。新增窗口/提示/计量/判定修复后，独立九次对照为5/9；其后又增加官方Harness的有界结构化格式恢复，当前完整回归119文件995项、累计确定性26/26与生产构建通过，真实格式故障注入通过。新版本独立五模块诊断也已通过（30/45累计测试、归档独立9项）；尚未重跑当前版本九次对照，不以历史组5/9冒充当前版本成功率。任务保持`in_progress`，未commit/push/发布Issue，未推进Phase10。

下文保留首次出口验证的版本、982项回归及原始0/9对照作为历史证据。对应参数、指纹、统计不可与后续修复组混算；浏览器截图属于当次临时文件记录，不保证仍存在。

## 版本与配置

- 基线提交：`21fe533017295f922b6f2f406f9630a04c42c54e`；分支 `feat/phase9-exit-validation`，包含本次未提交修改。
- 执行源码与原生 helper 指纹：`f390ec0161f312023d89063edaaf2dde6962efd1242dd2c0adf0ea5d12d922b2`；九次前逐次校验，结束后再核验一致。
- Node `24.20.0`，Harness `0.1.1-rc.2`，宿主 macOS arm64；Docker 用户代码镜像 `node:20-slim`，实际固定 ID `sha256:6ced300970b1919c3ff96f482c6a342f2bca746922fcdc825e84e3b8f5ab3740`。
- 同一公开五模块 DAG：A 规范化、B 分数校验、C 稳定排序、D 分页均无前置依赖；E 导入四者组成管道。API/边界/错误输入见 `tests/evals/fixtures/phase9/contract.ts`。独立结果检查包含 9 项 Node 测试。脚本答案只用于确定性 adapter，真实模型只收到 GOAL 和正式角色投影。
- 模型统一 `deepseek-v4-flash`，high reasoning，`maxTokens=8192`，temperature 0.2，重试 0；每次全新 State/session/repository/container。镜像/helper预先准备，未做模型预热。实际 provider 别名背后权重不能由客户端锁定。
- 仅改变 scheduler cap，顺序固定为 `1,2,3,2,3,1,3,1,2`；admission=3，每容器内存上限512MiB、CPU shares=512、network=none。容器总资源随实际行为变化，不代表固定总CPU预算。
- 每次最多120请求、240工具、8轮、20分钟、2美元；整组1080请求、2160工具、180分钟、10美元。请求前保守预留费用；达到预算不再发起请求，在途Step自然收敛。D16只自动提交事先声明的正常完成批准；意外gate不猜裁决。

## 当前出口覆盖表

以下专项均包含在上述当前完整回归中；独立9.5出口在最后补充观察字段后再次通过。性能实验期间没有运行其他Docker验收负载。

| 要求 | 正式测试入口与本次证据 |
| --- | --- |
| 四宽batch、cap3、尾部完成、累计产物 | `tests/integration/phase9/phase9-exit.test.ts`：实际lease峰值3，A/B/C/D→E，5个CODER sessions，累计验证7/16项，Leader批准后fresh Docker独立9项通过，最终lease=0 |
| 跨项目公平、饱和队列、身份幂等 | `packages/core/orchestration/test/global-scheduler.test.ts` 9项：两个以上项目饱和排队后受控释放/轮转、task身份、释放幂等/伪造拒绝 |
| 完整batch、all-settled、canonical join及依赖 | `phase9-worker-pool.test.ts` 真实Harness/JSON链；`worker-runtime.test.ts` 41项验证失败与迟完成并存、成功事实保留、未满足依赖不启动 |
| 同role初始/reproject/Fork投影与写所有权 | `assignment-project.test.ts` 7项；`project.test.ts` 32项；reducer 62项及worker-runtime并行权限断言 |
| 精确验证HEAD、回执恢复与累计测试 | `apps/web/test/wave-validation.test.ts` 10项；`phase9-parallel-flow.test.ts` 11条真实HTTP/Harness/Git/Docker链，含失败验证、D9指纹失效重验与继承测试不可删 |
| 安全点、lease释放、多worker真Fork与abort | `phase9-preemption.test.ts`、preemptor 6项、worker-runtime；parallel-flow覆盖TESTER在0/2次工具后暂停、真Fork、abort后续跑及清理失败 |
| Git身份、legacy迁移、集成重放/冲突 | Git service 26项、metadata isolation 1项、`phase9-worktree-integration.test.ts` 2项、parallel-flow中的真实merge abort与Leader request_rework |
| REVIEWER定向A→已done C，保留B；缺/坏refs | parallel-flow真实定向返工和Leader全量退回；parallel-coordinator 13项含缺refs明确全量、空/重复/未知/畸形refs拒绝 |
| D16与终态生命周期 | Phase8出口3项、parallel-flow批准/退回、artifact/validation回归；WorkspaceAdapter新增停止失败保留真实Git树、重试成功后幂等回收（5项全过） |
| 正式文件入口抗替换 | `phase9-filesystem-boundary.test.ts` 三种正式入口：read/write/list、注册根替换、祖先竞态、末级/悬空/内部链接、硬链接及根外sentinel不变 |
| 原生句柄与跨平台 | `secure-files.test.ts` 4项；`scripts/verify-native.mjs` 在macOS arm64及一次性Linux arm64容器实际运行read/write/list、内部/悬空/越界/循环链接、硬链接、FIFO、独立祖先/末级竞态；Linux实际cc编译通过 |
| 后台写入、挂载与可信Git | `docker-isolation.test.ts` 精确逐worktree mount，兄弟/Task State不可读写；后台heartbeat在冻结全过程静止、恢复后可运行；`.git`指针改写不改变宿主Git选定的可信metadata |
| 浏览器真实Trace及刷新 | 下节真实Web运行：9 sessions、3 CODER、重叠419ms、1 Fork，刷新保持、截断=0，DTO无禁投字段 |

DEF-004与DEF-013按正式负向回归和当前真实生命周期证据关闭；DEF-010已复核并保持resolved。逐项状态仅以 `docs/deferred-items.json` 为准。LocalTemp.run仍是受信开发测试用本地子进程，不宣称容器级隔离；生产Phase9使用Docker。原生构建/部署和根身份兼容约定见详细设计§6与技术选型§12。

## 真实模型结果

机器可读全量汇总见 [phase9-baseline-summary.json](phase9-baseline-summary.json)。原始结果、manifest、provider usage、官方压缩JSONL及observation保留在 `.data/evals/` 中，组ID为 `phase9-comparison-5a677346-85f6-4090-a872-247959886788`。没有替换失败、增加样本或事后调整模型配置。

| cap | 成功/已启动 | 终止时延均值（秒） | 中位数（秒） | 样本标准差（秒） |
| --- | --- | --- | --- | --- |
| 1 | 0/3 | 75.760 | 74.064 | 14.630 |
| 2 | 0/3 | 67.237 | 66.129 | 2.772 |
| 3 | 0/3 | 70.811 | 69.305 | 3.517 |

这些是**失败终止**时延，不能作为任务成功完成的性能比较。成功时延分母为0，加速比不计算。全部失败在CODER dispatch之前，无法从本组数据判断cap的效果。

实际共13次模型请求、9次工具调用，按冻结的官方峰谷/缓存计价估算 **USD 0.056531336**，低于10美元软上限；既有回归费用未单独计量，不包含在该值中。输入按真实usage计费，缓存命中单独计价，不重复计入reasoning输出或Fork历史请求。8次PM触及约8192 token输出窗口并以 `max-tokens` 结束（7次无正文、1次正文截断）；另一次PM完成后，ARCHITECT以 `stop` 正常结束但JSON缺少闭合括号。2026-09-08审查通过官方 `sessionPersistence.inspect` 展开全部压缩帧复核，未将只含header的首帧当成完整session。改变输出/推理配置应另立实验，不能从本组删去失败后再宣称提速。

资源指标与分段时间保留在observation及汇总中：lease/composition由真实生命周期记录；容器/worktree/磁盘为200ms采样观察最大值。最终任务目录的保留磁盘/linked-worktree另计；公共teardown staging磁盘、CPU与内存实际使用未采集，明确unknown。容器/工作树数不等于worker额度。本次同目录保留数据用于审计，不自动删除。

## 浏览器QA

使用已构建Next生产服务 `http://127.0.0.1:3095/`，`AGORA_DATA_ROOT=.data/g5/task95-browser`。该数据来自正式parallel-flow中“suspends validation after 2 observed tools”用例的独立留档运行：仅将dataRoot保留，并把scope设为页面默认`agora/lru-demo`，所有原断言和真实生产接缝不变。留档驱动在 `.data/plans/phase9-browser-flow.test.ts`，配置在同目录；这条独立G5不计入模型性能样本。

Browser插件未提供；使用预装Playwright。它缺少自带Chromium，因此改用系统已安装Chrome的独立headless上下文，无下载或用户profile。桌面1440×1000、移动390×844。

| 检查 | 结果 |
| --- | --- |
| 页面身份/非空/框架overlay | Agora，真实完成任务与Trace可见，无框架错误overlay |
| JSONL与安全投影 | 9 sessions，3 CODER，实际turn重叠419ms，1 TESTER Fork；0 omitted events，递归检查无prompt/projection/reasoning/arguments/results/payload/display字段 |
| 刷新恢复 | 相同session lineage泳道重新加载；依赖官方持久数据，不依赖活动容器 |
| 交互 | session折叠状态实际改变；移动任务侧栏可打开，时间轴可滚入视口 |
| 控制台 | 无页面脚本或业务请求错误；已知静态 `/favicon.ico` 404保留记录，不隐去或冒充零错误 |
| 视觉证据 | `/tmp/agora-task95-trace-desktop.png`、`/tmp/agora-task95-trace-mobile.png`；结果 `/tmp/agora-task95-browser-qa.json` |

## 执行门禁与限制

- `pnpm build:sandbox-native`；macOS/Linux原生审计通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm run test --maxWorkers=4`、`pnpm --filter @agora/web build`通过。首轮失败已保留为调试过程：显式文件能力绑定、Git默认分支及停止失败回收顺序均已修复，原断言未弱化。
- Phase9累计deterministic为26项通过；model命令的Vitest入口通过只表示九份结果均完成final落盘，**不表示九次模型任务通过**。
- 当前diff/新增文件gitleaks无泄漏；2026-09-08审查再次以官方inspect展开10份session的76883条事件（12584331字节），gitleaks扫描0项，且未含开发Key。凭据未移除或写入提交内容。
- 未测试Windows；Linux验证原生文件边界，完整产品回归在macOS宿主完成。浏览器以Chrome两种视口验收，不声称全浏览器兼容。

## 失败审查修复记录

完整审查、每次失败、后续不同源码版本的验证与限制统一见 [phase9-model-repair.md](phase9-model-repair.md) 和 [phase9-repaired-summary.json](phase9-repaired-summary.json)。原始0/9组保留。本页此前“Vitest入口通过只表示记录完成”的描述仅针对原始版本；修复后的入口先写全量final结果，再因任何失败Outcome返回非零退出。
