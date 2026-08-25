---
description: 快速阅读并总结当前任务对应的规格文档（约束原文、架构规则），不写代码
agent: build
---

## 📖 规格速读

请按 Agora 项目 `AGENTS.md` 的规格来源执行：

### 第一步：定位当前任务
1. 读取 `docs/task-status.json`。
2. 找到当前阶段中第一个 `status: "in_progress"` 或 `status: "ready"` 的任务。
3. 如果用户指定了任务 ID，优先使用用户指定的。
4. 如果没有找到任何任务：
   - 输出："当前没有进行中或待执行的任务。"
   - 列出当前阶段的所有任务状态概览。

### 第二步：映射文档章节
根据任务内容匹配《详细设计方案》对应章节（其余文档按 `documents_required` 字段）：

| 任务涉及 | 主要章节 |
| --- | --- |
| State/reducer/schema/合并函数 | 详细设计 §1 + 架构文档 §5 |
| 角色 prompt/RoleSpec/权限矩阵 | 详细设计 §2 |
| 编排/coordinator 路由/复杂度 Tier | 详细设计 §3 |
| worker 生命周期/抢占/安全点 | 详细设计 §4 + 框架调研 模式⑦ |
| Channel/消息总线/threadId/intent | 详细设计 §5 + 蓝图 §11 |
| Executor/Harness/MCP 工具/沙箱 | 详细设计 §6 + 选型 §4/§6/§7/§8 |
| 投影/压缩/三铁律/sliceKB | 详细设计 §7 + 蓝图 §8 |
| Project/KB/GlobalScheduler/humanGate 终止并分叉/收件箱 | 详细设计 §8 + 蓝图 §20 |
| 阶段目标/里程碑/时间线 | 开发计划安排 对应节 + task-status `exit_criteria` |
| 前端/SSE/UI 组件 | 选型 §9 + 蓝图 §10 |
| 部署/韧性/错误恢复 | 架构文档 §6/§9 |

同时读取任务 `documents_required` 中列出的全部文档。

### 第三步：读取并摘要
1. **逐字粘贴**关键约束原文（接口签名/schema 定义/决策规则，不要转述）。
2. 提取相关常驻决策（standing_decisions 中的 D-x/C4/FE/WO）与红线 R1-R13 条目。
3. 输出结构化摘要：
   - 任务 ID 与标题
   - 关键约束原文清单
   - 相关常驻决策
   - 红线检查项
   - 参考文档路径

### 第四步：确认与行动
4. 询问用户："是否确认理解无误？"
5. 提示："准备就绪。可执行 `/next-task-agora` 或 `/do-task-agora <id>` 开始编码。"
