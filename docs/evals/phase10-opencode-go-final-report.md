# Task10.5 OpenCode Go 对照报告

两部分预定对照均已执行完整。公开组 phase10-final-v11：36/36 次归档，整体通过 33/36；新内部组 phase10-final-v14：18/18 次归档，整体通过 14/18。两部分使用不同冻结源码，分别解释结果，不计算跨版本合并成功率。

公开组独立比较单Agent/多角色与固定模型/角色混合；内部组独立比较同一DAG的串行/并行及结构化上下文保留策略。每个比较内部固定非目标变量。已完成公开attempt通过不可变结果hash引用，未复制、补跑或算作新样本。公开集是Aider Polyglot JavaScript四题固定子集，不是完整排行榜分数。

本子集的成功配对中，多角色相对单Agent平均增加176.12秒（11对）；混合模型相对固定多角色平均减少46.21秒（9对），但整体通过为10/12，对照为11/12。内部并行相对串行平均减少142.80秒（4对），稀疏策略平均减少54.10秒（4对）；两者整体均4/6通过，串行为6/6。速度只来自双方成功的配对，不能忽略流程失败，也不能从每格3次推出普遍优越性。

## 配置与任务边界

公开grade-school、wordy、book-store、forth各single/multi/mixed，每格重复3次。内部thermal-inspection、daily-availability各multi/parallel/sparse，每格重复3次。每次独立State/session/workspace。内部旧order-audit/shift-conflicts、shipment-quotes入口试验及inventory-restock提示诊断属于开发或缺陷证据，未混入新内部结果。新两题在首个模型请求前冻结并完成真实Tier2/DAG入口、独立判题正反校验。

接口为OpenCode Go。single及所有非mixed配置用deepseek-v4-flash；mixed的PM/ARCHITECT/REVIEWER用deepseek-flash，其余角色仍用deepseek-v4-flash。温度0.2、thinking enabled、reasoning high，输入上限65,536个Harness估算token，单次输出上限32,768。模型别名权重、缓存与供应商负载没有受控。

每attempt最多120模型请求、240工具调用、8轮编排、USD2及20分钟新请求准入；每冻结组8小时，暂停不重置本组计时。Go所有历史组和新组共用原USD5，不归零。parallel只将worker lease cap从1改为3，Docker每容器配额保持；sparse仅保留既有授权Channel局部上下文最新两条，必要权威、assignment和权限切片不裁剪。

公开题面、stub及完整激活的上游测试作为.spec.txt可读契约；独立Jest验题使用隔离原件。内部模型只取得任务说明和运行时工具结果，隐藏验证与参考解不进入模型工作区。内部合成热量题通过既有D9安全点链注入干预阈值变更；最终判题验证更新后的契约。

## 公开对照

整体 33/36 通过；独立验题实际执行 33 次，通过 33 次。未到验题的流程失败不能直接解释为代码错误。

| 任务/配置 | 通过/执行 | 成功耗时均值 ± SD（秒） | 成功中位数（秒） | 失败耗时均值（秒） | 平均用量折算 USD | 统一峰价折算 USD | 平均预算占用 USD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| public/grade-school/single | 3/3 | 55.29 ± 14.77 | 50.56 | unknown | 0.004123 | 0.008246 | 0.004123 |
| public/grade-school/multi | 3/3 | 226.60 ± 38.87 | 222.50 | unknown | 0.016954 | 0.033907 | 0.016954 |
| public/grade-school/mixed | 3/3 | 197.20 ± 27.84 | 193.13 | unknown | 0.016153 | 0.032305 | 0.016153 |
| public/wordy/single | 3/3 | 182.58 ± 26.50 | 190.34 | unknown | 0.010465 | 0.020929 | 0.010465 |
| public/wordy/multi | 2/3 | 454.87 ± 120.81 | 454.87 | 616.74 | 0.032571 | 0.065142 | 0.032571 |
| public/wordy/mixed | 2/3 | 207.11 ± 0.97 | 207.11 | 601.65 | 0.022012 | 0.044024 | 0.022012 |
| public/book-store/single | 3/3 | 133.65 ± 58.78 | 144.91 | unknown | 0.010125 | 0.020250 | 0.010125 |
| public/book-store/multi | 3/3 | 204.71 ± 24.87 | 206.29 | unknown | 0.020066 | 0.040131 | 0.020066 |
| public/book-store/mixed | 2/3 | 270.14 ± 128.54 | 270.14 | 480.44 | 0.028604 | 0.057207 | 0.028604 |
| public/forth/single | 3/3 | 157.93 ± 36.73 | 140.88 | unknown | 0.014512 | 0.022444 | 0.014512 |
| public/forth/multi | 3/3 | 389.62 ± 107.02 | 330.12 | unknown | 0.041627 | 0.064624 | 0.041627 |
| public/forth/mixed | 3/3 | 339.58 ± 48.17 | 322.78 | unknown | 0.032442 | 0.062676 | 0.032442 |

