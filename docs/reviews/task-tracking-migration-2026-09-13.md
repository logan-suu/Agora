# 研发任务索引与历史迁移记录（2026-09-13）

Leader 已明确批准“按照更适合长期开发的建议进行整理和优化”，验证完成后另行授权“提交推送变更”。本次范围为研发任务追踪、查询工具和 Agent 工作流；不增加产品阶段或任务，不改变产品运行时、依赖版本、测试排除项或既有功能验收结论。交付分支为 `chore/task-tracking-context`，PR 目标为 `dev-1.0.0`，由人类审阅合并；实际提交与交付状态以 Git 和 PR 为准。

## 来源与方案

来源定义依次同步：项目蓝图 §21 的 2026-09-13 决策 → 详细设计 §0 查询契约 → 开发计划维护说明/任务索引 → AGENTS.md v2.15 与 14 个项目 Skill。14 个 OpenCode 兼容命令保留原入口与 frontmatter，转为委托对应的主 Skill，移除重复旧工作流，避免重新要求全量读取。

`task-status.json` 保持唯一当前状态/依赖/阶段出口/决策摘要索引；任务 notes 仅留短摘要及历史引用，完整执行和失败证据按任务保留。23 条 rule 压缩为导航摘要，ID/source 未变，原摘要另存固定历史快照；完整规则仍从原来源章节读取。既有 GIT-DEV 直推豁免未扩大到历史文件。

## 无损迁移审计

- Git 基线：`fa3efafed328bdfeb5b0f575b4e57bbd248a45fd`。
- 61 个原 notes 逐字保存在 `docs/task-history/<id>.md` 的固定迁移区，保留真实换行、字面 `\n`、历史状态、失败、费用与证据链接。
- 原 notes 各自 SHA-256 存在文件头，并由 `standing-decisions-2026-09-13.json` 的独立迁移清单再次绑定；`check` 会拒绝缺失引用、缺失/重复标记或哈希不符。
- 23 条迁移前决策摘要完整保存在同一历史快照，摘要数组及 notes 清单均有 SHA-256。
- 对 Git 基线独立比较通过：除顶层 version/usage/last_updated、任务 notes 和决策 rule 外，全部结构相同。61 个任务的状态、标题、依赖、时间戳、规格与测试入口、11 个阶段的状态/出口、current_phase、baseline 和全部里程碑未改变。
- 当前仍为 Phase 10，61 项任务全部 done；M0–M4 的历史 pending 元数据如实保留，无自动修正。
- 92 个 required/source/test 本地文件路径存在；既有 test_file 中逗号或加号分隔的多路径逐项核验。未将整段多路径字符串误当单个文件，也未改变其内容。
- 原历史链接逐字保留；本次未重新联网验证每个历史外链，不将其存在性等同于远端内容仍有效。

原始机器审计结果：`.data/verification/task-tracking-20260913/migration-audit.json`。完整查询与维护方式见 [task-tracking.md](../task-tracking.md)。

## 读取成本（UTF-8 字节，不是 tokenizer 实测）

| 入口 | 字节数 |
| --- | ---: |
| 迁移前完整索引 | 576347 |
| 迁移后完整索引 | 68044 |
| `summary` | 2027 |
| `task 10.7` | 2159 |
| `phase 10` | 1833 |
| 全部短决策 `decisions` | 8619 |
| `history 10.7` 默认末页 | 10457 |

完整索引减少约 88.2%；初始化返回约 2 KiB。历史总存储没有被删除，查询按需输出避免默认加载；不能将字节比例直接宣称为精确 token 或费用降幅。

## 验证

- `node --test scripts/test/task-status.test.mjs`：7 项通过、0 skip。覆盖依赖就绪查询不写状态、前阶段出口、未知参数/ID拒绝、依赖缺失/环/重复 ID、摘要上限、Unicode 分页与省略标记、原文篡改/标记删除/引用移除、追加新历史、从其他 cwd 调用及错误退出码。
- TDD：先建立测试，查询模块尚不存在时失败；实现后修正测试字符串的码点计数（“头🙂中间尾”是 5 个码点），分页语义断言保留并通过。随后新增历史损坏及 CLI 真实执行用例。
- `node scripts/task-status.mjs check`：61 tasks / 11 phases / 23 decisions / 61 histories 通过。
- `pnpm typecheck` 通过；`pnpm lint` 检查 430 文件，0 违规。
- 14 个 Skill 全部通过系统 `quick_validate.py`，维护规范相对链接存在；兼容入口均能定位唯一主 Skill。
- 敏感信息扫描：最初 99 个变更/新增文件使用 Gitleaks 扫描，0 findings；最终文件复核见下方补记。
- 查询入口真实运行不依赖模型、Docker 或 npm 依赖，成功从其他 cwd 读取仓库。它只是研发查询工具，不构成产品全链路重新验收。

## 完整回归与授权记录

首次 `pnpm test` 已运行新增 Node 测试（7/7）及原 Vitest 套件；受限进程出现 Docker socket `connect EPERM` 和 localhost `listen EPERM`，不属于本次查询代码失败。保留 `.data/verification/task-tracking-20260913/full-test.log`。确认 Vitest 及其 worker 无 TCP 连接后，仅向本次 Vitest 主进程发 SIGINT 收敛，退出码 130；不宣称全量通过，不改断言、不排除文件或移除凭据。

随后请求以本机所需权限重跑完整 `pnpm test`，自动审批拒绝：包含现有真实模型请求及本机服务，可能向未明确授权的模型目的地发送测试输入并产生费用，认为本次整理授权未覆盖此范围。未绕过拒绝、未执行该次外发；已向 Leader 明确询问完整回归授权。

Leader 随后明确回复“授权完整回归”，授权问题中已说明 Docker、本地服务、既有真实模型测试、向配置模型服务发送测试输入及可能产生 API 费用。以本机所需权限重跑原命令，保留全部测试和凭据；日志单独保存为 `.data/verification/task-tracking-20260913/full-test-host.log`，不覆盖首次环境失败记录。

本机权限重跑退出码 0：新增 Node 测试 7/7，原 Vitest 测试文件 170/170、测试 1282/1282 全通过（Vitest 129.65s），没有 skip。包含 Docker/本地服务、真实 Harness 并行链路及 live DeepSeek LRU cache 端到端用例；未单独运行付费 Eval。本次只对研发追踪工具增加测试，既有产品测试范围保持。

日志 SHA-256：

- `full-test-host.log`：`2d467d8d70d0313cdb099d8c76c61f44b0f7c3b8d71854179d580accd739a0c1`。
- `full-test.log`（首次权限失败，退出 130）：`fb67ad27255c362cfb0ff8a502f04d1fbc6c0f4c0814c5eb631a1e00b3775ccd`。

## 最终复核

最终对本次 100 个变更/新增文件（含本报告）执行 Gitleaks，0 findings；扫描不包含本机凭据或运行时目录，日志为 `.data/verification/task-tracking-20260913/gitleaks-final.log`。迁移完整性、查询 `check` 与 `git diff --check` 再次通过。任务当前状态保持不变，本次维护不重新开启任何已完成产品任务。
