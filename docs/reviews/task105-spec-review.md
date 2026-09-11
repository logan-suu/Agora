# 10.5 规格合理性评审

> 时点说明：本文件保留Explore/Plan阶段的审查记录。Leader随后回复“确认”，当前10.5已进入in_progress；实施与实测进度见docs/evals/phase10-preflight-evidence.md，正式结果以后续冻结manifest为准。

日期：2026-09-09。任务：10.5「成熟 Benchmark 适配 + 最终对照与报告」。

Leader 要求先判断现有规格是否合理，不合理的先改文档。本次依据产品目标、已有实现与实验记录、上游官方资料进行静态评审并修订；不是实现计划获批、代码审查完成或 Benchmark 验收。源码基线 `5a577468848577c3ec278b70905c0acfbe43d920`，文档分支 `docs/review-phase10-benchmark`。未安装外部工具、构建镜像、运行模型/测试或读取用户凭据。

## 结论与修订依据

用外部任务评最终产物、用内部场景评协作机制的目标合理。旧文档只有方向，不能直接作为执行计划：对照变量不清、现有验证能力与外部生态有落差、实验预算和失败解释缺少可执行定义。修订保留四组对照与真实验收要求，不预设多 Agent 必须获胜，也不为刷分弱化权限、投影或 Leader 权威。

控制原文：

> “上下文只经投影切片喂给 agent，永不投原始群聊 log”——AGENTS.md R2。

> “外部 Benchmark 通过 adapter 转为统一任务，不允许其类型或运行时依赖反向进入 L1/L2。”——详细设计 §11.1。

> “公开 Benchmark 的测试/补丁 Grader 只能证明最终任务结果，Agora 自定义 Process Grader 负责验证角色投影、Channel/Leader 权威、安全点、交接和并行一致性。”——系统架构 §7.1。

| 发现 | 证据与判断 | 修订 |
| --- | --- | --- |
| “全量历史 vs 角色投影”没有合法基线 | R2 禁投原始 log；D1 与 assignment 限制同 role 的任务/工作区；详细设计 §7 的 ChannelContext 是参与者过滤后的白名单结构化切片。不能为了实验放宽生产红线。 | 改为同一可见范围内的结构化上下文保留策略比较，固定预算上限，保留最新权威与安全系统信息；不宣称 raw chat 消融效果。 |
| 单 Agent 被当作显然存在的产品模式 | cap=1 的 Phase9 runner 仍有多角色与 D17 波次；D16 要求真实 Reviewer/Leader 完成事实。 | 单 Agent 使用 Eval 专用 Harness driver；与多角色比较系统整体开销，不冒充 cap=1 或伪造产品 done。具体 driver 仍待实现。 |
| 每组“固定模型”与模型路由对照自相矛盾 | 改逐角色模型映射必然改变某些角色的模型，不能同时保持所有模型相同。 | 每组只固定非目标变量；路由组明确整份模型映射及参数，报告模型构成与编排组合的效果。 |
| 多个基准名称看似同时必做，缺候选资格 | 产品是本机作品集系统；两种生态的任务、环境与判定不同，安装/执行成本不能由名字推定。 | 至少一种兼容生态，先预检再冻结分层子集；不要求全变量笛卡尔积，四组在各自适用任务上执行。 |
| Node/TAP 波次验证被隐含当成通用 verifier | `apps/web/src/server/wave-validation.ts` 构造 `node --test --test-reporter=tap`，TESTER 写入路径/测试格式受限。`DockerSandbox` 虽可换镜像，仍默认无网络、单挂载、依赖 shell/timeout。 | 明确能力缺口。先核对任务、环境、产物移交和判定保真；需要生产扩展则列实施计划及真实回归，不只换镜像或伪报 passed。 |
| 上游通过、产品完成和实验完成易混同 | D16 与独立 Outcome 各有不同事实源；runner 的 final 只说明清理后定稿，并不代表任务成功。 | 三者分别留证，单 Agent 不伪造协作检查；适用检查在运行前冻结，失败返回与组完整性分开。 |
| 缺参考解/隐藏测试的隔离约束 | 上游支持参考解预检，若把 verifier/solution 一起当 fixture 交给模型就失去独立判定意义。 | 隔离验证器正反校验与模型工作区，冻结产物 hash；改写题面/验收只能记 adapted/internal。 |
| 旧 fixture 可能被重新命名为 holdout | Phase6–9 tasks、model-adapter 和修复报告已公开用于调参、诊断和回归。 | 旧集保留为开发证据，另冻未用于调参的新 holdout；使用后调参须留新测试集、原结果不抹去。 |
| “重复运行”没有可验收下限与预算 | 旧任务10.5未定 attempt 数、任务数量、组预算和轮换；不能继承9.5的旧模型/美元授权。 | 每个比较 task×variant 至少3次，任务数与各项限额在实施计划冻结；分层比较不强迫所有题跑全组合。 |
| 失败可能让对照失去解释力 | Phase9原组0/9且在CODER前失败；后续修复和配置变化不可混算成当前版本的并发收益。 | 统计机制触达，分开成功/失败时延；全失败可以是真实结果，但不能据此判断未运行机制优劣，更不能掩盖adapter或安全缺陷。 |
| 三天排期与未验证的外部依赖不匹配 | 预检、可信判定适配及多组重复均有未定环境/预算；日历估算不应驱动削减验收。 | 开发计划保留历史估算并标明预检后重估，不承诺三天完成。 |

