# T10.6 PR73评审修复

日期：2026-09-12。依据：Leader在PR评审后明确授权“进行修复”；对应详细设计§11.9/§11.10 E04/E05/E08/E12与R11/R12。本轮保持10.6/in_progress，不执行10.7，不改10.5冻结评测或已接受录像。

## 根因与修复

| 问题 | 已验证根因与处理 |
| --- | --- |
| 草案ID冲突 | 外部Leader ID能占用内部前缀，随后解释错读Leader消息且重试持续失败。runtime在持久化/动作前拒绝保留前缀，HTTP返回400；proposalId引用及规范重放保持有效 |
| Git回收失败 | 缺失目录的prunable记录在恢复及健康目录身份匹配两处触发realpath ENOENT。解析器保留prunable/locked，失效记录只在task路径、branch、HEAD核验后登记回收；正常目录保持严格身份校验。按精确路径删除Git记录，其他task的失效记录/分支保留 |
| 跨作用域反馈 | 旧确认请求无作用域检查，切到另一任务后仍显示成功。发送/确认/启动响应绑定一次界面作用域，切换及离开后返回均使旧响应失效；新请求busy、错误与草稿不被覆盖，后端已受理动作不取消 |
| 矛盾测试结果 | 基线已允许passed=true与failed>0或非空failures并存，新校验仍缺语义约束。现在拒绝矛盾成功；passed=false且无位置明细仍原样保留，未伪造计数或文件位置 |
| 文档当前状态 | 面试备答、录制计划与自然语言功能报告未清楚区分尚未录制时点；更新为当前quote-en-take-9入口，保留历史过程、费用、失败和源码身份 |

新增测试先红后绿：外部保留ID、两类矛盾成功及真实Git失效记录恢复均在修复前失败。Git用例进一步覆盖其他task记录保留、重复恢复/回收、branch/path不匹配及symlink替换拒绝。一项最初的新增测试错误地假设Git porcelain保留ref移动前的HEAD；实测它读取当前ref，故修正为真实branch/path不匹配的场景，仍断言拒绝且保留外部文件，不放宽业务断言。

## 验证

针对性105项、类型检查、Biome与生产构建已通过。真实Chrome在生产构建上验证旧确认成功/失败×切换其他task/离开后返回四种竞态，均忽略旧结果且保留新请求busy和草稿；同作用域确认重试复用msgId、刷新、桌面/移动布局与过期按钮也通过。浏览器HTTP响应为合成夹具以确定性控制竞态，未调用模型，不作为G5。

完整回归：`pnpm run test --config /private/tmp/agora106-qa/pr73-regression.config.mjs --maxWorkers=2`，166文件、1252项全部通过、0skip，193.37秒。配置完整继承仓库include/setup，只添加用量审计，不移除凭据、不排除测试；包含真实Web/Harness/MCP/Docker/Git及跨阶段链。14条官方DeepSeek请求全部HTTP200且用量已知，按本轮审计口径估算USD0.007585746，无新Go录制或Benchmark。请求数量取本轮账本实际值，不沿用首次交付的17次。

归档独立复核：已批准15b4aa96的6文件逐字匹配，18+8项产物检查在只读/无网络Docker内全部通过，任务linked worktree与容器均0。新修复相对录制源码清单仅改变4份生产代码及3份测试；不改录像、媒体hash或原始420项清单，不把归档重验冒称重新运行整段模型任务。

私有审计目录：`.data/demos/task106-20260911/audit/pr73-repair/`。以下仅公开日志身份，不发布会话/密钥/推理：

| 日志 | SHA-256 |
| --- | --- |
| archive-summary.log | `61309b2f1b64e10fb2dd76ea538bbd169c88a44e28afbde5e1bb119c3892dcad` |
| archive-validation.log | `bea94defaa7979a4398e4773e0182620fa3fc790f76571d90d3df6bc52fd5c05` |
| build.log | `e9814d59ddc413717039515d712138944cb0ec568e14020795f598f606369226` |
| full-test.log | `f15a39d9a17eaa687b6e294cfba0fa6fa8aed87c66e17dbc01062772856db25f` |
| lint-final.log | `b33619b5de89def8ae1fd0f5857e2a67a6917e5dc126a39c98df1366b52b4cda` |
| red.log | `43f9358909162cefbbd7d70a884b5a036b649d3dd91bbc007e7e55ecb31c8eef` |
| targeted-pass.log | `fe53489ad5555bb137ba92b07967c964727f9e51392a16f580873949ddcb8b79` |
| typecheck.log | `31bca0e1de9f7370c83be8bf321cf3a80e619b1997255ee0410177c1cafa6144` |
| ui-general.log | `dd89c425ea63248b01812fa2f4e6eb73a6a4b3d4da6e69a00a76500b4c02dfe8` |
| ui-scope.log | `f4a672c6b2b830782c6076f478da70be83bae681fcb194bb2a439709dd7edf43` |


G7：93份PR交付文本的精确快照经Gitleaks扫描，0泄漏；日志SHA-256 `a8b185e7823c7516a2744211d99c63ec008d405eeaf102bb43d29c0ff671f47f`。源码/测试/文档通过diff检查，未提交.data、辅助脚本、密钥或会话。修复沿用PR #73，等待人类审阅合并；没有自动合并。
