# 研发任务追踪维护

来源：蓝图 §21 的 **2026-09-13 研发任务追踪按需读取** 决策；查询契约见详细设计 §0。本文件描述 Agora 仓库的研发流程，不是产品运行时的 TaskState。

## 唯一来源与历史

| 内容 | 唯一维护位置 | 读取时机 |
| --- | --- | --- |
| 当前任务状态、依赖、阶段出口、里程碑 | `docs/task-status.json` | 摘要或指定任务/阶段查询 |
| 当前决策摘要目录 | 同文件的 `standing_decisions` | 先看 ID，按任务选择规则 |
| 决策完整定义 | 每条决策的 `source` 来源章节 | 相关实现/评审前必读 |
| 完整任务执行、失败、修复、验证、交付历史 | `docs/task-history/<taskId>.md` | 恢复、调查、阶段验收、交付收尾 |
| 详细评审、实测报告和原始日志引用 | 已有 `docs/reviews/`、`docs/evals/` 等证据文件 | 历史引用要求核验时 |
| 延期项当前状态 | `docs/deferred-items.json` | 相关任务或阶段出口 |

完成任务保留在索引中，不另建一份 active/done 状态表。任务历史只描述当时事实，不能从历史“待合并”“in_progress”推断当前状态；也不能由历史延期说明覆盖延期台账。迁移前的决策摘要位于 `task-history/standing-decisions-2026-09-13.json`，明确是固定历史快照，不能作为新的规则索引。

## 无依赖查询入口

```bash
node scripts/task-status.mjs summary
node scripts/task-status.mjs task 10.7
node scripts/task-status.mjs phase 10
node scripts/task-status.mjs decisions D4 D16 D17
node scripts/task-status.mjs history 10.7
node scripts/task-status.mjs history 10.7 --offset 0 --limit 4000
node scripts/task-status.mjs check
```

`summary` 是默认操作；也可用 `pnpm tasks summary`。脚本只依赖 Node 内置模块，从脚本位置定位仓库，从其他目录运行绝对路径也有效；不依赖 pnpm、模型服务、Docker 或工作区 npm 依赖。

初始化不要 `cat docs/task-status.json` 或批量读取全部历史。`summary` 返回状态统计、当前阶段出口、进行中/阻塞任务、首个 ready、可级联 ID、未完成里程碑和决策 ID。旧里程碑可能保留历史状态，输出如实展示，禁止根据阶段完成自行“纠正”无关记录。无 ready/in_progress 时报告现状，不虚构新阶段或重开 done 任务。

`task` 返回完整单任务索引字段、直接依赖状态及前一阶段出口，历史路径按 ID 派生。`phase` 返回该阶段出口和短任务列表。`decisions` 无参数返回全部短规则，带 ID 时只返回指定规则；摘要不能替代 source 原文，必须结合 AGENTS.md §0.2 选择相关规格。

`history` 默认输出最近 6000 个 Unicode 码点；`--offset` 从 0 起、`--limit` 为 1–12000。响应给出 `totalCharacters`、`offset`、`omittedBefore`、`omittedAfter`、`previousOffset`、`nextOffset`，省略范围是显式的。恢复任务先读当前 notes 和历史末页，再向前追读所需 checkpoint；原 notes 中已有大量时点记录，末页不等于完整门禁证据。也可对单个历史文件 `rg` 定位关键字，再读取相关段落。不得将分页结果当完整记录。

所有命令只读，输出不保存为第二份索引。`cascadeCandidates` 只代表依赖全部 done 的 pending 任务；既有初始化/next-task/合并收尾工作流对它们执行幂等级联，更新受影响任务和顶层时间戳后重查摘要。开始 Phase N 前仍须独立核对 Phase N-1 出口与 current_phase，不得将依赖就绪当跨阶段授权。

## 写入规范

1. **索引短摘要**：notes 最多 800 码点，只保留当前结论、下一步/阻塞解除条件、关键验收及 PR/merge 身份和证据路径。已有任务迁移摘要只指向完整证据，不根据 status=done 重新推断所有门禁。日常更新替换旧摘要，不持续追加日志。
2. **历史追加**：首次产生执行记录时创建 `docs/task-history/<id>.md` 并在 notes 引用；按日期/事件追加用户授权范围、当前检查点、失败及根因、实际命令/结果、证据路径、PR/提交及延期引用。完整报告只链接，不重复复制；API Key 等敏感信息不得写入。
3. **先证据后状态**：先写并核验历史/外部证据，再更新 notes、状态及相应 last_updated；执行 `check`。若中断，仅有历史不代表状态已推进，恢复时复核 Git 与门禁后再收敛。不要为此引入第二份写入队列或数据库。
4. **新任务**：继续使用现有字段白名单和全局唯一 ID，加到已批准的阶段中。开始前验证依赖和前阶段出口；无执行历史的任务可以暂不创建历史文件。禁止自动批准后续产品路线。
5. **决策**：rule 最多 500 码点，保留核心当前规则和精确 source，不追加历次调试/费用/PR记录；变更完整定义仍先经过 agora-sync-docs 同步来源。
6. **交付**：提交和阶段验收须从相关历史追读完整 G1–G7 证据；短 notes 不是门禁豁免。常规实现 PR 同步交付详细历史，合并后 notes 可短记 merge hash 并引用既有证据。GIT-DEV 直推豁免仅限 task-status.json 收尾且 push 须授权；若新增/修改历史文件则走正常分支/PR。

旧文档中的“任务 notes/执行记录/最新门禁”均按“短摘要及其历史、证据引用”理解，历史文档不逐条改写。原状态机、G1–G7、R1–R13、人类批准与合并规则保持。

## 迁移与校验

2026-09-13 的 61 个原 notes 在各历史文件的 `BEGIN/END ARCHIVED NOTES` 区逐字保存，包括原有换行、字面 `\n`、链接、失败与旧状态说明；外层围栏仅便于阅读，不属于原 notes。原文 SHA-256 同时保存在文件头和固定迁移清单中，禁止修改迁移区，后续记录只追加。原始 Git 基线、摘要快照与迁移清单哈希保留在 `standing-decisions-2026-09-13.json`。

`check` 验证依赖引用/无环、ID/状态/阶段出口、notes/rule 长度、历史路径身份及迁移区哈希；它不验证远端 PR、运行测试，也不宣称所有 Markdown 外链实时可用。当前迁移的源文本和非迁移字段须额外与 Git 基线逐项比对，实测结果见 [本次维护证据](reviews/task-tracking-migration-2026-09-13.md)。

查询工具回归：`pnpm test:task-tracking`；完整 `pnpm test` 先执行该组 Node 测试，再执行原 Vitest 全量回归，不排除既有真实模型测试，不增加付费 Eval。