## 新内部对照

整体 14/18 通过；独立验题实际执行 14 次，通过 14 次。

| 任务/配置 | 通过/执行 | 成功耗时均值 ± SD（秒） | 成功中位数（秒） | 失败耗时均值（秒） | 平均用量折算 USD | 统一峰价折算 USD | 平均预算占用 USD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| holdout/thermal-inspection/multi | 3/3 | 513.08 ± 56.63 | 487.80 | unknown | 0.072495 | 0.072495 | 0.072495 |
| holdout/thermal-inspection/parallel | 2/3 | 379.80 ± 65.57 | 379.80 | 580.73 | 0.074748 | 0.074748 | 0.074748 |
| holdout/thermal-inspection/sparse | 3/3 | 438.92 ± 28.54 | 434.75 | unknown | 0.067057 | 0.067057 | 0.067057 |
| holdout/daily-availability/multi | 3/3 | 527.71 ± 55.63 | 500.15 | unknown | 0.051287 | 0.076347 | 0.051287 |
| holdout/daily-availability/parallel | 2/3 | 406.25 ± 53.02 | 406.25 | 630.78 | unknown | unknown | 0.066472 |
| holdout/daily-availability/sparse | 1/3 | 497.32 ± unknown | 497.32 | 651.67 | unknown | unknown | 0.056559 |

## 可比成功配对与机制证据

只比较同任务、同重复序号且双方整体通过的配对；失败留在成功率分母。速度比=基线耗时/变体耗时，大于1表示变体更快。每格仅3次，方差使用n−1；不足2次观测的离散度为unknown，不宣称统计显著性或普遍优越性。

| 独立比较 | 可比成功配对数 | 变体−基线平均秒差 | 平均速度比 ± SD |
| --- | --- | --- | --- |
| 公开single/multi | 11 | 176.12 | 0.44 ± 0.20 |
| 公开multi/mixed | 9 | -46.21 | 1.24 ± 0.60 |
| 内部multi/parallel | 4 | -142.80 | 1.38 ± 0.20 |
| 内部multi/sparse | 4 | -54.10 | 1.13 ± 0.19 |

| 组/变体 | 归档数 | D16 gate触达 | lease峰值>1 | 请求并发峰值 | 需求更新落地 | 稀疏投影变化 | 真Fork触达 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 公开/single | 12 | 0 | 0 | 1 | 0 | 0 | 0 |
| 公开/multi | 12 | 11 | 0 | 1 | 0 | 0 | 0 |
| 公开/mixed | 12 | 10 | 0 | 1 | 0 | 0 | 0 |
| 内部/multi | 6 | 6 | 0 | 1 | 3 | 0 | 0 |
| 内部/parallel | 6 | 4 | 6 | 3 | 3 | 0 | 0 |
| 内部/sparse | 6 | 4 | 0 | 1 | 3 | 6 | 0 |

D16批准与规定的中途需求更新为预先授权的固定事件，经D9提交并由真实State/receipt校验，不测量人类审阅质量或耗时。单Agent不适用多角色gate/Channel/Fork；零触达不是协作检查通过。所有worker已done时完成gate只恢复composition，不应伪造worker Fork。机制未触达的样本不能用来判断其效果。

官方持久会话审计：本报告两部分启动压缩 0 次，成功 0 次，失败 0 次。按compactionId去除继承seed重复事件；未触发不能解释为未配置。此前两种Go模型各一次真实压力压缩成功，单独作为功能验证，未混入Benchmark样本。

配套JSON提供逐次attempt的模型/工具调用数、累计token与费用、角色路由、输入估计峰值、迭代/返工、分段时延和资源采样。累计输入token不等于单个Agent上下文长度。CPU、内存、磁盘峰值和可靠排队时长未采集，保持unknown；容器/worktree数量与lease观察分别报告，请求并发不等于供应商GPU利用率。

## 失败、操作影响与修复

| attempt | 证据分类 | 独立验题 | 人工中断 |
| --- | --- | --- | --- |
| wordy-mixed-2 | operator-interrupted-recoverable-test-debugging | not-executed | 是 |
| wordy-multi-3 | reviewer-request-output-budget-exhausted | not-executed | 否 |
| book-store-mixed-1 | reviewer-request-output-budget-exhausted | not-executed | 否 |
| thermal-inspection-parallel-1 | operator-interrupted-reviewer-readonly-stagnation | not-executed | 是 |
| daily-availability-sparse-1 | provider-stream-closed-without-usage | not-executed | 否 |
| daily-availability-sparse-2 | attempt-time-budget-exhausted-after-review-rework | not-executed | 否 |
| daily-availability-parallel-3 | provider-stream-closed-during-repetitive-review | not-executed | 否 |

