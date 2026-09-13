# T10.7 Phase 10 出口验收计划

日期：2026-09-12。状态：Leader已明确“确认”本计划，进入实施与验证。基线：dev-1.0.0 `a18d7ec`；实施分支：`codex/phase10-exit-acceptance`；2026-09-13经Leader调用agora-commit，交付时改名为`test/phase10-exit-acceptance`。

## 规格与依赖

任务10.2、10.3、10.6及前阶段出口9.5均done，10.4/10.5亦done。当前Phase10保持in_progress；10.7开工不表示阶段出口通过。

来源：蓝图§1/§21、详细设计§11（尤其§11.9/§11.10）、开发计划§13、task106-doc-acceptance-audit.md及standing_decisions。重点决策为D1/D2/D4/D6/D8–D17、FE/WO/DEF；KB继续Write-Block，冻结接口保持。

> 出口仍运行适用的完整回归和真实跨包/G5链；不得skip、移除凭据或改断言来凑绿。

> 旧的冻结Eval不得重算或混入本轮数据。

> 五条成功标准保持，其中“自主完成全流程”指正常阶段可推进、普通缺陷有界返工，最终完成仍须D16 Leader终审；“上下文不崩”应验收投影/官方压缩/容量配置与有界错误处理，不作为无限上下文质量保证；“可扩展”不扩大DEF-016/017范围。

历史pending/待合并/暂停文字按其日期解释；当前状态以task-status为准。本次未发现需Leader另行裁决的实质架构冲突。

## 工作单元与文件

1. 建立覆盖表：在`docs/evals/phase10-exit-evidence.md`逐项记录五条成功标准、E01–E12、对应测试/浏览器动作/日志hash/源码版本，未执行项明确待验；核对DEF-016/017与现有Benchmark公开v11、内部v14的独立证据。
2. 新增`tests/integration/phase10/phase10-exit.test.ts`及必要的同目录非test夹具`exit-fixture.ts`。独立构造生产MessageRuntime、TaskOrchestrationRuntime、WebTaskComposition、共享GlobalScheduler、真实Harness解释器/worker、HTTP handlers、State、SSE、Git、Docker和JSONL；仅外部模型响应脚本化并在文件头说明理由，不替代安全点端口或生产验证器，不import历史测试作为出口实现。
3. 主链使用独立合成任务A/B并行、C依赖二者。实际工具结果驱动模型夹具；执行中通过正式消息入口提出关联需求变更，观察可读草案且确认前State不变，再经真实安全点确认/reproject。校验稳定msgId重放、最新需求与自身assignment投影、旧验证失效及累计测试继承。完成候选经预声明的测试Leader事件先request_changes再新review/approve，验证completionFeedback、规范receipt及精确HEAD；最终归档由新Docker独立复验，并用新runtime读取持久状态，核对任务资源释放。独立检查D4 paused worker的新session/seed/lineage，不把全done的完成gate当作worker Fork。
4. 在同一出口入口补充拒绝路径：安全点等待期间事实变化导致草案过期且无部分需求写入；gate/done或不同作用域的陈旧确认不能越过权威边界；未批准候选不能归档成功。复用已存在专项测试覆盖保留ID、矛盾测试结果、精确Git回收等，不复制每条单元断言。
5. 实际浏览器验证E01–E05/E12：桌面/移动布局、折叠原文、Markdown安全、任务展开、滚轮/滑块/Home/End、≤32px跟随与历史阅读位置、msgId去重新消息计数、输入框固定；发送/确认成功失败、刷新与切换作用域竞态。确定性HTTP夹具用于竞态并单列；至少一条页面验证连接真实本机后端/持久State/SSE/官方Trace，不能用SSR或静态running标签冒充。优先使用可用浏览器工具，遵循对应前端验证技能。
6. 运行原生helper构建、类型、Lint、Phase10专项、适用跨阶段与完整默认回归、生产构建及正式doctor；默认真实模型测试保留凭据，附加审计只记用量而不改流或排除测试。核验所需真实模型功能链是否已由本轮回归覆盖；缺少时明确记录，不将旧演示或脚本化模型算作本轮模型实测。独立新模型任务另按当时用户授权确定输入/服务/范围，不能从冻结Eval剩余额度推定授权。
7. 同步详细设计§11.10、开发计划§13与task-status notes中的实际实施/验证入口及结果；公开材料仅留脱敏证据。任务保持in_progress，完成开发后等待用户调用交付流程；不自动commit/push/合并。

## 验收映射

| 成功标准 | 现有入口与本轮补齐 |
| --- | --- |
| 闭环 | 新出口主链覆盖需求确认、并行/依赖、累计验证、返工、D16及归档；Phase9专项与默认回归保留 |
| 产品形态 | E01–E05/E12实际浏览器；phase10-local-startup/model-settings与正式启动/doctor；Trace沿真实JSONL读取 |
| 协作可控 | 主链D9安全点及D4/D16；E06/E07完成反馈/assignment；历史Phase6–9的Channel/roster/离职接手专项本轮回归 |
| 工程质量 | E08–E11累计测试/正常容量/旧绑定/官方压缩/Go恢复/严格格式；phase10-resilience及跨阶段全回归；清理失败不得遮蔽原错 |
| 可扩展 | phase10-model-settings固定绑定/换模型/真实Fork，既有角色生命周期及MCP权限专项；DEF-016自主路由与DEF-017 Linux产品适配保持既定边界 |

Benchmark审计只核对现有固定版本、任务/模型/预算/重复次数、四组比较、公开/holdout隔离、失败分母与unknown/方差、原结果hash可追溯性。公开33/36与内部14/18分别解释，不生成新的合并分数或重跑54次。

## 实施与通过规则

先落实夹具和断言，用实际生产路径暴露缺口；新增测试若直接通过就记录当前行为已满足，不人为破坏生产代码制造红灯。发现真实缺陷时先停止受影响操作，至少列出三个按证据排序的假设，最小复现后按既有Leader修复授权实施最小修复并同步来源文档。只修改有证据要求的生产文件，不预先改State/schema/冻结端口或添加依赖。

每个单元单独验证；最终完整回归通过后，只有源码变化或新失败才重复。证据表区分本轮实测、历史旁证、未执行、不适用；所有资源清理动作都尝试并保留原错及清理错误。测试脚本中的预声明Leader事件只用于合成验收场景，不授权替用户批准新的产品候选。

本计划已确认；10.7的done仍须G1–G7、人工PR合并与agora-pr-merge收尾。