## 本地证据入口

- `tests/evals/core/contracts.ts`：任务 fingerprint、固定 profile/variant、有限结果 schema，适合继续复用。
- `tests/evals/core/runner.ts`：独立 run root、provisional/cleanup/final、Outcome/Process/Safety fail-closed；新增 manifest/观测不需进入产品 State。
- `tests/evals/phase9/run-phase9-baseline.eval.ts`：同一 DAG cap=1/2/3、旧固定模型、9次顺序与预算；这不是已有的单 Agent/上下文/模型路由通用实验器。
- `tests/evals/phase9/scenario.ts` 与 `tests/evals/fixtures/phase9/contract.ts`：绑定自有 GOAL/PLAN、Node产物和 fresh Docker 验证，不能仅改 source 标签变成公开基准适配。
- `apps/web/src/server/wave-validation.ts`：Node/TAP 命令与允许写入的测试文件契约。
- `packages/runtime/sandbox/src/docker-sandbox.ts`：镜像/资源可配置、默认 network none、容器 shell/timeout 和逐工作区生命周期。
- `docs/evals/phase9-exit-evidence.md`、`phase9-model-repair.md`：历史失败、配置修订和未重跑统计的边界；本轮没有复跑这些实验。

## 外部资料与边界

2026-09-09 只读核对上游官方文档；网页为动态资料，不能代替实施时锁定 release/commit 和实际运行验证。

- [SWE-bench Quickstart](https://www.swebench.com/SWE-bench/guides/quickstart/)：使用 Docker 环境评测预测补丁，并提供 gold patch 环境校验。结论：应复用实际判定链并先验证环境，不只读取问题文本。
- [SWE-bench Docker Setup](https://www.swebench.com/SWE-bench/guides/docker_setup/)：列出镜像、缓存与本机资源配置要求。结论：资源成本须按候选子集实测，不能把完整套件建议硬套为每个小子集最低门槛。
- [Harbor Task Structure](https://www.harborframework.com/docs/tasks)：区分 instruction、environment、solution 与 verifier，并声明任务资源和网络配置。结论：必须维持环境/判定语义与参考解隔离；不是所有 Harbor 任务都能映射为单 Git worktree。
- [Harbor Agents](https://www.harborframework.com/docs/agents)：支持自定义 Agent 接入。这里只说明评测系统可扩展，不表示 Agora 已实现其接缝，也不构成接入第三方编码 Agent 的授权。

## 已同步与实施前事项

按来源顺序更新蓝图 §17/§21 D11 → 详细设计 §11.4/§11.5/新增 §11.8 → 系统架构 §7.1 → 技术选型 §11.3 → 开发计划 §13 → task-status 的 D11摘要与10.5 notes。R1–R13与冻结生产端口不改，AGENTS.md 无需新增例外；无新增延期项，不创建 Issue。

本次已解决可由现有约束和证据判断的规格矛盾。实际候选数据集/任务数、driver及验证能力扩展、模型映射、费用与时间预算仍须经过预检并形成实施计划；未选择具体外部依赖版本。若候选均无法在现有边界实现，届时再给出明确范围取舍供Leader裁决，不提前承诺支持。10.5保持ready，依赖不变；文档修订不等于开工、代码授权、付费运行或G1–G7通过。

## 文档检查

JSON解析及与HEAD逐项比较通过：任务ID、状态、依赖、current_phase和D11之外的常驻决策均未改变；无新增依赖级联候选。`git diff --check`通过，旧“全量历史”任务要求已替换，保留的用语只用于说明旧口径、R2边界或历史框架分析。针对task-status的Biome调用返回“未处理文件”，原因是仓库配置原本排除了该文档，未改配置绕过；不把该调用计为lint通过。本轮只改文档，未运行源码测试或模型实验。