wordy-mixed-2的人工停止偏早：模型正排查自己生成的嵌套Node测试，并在停止前写出修正。事后同镜像自测原版26通过/1失败，模型修正版27通过/0失败，均零跳过。这不是独立Benchmark验题；保留人工中断及成本，不能归因模型最终无法完成。wordy-multi-3及book-store-mixed-1耗尽单次审阅输出预算，输入分别约12,208/7,166估算token，均不是上下文溢出。

v11内部首步探查揭示全attempt工具错误计数混淆并行worker与同一步批量结果；第二个样本确认后停止剩余内部实验。现按session/失败步骤保留一次恢复机会，第二次失败步骤仍停，基础设施/权限错误立即停；原调用和费用上限保持。v12首项又揭示新fixture未触发Tier2，发现后停止；修正前置分类检查，并用实际新题走真实生产DAG入口验证。两次缺陷组均保留原失败/未启动/费用，旧内部任务转开发，已完成公开比较不重跑。

v13库存串行通过，随后并行样本的真实类型校验缺陷被TESTER误升为需求阻塞异议。发现后立即停止剩余16项，保留1pass1fail与成本。修复通用提示：阻塞异议质疑需求或决策本身，接受会撤回目标；普通实现缺陷走失败测试及changes_requested返工。严格解析器和Leader裁决不变，不替模型修改原答案；旧库存题不进入本次新内部对照。两种Go模型在原剩余2次合成诊断中均返回普通changes_requested，未发阻塞异议，具体结果见修复证据。

此前D1输入修复改用官方agent-scoped SystemPrompt提供当前投影，每turn仅一次启动消息，工具历史及自动压缩仍由官方Harness管理；Go摘要请求禁用可调用工具并要求非空文本。这些修复、模型变化及环境契约均使旧官方/旧Go组不能与当前结果作单因素因果比较。

## 历史正式组保留记录

下表仅清点Go原账本中的实际请求和历史分组，不合并不同版本的成功率。planned包含未启动位置，不代表已花费attempt；v11公开36项作为独立比较，另两项内部缺陷样本仍留在其原组。

| 组 | 计划 | 已归档（通过/失败） | 未启动 | 请求 | 预算占用USD（含审计上界） |
| --- | --- | --- | --- | --- | --- |
| phase10-final-v4 | 54 | 4（0/4） | 50 | 9 | 0.073971504 |
| phase10-final-v5 | 54 | 1（0/1） | 53 | 19 | 0.015887322 |
| phase10-final-v6 | 54 | 4（2/2） | 50 | 60 | 0.049881384 |
| phase10-final-v7 | 54 | 2（1/1） | 52 | 21 | 0.014648622 |
| phase10-final-v8 | 54 | 7（5/2） | 47 | 102 | 0.112099374 |
| phase10-final-v9 | 54 | 29（24/5） | 25 | 506 | 0.645355938 |
| phase10-final-v10 | 54 | 5（3/2） | 49 | 77 | 0.064812288 |
| phase10-final-v11 | 54 | 38（33/5） | 16 | 687 | 0.782874174 |
| phase10-final-v12 | 18 | 1（0/1） | 17 | 18 | 0.036137952 |
| phase10-final-v13 | 18 | 2（1/1） | 16 | 86 | 0.128476416 |
| phase10-final-v14 | 18 | 18（14/4） | 0 | 877 | 1.165852530 |

内部thermal-inspection-parallel-1因连续相同完整文件读取且审阅结论无推进而人工停止，保留中断及费用；未进入隐藏判题，不能据此断言最终代码错误或模型永远无法完成。上下文输入估计未越冻结上限，无压缩失败。

## 要求与证据对应

| 要求 | 实际证据 | 边界 |
| --- | --- | --- |
| 成熟Benchmark适配与判题保真 | 固定Aider题源/helper版本；4参考解与4空实现正反校验；99项上游测试启用 | 四题JavaScript子集 |
| 四组对照、每格至少3次 | v11公开single/multi/mixed；v14内部multi/parallel/sparse；逐次JSON及冻结hash | 失败和人工中断保留分母，跨版本不合并 |
| 权限与独立判题隔离 | 原始结果safety.verifier-integrity、允许候选文件复制、判题前后hash校验；公开测试文本可读 | 内部参考解与隐藏测试不进入模型工作区 |
| 真实生产编排与完成权威 | 固定DAG、累计validation receipt、D16绑定、资源释放检查 | 预授权完成事件不评价人类审阅能力 |
| 输入投影与自动压缩 | 结构化投影变化计数、官方持久会话压缩审计、两模型压力压缩实测 | 正式未触发压缩不代表未配置；不测原始群聊全量广播 |
| 修复与回归 | 最终冻结前153文件1175测试通过、0skip；typecheck及398文件lint通过；真实Docker入口/返工/D14/D16链路 | 正式之后未修改执行源码；报告后处理不调用模型 |
| 费用及失败可审计 | 每请求事前预留、历史组全量费用、停机审查、未知usage显式上界审计 | 预算占用和用量折算费用分列；不增加原上限 |

