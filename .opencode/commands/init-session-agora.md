---
description: Agora 新会话初始化 — 读取规约、定位进度、锁定规格上下文、等待确认后开工
agent: build
---

## 🚀 新会话启动：Agora 项目初始化

这是一个全新的会话，之前的对话历史不在上下文中。

请严格按照以下步骤执行初始化（AGENTS.md 要求的 EPCC-V 流程），在确认状态前**不要**开始编写任何代码：

### 第一步：读取核心规约与地图
1. 读取项目根目录下的 `AGENTS.md`（项目宪法，定义常驻决策 D1-D5/C4/FE/WO 与红线 R1-R13）。
2. 建立文档地图（规格唯一来源，全部在 `docs/` 下）：
   - `docs/项目蓝图.md`：唯一主文档，§21 已定决策定稿
   - `docs/详细设计方案.md`：落码规格（State schema §1 / 角色 §2 / 编排 §3 / 抢占 §4 / 通信 §5 / 执行器与沙箱 §6 / 投影 §7 / 多租户与 KB §8 / 阶段 0 切片 §9）
   - `docs/系统架构设计文档.md`：L1-L4 分层 / Monorepo 映射 / 关键路径 / 韧性表
   - `docs/技术选型文档.md`：版本锁定（TS5.9+/Node20/pnpm9/Harness/MCP v1/Vitest/Biome2.x）
   - `docs/开发计划安排.md`：Phase 0-10 任务分解
   - `docs/框架调研与借鉴决策.md`：8 个借鉴模式（实现对应机制时必读）
   - `docs/task-status.json`：11 phase / 60 任务 / 依赖图 / standing_decisions

### 第二步：定位当前进度（任务溯源）
3. 读取 `docs/task-status.json`。
   - **级联更新 pending → ready**：遍历所有阶段中 `status: "pending"` 的任务，若其 `dependencies` 全部为 `done`，则翻转为 `ready`。
   - **如果用户指定了任务 ID**（如"我想做 0.4"），优先使用该任务。
   - **如果用户未指定**：
     - 找出 `current_phase` 对应的阶段。
     - 找到该阶段中第一个 `status: "ready"` 的任务；若无则检查是否有 `in_progress` 的中断任务；若都没有，列出该阶段所有 `pending` 任务让用户选择。
   - 确认该任务的 `dependencies` 是否已全部 `done`。
   - 输出当前阶段、任务 ID、标题。

### 第三步：锁定规格上下文（防幻觉）
4. 读取该任务 `documents_required` 字段中列出的文档章节。
5. 从 `standing_decisions` 中筛出与本任务相关的条目（如执行器任务→D2/D4；沙箱任务→D5；投影任务→D1/WO）。
6. 按以下格式输出上下文摘要：

```markdown
## 📋 任务上下文锁定

### 任务信息
- **任务 ID**：[任务ID]
- **标题**：[任务标题]
- **阶段**：Phase X - [阶段名称]

### 关键约束原文（逐字粘贴）
> [从 documents_required 文档与 standing_decisions 摘取的原文]

### 相关常驻决策
- [D-x]：[一句话规则]

### 依赖状态
- [依赖任务1]：✅ done
- [依赖任务2]：⏳ pending

### 参考文档
- `docs/...`
```

7. **快速一致性检查**：对照红线 R1-R13，若发现冲突立即标记并等待用户确认。

### 第四步：状态确认与开工
8. 总结当前认知。
9. 等待我确认"开始执行"后：
   - 将 `docs/task-status.json` 中该任务 `status` 更新为 `in_progress`。
   - 再遵循 EPCC-V 流程：Explore → Plan → Code → Check → Verify。

请开始执行初始化。
