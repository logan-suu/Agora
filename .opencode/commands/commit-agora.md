---
description: 质量门禁检查 → 提交推送 → 更新任务状态为 done（Agora 直推 main 工作流）
agent: build
---

## 🚀 提交推送与任务收尾

### 第一步：前置检查
1. **Git 状态**：执行 `git status`，确认有变更可提交；没有则输出"当前没有可提交的变更。"并退出。
2. **敏感文件扫描**：确认暂存内容不含 `.env`、密钥、token、`*.pem`、`.data/`、沙箱临时目录（R13/G7）。`.gitignore` 应已拦截，发现漏网立即补规则。
3. **文档一致性（G1）**：确认本次实现与设计文档/常驻决策不冲突；如有决策级偏离，先执行 `/sync-docs-agora` 同步文档再回来。

### 第二步：质量门禁（强制，不过不提交）
| 门禁 | 命令 | 要求 |
| --- | --- | --- |
| G3 静态检查 | `pnpm typecheck && pnpm lint`（scripts 未建立前 `pnpm exec tsc --noEmit` + `pnpm exec biome check .`） | 0 错误 |
| G4 测试全绿 | `pnpm test`（即 vitest run） | 全部通过，含既有回归 |
| G5 执行链路实测 | 视任务而定 | 沙箱/Harness/工具能力真实跑通，不以 mock 规避 |
| G7 安全合规 | 人工核对 diff | agent 产出的代码只在沙箱内执行；无明文敏感数据 |

任何门禁失败：分析根因（业务 bug→修代码；测试有误→修测试），修复后重跑。**禁止**弱化断言绕过（R11）。

### 第三步：Git 提交
1. 提交信息遵循仓库既有风格（英文一句话祈使句，PLAIN 风格，参考历史："Add .gitignore"、"Document 5 architecture decisions"）：
   ```
   {英文祈使句描述}

   - change point 1 (English, optional body)
   - change point 2

   Task: {task-id}
   ```
2. 精确 `git add` 相关文件（避免盲加无关产物）；提交前 `git diff --staged --stat` 复核。
3. 执行提交；随后 `git push`（当前分支 main 直推；如用户明确要求走 PR，用 feature 分支 + `gh pr create --base main`，PR 标题正文全部英文）。

### 第四步：更新任务状态
1. 推送成功后，更新 `docs/task-status.json`：
   - 当前任务 `status` → `done`
   - `notes` 追加：提交 hash、关键实现摘要、自检结论（G5 实测结果）、遗留/延期项及解除条件
   - 更新任务的 `last_updated` 与文件顶层 `last_updated`
2. **级联翻转**：因本任务完成而依赖全部满足的 `pending` 任务翻转为 `ready`。
3. **阶段收尾检查**：若该 phase 所有非集成测试任务已 done：
   - 提示运行 `/test-phase-agora` 执行出口集成测试
   - 出口测试 done 且 `exit_criteria` 全满足 → 整个 phase `status` → `done`，`current_phase` 递增，提示下一阶段首个任务
4. 输出收尾报告：提交 hash / 任务状态变化 / 下一步建议。