## 费用和验证

本次公开比较预算占用 USD0.748955406，新内部比较 USD1.165852530；其他历史/诊断性正式组费用仍在共享Go账本。共享保守预算占用 USD3.089997504/5，2462 请求，未结算 0。Go独立诊断 65 请求/USD0.131913528；官方DeepSeek回归原USD20账本保守占用 USD8.836436804，包含已审计的漏计小时窗上界USD0.125900192。

daily-availability-parallel-3在终审同一请求中反复复核模块，观察到重复段落至少25次；人工已要求禁止后续请求，但未取消在途输出。该流随后自行以STREAM_CLOSED（缺少[DONE]）结束，未返回usage，没有后续调用。直接失败原因保留为断流，停止请求单列，不伪称人工终止了该流。46条已知调用费用USD0.031892418，缺失调用按原USD0.0589824预留上界保守占用；生产19/30项通过，尚未独立判题，输入峰14,226，没有上下文超限证据。

daily-availability-sparse-2在普通changes_requested返工后耗尽20分钟新请求准入时间，71次调用均有usage，成本USD0.072872178；原生产验证20/28/29项通过，但尚未完成最终终审及隐藏判题。输入估计峰31,119、输出峰14,118，均未触及上下文/输出上限。长评审与验证推理影响时延，原审阅问题本身未独立裁判；不改限额、不重跑原失败。

daily-availability-sparse-1首个PM请求发生STREAM_CLOSED（SSE缺少[DONE]），未返回usage，实际token和用量费用保持unknown；无工具调用，输入估计4,693，尚无上下文超限或执行器缺陷证据。供应商与网络的进一步根因无法确定。停止后经显式审计，将原预留峰价上界USD0.0589824计入原USD5，未重放请求；只恢复同组未启动样本。预算占用包含该上界，不能当作用量实测。

Go费用为订阅配额折算，不是额外账单金额。表中统一峰价折算按每次实际usage使用冻结峰价重新计算，仅消除峰谷时段差异，不改写实际账本；缓存与供应商负载仍不受控。冻结计价：两模型峰时每百万token输入0.30、输出1.20、缓存读0.006美元，非峰时减半；峰时周一至周五UTC 01:00–04:00及06:00–10:00。预留按峰值，结算按请求开始时段，见[Go计价规则](https://opencode.ai/docs/go/#usage-limits)。缺缓存分类时按未缓存输入保守计量，未知usage立即阻止后续请求；只有显式审计并保守占用原预留上界后才能恢复。包含未知用量的比较格不显示完整费用均值，JSON另列已知样本数；预算占用单列。历史v4有一次、当前v14有两次这类上界审计，共USD0.1769472；原未知用量均未改写。

公开源码指纹：`f1352ccf5d20bf6d8a0e343e8d53a076650a6ea1e6f5fd0c8d45d2dbc447316e`；内部源码指纹：`93cafece021f1c5ada5a7db7173738405317a11569665ec555ba82efdd89f1e4`。公开组：`b0007a118d785ca17c229ea646bc90bf473afcf5057e6b8cce5e8013bb97e2a6`；内部组：`257e8c78bef43ca1139b645ebc96307f8090894aab25e872a2619e3c6ac85eec`。镜像：`sha256:198dba14be3e05a6c663d97f2bdc53a8c5a3c32c50b090f665f131b8d9812934`。

最终验证结果及日志见[工具恢复与入口修复证据](phase10-recovery-scope-repair-evidence.md)，历史D1压力压缩/计费核对见[投影修复证据](phase10-projection-input-repair-evidence.md)。Benchmark有保留失败时模型验收CLI按约定返回非零；这与确定性完整回归是否通过分别报告。Task10.5在PR人工合并前保持in_progress。

- [公开逐次指标及方差](phase10-opencode-go-public-metrics.json)
- [新内部逐次指标及方差](phase10-opencode-go-internal-metrics.json)
- 原始可审计记录位于.data/evals/phase10-final-v11和.data/evals/phase10-final-v14；公开文件只含白名单指标，不导出原始提示、思考过程、工具参数或结果。
