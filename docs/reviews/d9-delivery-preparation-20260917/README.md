> **2026-09-17 PR范围更新：** 本目录保留此前D9独立提交及7路径外审的时点证据。Leader随后要求将D19正式方案/任务登记一并纳入PR #87，见[定稿记录](../langgraph-registration-20260917.md)。此后AGENTS.md的D19修改不在原CodeRabbit审查范围，原0issues结论不扩张到新设计。

# D9独立PR准备与外部审查范围

日期：2026-09-17。用户在“审查并准备D9修复PR，同时整理LG01正式变更清单”之后要求继续。本目录保留交付与审查证据；实现已提交、推送并发布[PR #87](https://github.com/logan-suu/Agora/pull/87)，等待人工合并。

## 可审阅结果

- 建议英文标题：**Fix idempotent replay after human-gate resumption**。
- 目标分支：`dev-1.0.0`；当前功能分支：`codex/fix-human-gate-replay`。
- [PR正文与13文件范围](https://github.com/logan-suu/Agora/pull/87/files)；[固定实现提交](https://github.com/logan-suu/Agora/commit/c41c3e6a8c0c45e581cb0302f1043151d7515b9b)。旧独立patch、清单和正文草稿已由远程记录替代并清理。
- [自包含验证记录](../d9-replay-pr-preparation.md)随补丁交付；已有门禁结果及六份代码hash已核对，无新增产品变更，未重复真实模型测试。
- LG01正式规格变更、证据缺口、任务登记模板已纳入[方案§29](../../langgraph-harness-design.md#section-29)，不随该D9补丁切换产品路线。

补丁基于`55d6385a8387634864886dfdec38a8d9b1fa804e`，通过`git apply --cached --check`检查，**该命令未写暂存区**。它仅包含六份代码/测试、四份正式来源文档、task-status/12.3历史的D9局部投影以及一份验证记录。局部投影保留基线历史和原done状态，排除独立LangGraph研究追踪；原工作区文件不被覆盖。

上述补丁检查为提交前记录；本地patch已精简，最终交付以远程固定提交为准。Leader随后明确授权提交/推送并创建PR；人工合并仍未进行。

## CodeRabbit完成结果与已批准范围

CLI版本0.7.6；普通沙箱报告未认证，宿主环境认证正常。最初全部未提交/未跟踪材料外传被自动审批在进程启动前拒绝。Leader随后明确允许下列范围；隔离仓库首次调用缺少默认基线，指定review-baseline后审查完成，退出0。**CodeRabbit raised 0 issues.** 完成事件列出全部6份代码/测试文件；AGENTS.md作为配置。机器结果、必要失败与日志hash见[coderabbit-review.json](coderabbit-review.json)。

已批准且实际采用的范围：下列**7个路径的当前内容，以及其中4份已跟踪代码的HEAD基线版本/差异**，合计361116字节。目的地为已认证的CodeRabbit服务（US区域）；源码已按此范围送审。完整hash/字节数见[review-scope.json](review-scope.json)。

| 路径 | 范围 |
| --- | --- |
| `apps/web/src/server/human-gate-replay.ts` | 新文件当前内容 |
| `apps/web/src/server/message-runtime.ts` | 基线与当前内容/差异 |
| `apps/web/src/server/task-orchestration-runtime.ts` | 基线与当前内容/差异 |
| `packages/core/orchestration/src/human-gate.ts` | 基线与当前内容/差异 |
| `packages/runtime/executor/src/harness-executor.ts` | 基线与当前内容/差异 |
| `apps/web/test/human-gate-replay.test.ts` | 新文件当前内容 |
| `AGENTS.md` | 当前项目约束，作为审查配置 |

已核对固定hash，并扫描常见凭据/私钥格式，未命中；模式扫描不能保证不存在其他机密信息。排除.env/凭据、实验附件、完整任务历史、产品state、用户项目、其他源码和仓库remote元数据。

取得明确授权后，在隔离最小仓库仅重建上述基线/变更及配置。隔离仓库无remote，因此使用免费CLI额度，没有开启付费credits；未添加remote、推送或补发其他源码。该轮审查没有改动工作区代码或暂存区；所有源码hash仍匹配送审清单及前轮测试。0 issues是该有限范围的外部审查结果，不代表所有产品行为已经重新验收。

## 材料用途与清理

发布后已精简正文草稿、独立patch和patch清单3份，共66876逻辑字节，见[交付清理回执](delivery-cleanup.json)。送审清单、审查/清理结果仍用于外传范围与门禁核对，予以保留。自包含验证记录是13文件补丁中的最终证据，不复制完整模型会话或研究日志。此前四组实验附件暂未提交且仍为唯一复现/失败证据，本轮不删除或改写其固定hash。

此前准备阶段仅删除空test-outputs/d9-delivery-review，逻辑文件字节0。本轮无新依赖安装或产品模型任务。获批范围审查完成后，核验专用目录身份、无句柄/挂载并删除51份文件（318880逻辑字节）及临时路径指针（727字节）；共享卷可用空间观察增加372736字节，不声称独占回收量。必要结果、失败、版本与hash已保留。见[清理回执](coderabbit-cleanup.json)。
