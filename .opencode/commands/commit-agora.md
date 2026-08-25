---
description: 质量门禁检查 → 功能分支提交 → 创建 PR 到 dev-1.0.0（合并后由 /pr-merge-agora 收尾）
agent: build
---

## 🚀 提交与创建 PR

### 第一步：分支与前置检查
1. **分支检查（强制）**：执行 `git branch --show-current`。**禁止**在 `main` 或 `dev-1.0.0` 上直接提交功能代码。
   - 若在二者之上：先同步本地集成分支（`git checkout dev-1.0.0 && git pull origin dev-1.0.0`），再创建功能分支：
     ```bash
     git checkout -b {type}/{description}
     ```
     type ∈ feat/fix/docs/refactor/test/chore；description 简短英文 kebab-case。
   - 已在功能分支上则跳过。
2. **敏感文件扫描**：确认暂存内容不含 `.env`、密钥、token、`*.pem`、`.data/`、沙箱临时目录（R13/G7）。发现漏网立即补 `.gitignore` 规则。
3. **文档一致性（G1）**：实现与设计文档/常驻决策冲突？先执行 `/sync-docs-agora` 同步文档再回来。

### 第二步：质量门禁（强制，不过不提交）
| 门禁 | 命令 | 要求 |
| --- | --- | --- |
| G3 静态检查 | `pnpm typecheck && pnpm lint`（scripts 未建立前 `pnpm exec tsc --noEmit` + `pnpm exec biome check .`） | 0 错误 |
| G4 测试全绿 | `pnpm test`（即 vitest run） | 全部通过，含既有回归 |
| G5 执行链路实测 | 视任务而定 | 沙箱/Harness/工具能力真实跑通，不以 mock 规避 |
| G7 安全合规 | 人工核对 diff | agent 产出的代码只在沙箱内执行；无明文敏感数据 |

任何门禁失败：分析根因（业务 bug→修代码；测试有误→修测试），修复后重跑。**禁止**弱化断言绕过（R11）。

### 第三步：Git 提交
1. 提交信息遵循仓库既有风格（英文一句话祈使句 + 可选 body 要点）：
   ```
   {英文祈使句描述}

   - change point 1 (English, optional body)
   - change point 2

   Task: {task-id}
   ```
2. 精确 `git add` 相关文件（避免盲加无关产物）；提交前 `git diff --staged --stat` 复核。

### 第四步：推送并创建 PR
1. 推送：`git push -u origin {branch}`
2. 创建 PR，**base 分支为 `dev-1.0.0`**（非 main）：
   ```bash
   gh pr create --base dev-1.0.0 \
     --title "{type}: {english description} [Task {task-id}]" \
     --body "..."
   ```
3. PR 标题/body **全部英文**（外部可见语言规范），body 包含：
   - 实现摘要
   - 出口标准/约束对照表
   - G5 实测说明（如涉及执行链路）
4. 记录 PR 编号和链接。

### 第五步：更新任务状态（不标 done）
1. 任务 `status` **保持 `in_progress`**——PR 由人类审阅合并，合并后经 `/pr-merge-agora` 收尾标 `done`。
2. notes 追加：PR 编号链接 + 简要实现摘要。
3. 更新任务与文件顶层 `last_updated`。
4. 提示用户："PR 已创建。建议先执行 `/pr-review-agora {PR号}` 完成架构预审与评论处理；通过后由人类合并，合并后执行 `/pr-merge-agora` 收尾。"
