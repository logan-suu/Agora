---
description: 快速查看 Agora 项目当前状态（阶段、任务、进度、里程碑）
agent: build
---

## 📊 项目状态速览

请读取 `docs/task-status.json`，输出以下信息：

### 全局概览
- 当前阶段：Phase X - [阶段名称]
- 整体进度：已完成 X / 总任务数 60 — XX%
- 当前阶段状态：[in_progress / not_started / done]
- 常驻决策：N 条 standing_decisions 生效中

### 当前阶段任务统计
| 状态 | 数量 |
| --- | --- |
| 总任务数 | X |
| ✅ done | X |
| 🔄 in_progress | X |
| ⏳ ready | X |
| ⬜ pending | X |

- 进度百分比：XX%

### 下一个 ready 任务
- **如果存在**：`[任务ID] - [任务标题]`
- **如果不存在**：
  - 检查是否有 `in_progress` 任务 → 提示"当前有进行中的任务：[任务ID]"
  - 如果该阶段全部完成 → 提示"🎉 当前阶段所有任务已完成！请运行出口集成测试 `[integration_test 任务ID]` 后进入下一阶段。"

### 阶段出口标准
- 从 task-status.json 当前 phase 的 `exit_criteria` 字段逐条列出

### 里程碑进度
- 对照 `milestones` 数组，列出最近一个未达成里程碑（M-X / 交付物 / 目标周）

### 当前 Git 状态
- 执行 `git branch --show-current` 与 `git status -sb` 获取分支与领先/落后情况

### 最近更新
- `last_updated` 时间戳 + 最近 3 个有 notes 更新的任务
