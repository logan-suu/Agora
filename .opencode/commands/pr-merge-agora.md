---
description: PR 合并后的任务收尾 — 同步 dev-1.0.0、标记任务 done、级联翻转与阶段收尾检查
agent: build
---

## 🔀 PR 合并收尾

### 第一步：确认合并状态
1. 如果用户给了 PR 编号：`gh pr view {number} --json state,mergeCommit,url`。
2. 未给编号：`gh pr list --state merged --limit 5` 列出最近合并的 PR，或从 `docs/task-status.json` 任务 notes 中记录的 PR 链接查找。
3. 确认 `state == "MERGED"`；仍是 OPEN/DRAFT 则输出："PR 尚未合并，等待人工审阅。"并退出（**Agent 不得自动合并 PR**）。

### 第二步：同步本地集成分支
4. `git checkout dev-1.0.0 && git pull origin dev-1.0.0`
5. 清理已合并的本地功能分支：`git branch -d {branch}`（拒绝删除时说明尚未合并进当前分支）。

### 第三步：更新任务状态
6. 更新 `docs/task-status.json` 中该任务：
   - `status` → `done`
   - notes 追加：合并 hash（merge commit）、G5 实测结论、遗留/延期项及解除条件
7. 更新任务与文件顶层 `last_updated`。

### 第三步之半：提交并推送（豁免直推）
8. 纯 `docs/task-status.json` 任务状态收尾记录（status/last_updated/notes）允许**直接在 `dev-1.0.0` 上提交并推送**，不走功能分支/PR（§3.1.1 豁免，[2026-08-26]）。步骤：
   - `git add docs/task-status.json`
   - `git commit -m "Mark task {id} done after PR #{n} merge"`（英文祈使句，可带 body）
   - `git push origin dev-1.0.0`
   - **禁止**在同一提交里夹带任何代码变更（`packages/`/`apps/`/`tests/` 等源码）；代码变更必须另走功能分支 + PR + 人类合并。

### 第四步：级联翻转与阶段收尾
9. **级联翻转（幂等）**：遍历所有 `pending` 任务，依赖全部 `done` 者翻转为 `ready`。
10. **阶段收尾检查**：若该 phase 所有非 integration_test 任务已 done：
    - 提示运行 `/test-phase-agora` 执行出口集成测试；
    - 出口测试 done 且 `exit_criteria` 全满足 → 整 phase `status` → `done`、`current_phase` 递增、提示下一阶段首个 ready 任务。

### 第五步：报告
11. 输出收尾报告：
    ```
    PR #{n} 已合并 ✅
    任务 {task-id} → done（merge commit: {hash}）
    级联翻转：{翻转到 ready 的任务列表，或"无"}
    阶段进度：Phase {N} — X/Y done
    下一步：{建议}
    ```
