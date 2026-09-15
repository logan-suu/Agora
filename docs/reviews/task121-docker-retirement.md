# 12.1 Docker退役设计审阅与源码清点

日期：2026-09-15。基线：`e9200f9d06c663bb52c7edb8350a278fecc43ed2`。任务类型：design。**设计已于2026-09-15获Leader确认；未执行运行时退役或产品G5。**

## 1. 审阅入口与结论

完整正式契约位于[详细设计§12.3.11](../详细设计方案.md#docker-retirement-121)。本报告只记录清点证据，不维护第二份规范或任务状态；机器可核对的路径/命中行/源码hash见[清单](task121-retirement-inventory.json)。

- R01–R10：后端、公开配置、生产装配、Git/归档稳定文件、包依赖与打包、安装/启动/恢复、角色说明、测试与Eval。
- 新状态：复用Phase11已实现的新桌面根与升级协议；禁止旧Docker任务发现/读取/恢复，不重置新桌面配置或新本机工作。
- V01–V12：逐项保留协作、安全、可信验证和交付语义；只有被删除Docker能力的专属断言退役。
- 12.2细化权限与direct类型；13.2完成安全退出恢复；13.3执行移除及本机替代回归；13.4在无Docker环境累计验收。

## 2. 来源原文

详细设计§12.3：

> 12.1 清点后端、依赖、配置、启动/恢复入口及受影响测试，制定本机替代覆盖和新状态入口；13.3 在新本机路径验收后完成移除，不提供 Docker fallback。

蓝图§21 D18：

> 仓库中已完成研发任务及其历史证据保留；此决策不授权自动删除用户代码、本机旧数据或容器。

详细设计§12.1.7：

> 维持旧六签名；workspace注册由companion提供；direct目录需要独立类型/能力，禁止虚构Git字段

开发计划§18.11：

> 退役后累计回归验证保留契约的本机实现，按退役清单替换仅属于已删除Docker能力的覆盖，不重新要求Docker，也不跳过仍有效的回归。

## 3. 关键证据与设计判断

| 观察 | 源码证据 | 设计处理 |
| --- | --- | --- |
| 工厂默认LocalTemp，生产组合默认Docker；“改默认值”会失去生产保护 | `sandbox/src/factory.ts`；`apps/web/src/server/task-composition.ts` | R01/R02：生产只接授权本机能力；旧kind明确拒绝；低阶段LocalTemp保留 |
| Docker依赖是静态导入/再导出，不只构造时加载 | factory/index及sandbox package | R01/R04：移除所有导入和调用闭包，避免启动或typecheck仍要求Docker |
| Git与归档通过Docker的withStableFiles防后台并发写 | task-composition.ts的Git withWorktree及归档protect | R02/R03：本机必须提供实测稳定性/失效拒绝，不能用空回调替代 |
| WorkspaceAdapter本身通过execution capability组合，且验证taskRoot归属 | workspace-adapter.ts | 复用契约与补偿逻辑；用户项目/direct语义由12.2/12.4适配，不删安全检查 |
| Next external与桌面打包另有Docker列表 | next.config.ts、package.mjs、build-resources.ts | R05：核对最终资源闭包和包hash，依赖声明清空并不足够 |
| 桌面已有受管state root、owner、格式1和新Keychain service；Web仍有cwd数据根fallback | desktop storage/service/desktop-app；Web message-runtime/local-startup/task-runtime | 新状态入口以桌面canonical root唯一注入；守住已发布桌面升级连续性；撤掉旧CLI产品路由 |
| Phase7/8场景复用Phase6，Phase9出口复用scenario；测试文件不写Docker也可能间接依赖 | `tests/evals/phase6/scenarios.ts`、phase7/8 scenarios、phase9 scenario及出口 | 迁移按调用链验收，不能只凭文本命中决定删测试 |
| 默认pnpm test含tests/evals下*.test.ts；Phase10 benchmark测试导入真实Docker driver/verifier | vitest.config.ts、phase10-benchmark.test.ts、final目录 | V08/V09：保留默认覆盖；Docker专属image/mount组件可退役，正式付费Benchmark不自动恢复 |
| Dockerode传递链含docker-modem/ssh2等，部分压缩/网络库可能被其他组件共享 | pnpm-lock.yaml | 包管理器重算剩余依赖图；共享依赖不按名称删除 |

## 4. 冲突评审与边界

未发现必须由Leader重新选择“是否保留Docker或兼容旧任务”的矛盾；蓝图D18已明确否定。既有Docker安全规则与新本机规则按阶段适用，当前依赖/README含Docker属于尚未实施13.3的现状，不在12.1伪改为已完成。

“从新状态开始”与“新桌面升级保留状态”分属旧Docker产品/新桌面版本，不冲突；§12.3.11.2显式区分，防止13.3误删Phase11配置或Phase12新任务。旧CLI产品入口退役、共享local-process控制与Keychain保留是已获Leader接受的工程收敛方案，由13.3实施。

12.2权限强制机制、direct文件版本类型、workspace授权schema及13.2工具/服务停止协议仍由已登记任务定稿。本轮只明确必保留结果和最晚验收点，没有声称机制已确定或授权普通项目执行。未新增依赖、产品代码、测试、执行脚本或延期项。

## 5. 文件级清点（直接命中）

扫描范围为Git跟踪的非文档/工作流文件；大小写不敏感匹配`docker|containerId|containerName|/workspace`，锁文件另外核对。下列70个文件是基线观测；行号与hash来自该基线。命中包含注释、历史数据和测试题面，不代表全删；间接调用关键位置见机器清单。13.3实施时须重扫全部调用者并提交逐用例替代账目。

| 路径 | 命中行（最多前8项） | 处置映射 |
| --- | --- | --- |
| `README.md` | 19, 21, 35, 117, 138, 144, 156, 157 … | R07 当前指引更新；阶段历史保留 |
| `apps/desktop/scripts/package.mjs` | 50 | R05 打包闭包移除 |
| `apps/desktop/src/build-resources.ts` | 32 | R05 打包闭包移除 |
| `apps/web/next.config.ts` | 5 | R05 打包闭包移除 |
| `apps/web/package.json` | 26 | R04 移除专用依赖声明 |
| `apps/web/scripts/local-diagnostics.mjs` | 32, 34, 46, 49 | R06 旧产品入口退役；共用受信组件保留 |
| `apps/web/scripts/local.mjs` | 151 | R06 旧产品入口退役；共用受信组件保留 |
| `apps/web/src/server/task-composition.ts` | 40, 96, 121, 122, 128, 130, 131, 132 … | R02 装配/恢复/稳定文件与归档接缝替换 |
| `apps/web/test/local-diagnostics.test.ts` | 20, 34, 43, 44, 47, 48, 71, 72 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `apps/web/test/orchestration-flow-docker.test.ts` | 1, 8, 20, 21, 22, 25, 31, 41 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `apps/web/test/orchestration-flow.test.ts` | 1, 4 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/core/__tests__/e2e/phase0-runtime.ts` | 72 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/core/__tests__/e2e/phase1-runtime.ts` | 48 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/roles/definitions/src/runtime-contracts.ts` | 24 | R03/R07 保留通用能力；按新实现更新环境说明 |
| `packages/runtime/sandbox/package.json` | 18, 21 | R04 移除专用依赖声明 |
| `packages/runtime/sandbox/src/docker-sandbox.ts` | 6, 7, 24, 35, 36, 39, 47, 48 … | R01 删除Docker实现；共享语义迁移 |
| `packages/runtime/sandbox/src/factory.ts` | 1, 2, 3, 8, 15, 21, 23, 28 … | R01 删除Docker类型/导入/配置与导出 |
| `packages/runtime/sandbox/src/index.ts` | 1, 9 | R01 删除Docker类型/导入/配置与导出 |
| `packages/runtime/sandbox/src/local-temp-sandbox.ts` | 22 | R03/R07 保留通用能力；按新实现更新环境说明 |
| `packages/runtime/sandbox/src/path-guard.ts` | 14 | R03/R07 保留通用能力；按新实现更新环境说明 |
| `packages/runtime/sandbox/src/sandbox-manager.ts` | 8 | R03/R07 保留通用能力；按新实现更新环境说明 |
| `packages/runtime/sandbox/test/docker-isolation.test.ts` | 1, 16, 18, 29, 30, 31, 41, 89 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/runtime/sandbox/test/docker-sandbox.test.ts` | 4, 6, 9, 13, 14, 15, 16, 19 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/runtime/sandbox/test/factory.test.ts` | 2, 6, 8, 19, 20, 21, 24, 26 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/runtime/sandbox/test/workspace-adapter.test.ts` | 1, 13, 14 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `packages/tools/git/src/git-service.ts` | 159 | R03/R07 保留通用能力；按新实现更新环境说明 |
| `pnpm-workspace.yaml` | 20, 22 | R04 移除专用依赖声明 |
| `tests/evals/fixtures/phase10/Dockerfile` | 7 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/fixtures/phase10/README.md` | 3, 6, 8 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/benchmark-image.test.ts` | 1, 2, 9, 14, 17, 18, 23, 24 … | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/benchmark-image.ts` | 1, 4, 5, 10 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/holdout-preflight.eval.ts` | 4, 16, 17, 19, 23, 25, 58 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/holdout-verifier.ts` | 4, 10, 18, 19, 86 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/manifest.ts` | 129 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/multi-driver.ts` | 12, 25, 44, 107, 147, 170 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/preflight.eval.ts` | 6, 21, 22, 24, 25, 72, 74 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/single-driver.ts` | 4, 11, 15, 23, 24 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/task-container.test.ts` | 4 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/task-container.ts` | 3 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/final/verifier.ts` | 4, 15, 22, 23, 98 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/go-flow-diagnostic.eval.ts` | 5, 27, 28, 30, 35, 128, 189, 199 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/local-keychain-live.eval.ts` | 2, 13, 80, 81, 82, 85 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/local-launcher.eval.ts` | 1, 14, 251, 252, 255 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/model-connection.eval.ts` | 2, 10, 57, 58, 59, 62 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase10/run-final-benchmark.eval.ts` | 6, 43, 44, 50, 165, 275, 337, 391 … | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase6/run-phase6-baseline.eval.ts` | 9, 11, 30, 31, 32 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase6/scenarios.ts` | 20, 33, 41, 42, 47, 48, 56, 100 … | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase6/tasks.test.ts` | 7, 51, 58, 60 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase7/baseline-summary.json` | 12 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase7/run-phase7-baseline.eval.ts` | 10, 20, 30, 31 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase7/scenarios.ts` | 28, 100, 101 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase7/tasks.test.ts` | 78 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase8/run-phase8-baseline.eval.ts` | 10, 20, 30, 31 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase8/scenarios.ts` | 37, 51, 53 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase8/tasks.test.ts` | 71 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase9/phase9-live-flow.eval.ts` | 8, 21, 22, 23, 44, 153 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase9/run-phase9-baseline.eval.ts` | 6, 10, 21, 35, 36, 37, 75, 155 … | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/evals/phase9/scenario.ts` | 12, 49, 50, 51, 52, 91, 187, 314 | R09/V08–V09 沿调用图迁移执行；仅Docker专属退役；历史数据保留 |
| `tests/integration/phase1/phase1-exit.test.ts` | 8, 9, 31, 38, 124, 213, 214, 215 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase10/phase10-benchmark.test.ts` | 1, 5, 47, 48, 56, 142, 162, 195 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase10/phase10-exit.test.ts` | 2, 19, 37, 38, 72, 109, 145, 187 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase10/phase10-model-settings.test.ts` | 1, 14, 77, 78, 79, 86 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase10/phase10-resilience.test.ts` | 2, 10, 92, 95, 96, 97, 104 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase5/phase5-exit.test.ts` | 2, 11, 396, 402, 412, 414, 415, 416 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase6/phase6-exit.test.ts` | 4 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase9/phase9-exit.test.ts` | 2 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase9/phase9-filesystem-boundary.test.ts` | 1, 18, 19, 26, 34, 37, 38, 40 | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase9/phase9-parallel-flow.test.ts` | 2, 11, 22, 23, 294, 310, 726, 770 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `tests/integration/phase9/phase9-worktree-integration.test.ts` | 1, 17, 26, 28, 29, 30, 33, 34 … | R08/V01–V10 按断言迁移；低阶段及共享语义保留 |
| `vitest.config.ts` | 6 | 测试匹配与串行策略保留；环境说明按新实现更新 |

## 6. 设计阶段验证与接受条件

本轮文档Check通过：87份源码hash一致，直接扫描覆盖70/70，11个新增相对链接与目标锚点有效；索引check有效（171任务/31阶段/25决策/67历史），git diff --check通过，改动仅docs且仅12.1任务状态变更。完整结果归[任务历史](../task-history/12.1.md)。未执行pnpm typecheck/lint/test、真实模型、Docker、本机产品G5或打包Spike；纯文档Check按追踪规范适用，不冒充代码/出口门禁。后续请求commit时仍须agora-commit完整门禁。

Leader于2026-09-15回复“确认”，已接受完整设计，12.1按纯设计任务规则收尾为done。接受固定退役清单与回归替代方案；不自动开工12.2/13.3、删除用户数据、提交/推送或发布。接受记录见任务历史；当前任务状态以task-status.json为准。

## 7. 提交门禁

2026-09-15用户调用agora-commit后，typecheck/lint通过；完整pnpm test为Node7/7、Vitest189文件1340项全部通过，0失败/跳过。真实Go链与当前Docker回归均实际运行，不代表13.3/13.4未来本机验收。完整命令、环境、源码与日志双hash见[门禁结果](task121-delivery-evidence/results.json)，测试临时目录清理及8个占用目录保留原因见[回执](task121-delivery-evidence/cleanup.json)。PR/提交身份记入任务历史。
