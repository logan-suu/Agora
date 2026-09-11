# Task10.5 最终 Benchmark 报告

v3冻结实验完成：54/54次独立attempt均已归档，整体通过25/54（46.3%）；独立验题实际执行25次，通过25次。未到达独立验题的流程失败不等同于候选代码验题失败。全部失败保留在54次分母，v1/v2另有16条历史记录保留、不混算。

本次是固定四题公开子集和两个内部holdout的探索性工程对照，不是完整Aider排行榜分数，也不据此宣称多Agent普遍更好。正式与历史实验、诊断合计预算占用USD8.352820，未超过Leader批准的USD20总/17正式/3诊断上限；其中包含下文单列的未知用量保守审计上界。

v3冻结源完整回归143文件/1105测试通过（612.76秒，0 skip）；typecheck/lint、26项定向检查、真实模型诊断、真实Docker/MCP/Harness驱动和独立判定器正反预检通过。以上为v3冻结源的修复前验证记录，实验期间没有修改生产代码或弱化测试。2026-09-10经Leader授权已完成advisory续评、投影指令和上下文容量元数据修复，最终143文件/1114测试及真实模型诊断通过；当前源码与v3冻结源不同，修复证据单列于[修复验证](phase10-repair-evidence.md)。Task10.5保持in_progress，等待后续提交、PR与人类合并；Benchmark低成功率本身不是事后新增验收门槛。详见[门禁与预检证据](phase10-preflight-evidence.md)。

本组最明显的限制是流程完成率：公开集single为11/12、multi为5/12、mixed为7/12；holdout仅2/18完成。29条未通过中20条触及上下文限额（19条TESTER、1条CODER）。6次并行都实际达到lease与模型请求并发峰值3，但没有端到端成功的并行样本；因此本组不能证明并行加速，稀疏策略也没有可用于速度比较的成功配对。

## 1. 实验问题与固定配置

| 对照 | 任务与重复 | 唯一目标变量 |
| --- | --- | --- |
| single / multi | grade-school、wordy、book-store、forth，各3次 | 真实Harness单CODER与真实产品多角色流程；均Flash、cap=1 |
| multi / mixed | 同一公开四题，各3次，复用multi基线 | PM/ARCHITECT/REVIEWER改为Pro，其余仍Flash |
| multi / parallel | order-audit、shift-conflicts，各3次 | 同一D17 DAG的全局worker lease cap从1改为3 |
| multi / sparse | 同一内部两题，各3次，复用multi基线 | 仅将已授权Channel局部上下文保留为最新2条；系统切片、assignment与权限不变 |

共36次公开任务与18次内部holdout；每轮顺序按ABC/BCA/CAB轮换，不做全组合穷举。每次新建任务、工作树与会话。公开原测试的全部xtest启用后，以同内容`.spec.txt`提供可读契约；参考解、私有Jest配置、独立判定容器以及holdout验证代码始终隔离。Agent可编写并运行自己的Node测试；最终独立Jest/Node verifier只接收允许的候选源文件。

模型为deepseek-v4-flash / deepseek-v4-pro官方接口；thinking enabled、reasoning high、temperature=0.2、单响应maxTokens=32768。上下文上限65536是锁定Harness启发式token估算，不是字节数或provider精确tokenizer。单次最多120模型调用、240工具调用、8轮迭代、USD2；20分钟是新请求准入限额，已有请求/工具自然结束；整组8小时从2026-09-09T23:47:10.346Z开始，暂停续跑没有重置时钟。

平台：macOS arm64、宿主Node v24.20.0、16GiB内存；本地Docker分配8CPU/约8GiB。评测镜像基于node:20-slim，独立Jest/Babel依赖只存在评测镜像，不进入产品运行时。

## 2. 样本与时延

| 集合 | 整体通过/全部attempt | 独立验题执行 | 独立验题通过 |
| --- | --- | --- | --- |
| public | 23/36 | 23 | 23 |
| holdout | 2/18 | 2 | 2 |

下表成功与失败时延分列，单位秒。标准差为样本标准差；不足2个已知值时为unknown。每格完整均值、中位数、样本方差、标准差和未知数见机器可读报告。

| 任务/变体 | 整体通过/3 | 成功耗时均值 ± SD (s) | 失败耗时均值 (s) | 已知费用均值 (USD; n) |
| --- | --- | --- | --- | --- |
| public/grade-school/single | 2/3 | 217.3 ± 17.6 | 300.8 | 0.03629; 3 |
| public/grade-school/multi | 0/3 | unknown ± unknown | 255.5 | 0.03540; 3 |
| public/grade-school/mixed | 3/3 | 384.7 ± 96.6 | unknown | 0.07860; 3 |
| public/wordy/single | 3/3 | 48.7 ± 8.7 | unknown | 0.01319; 3 |
| public/wordy/multi | 2/3 | 186.9 ± 29.5 | 183.3 | 0.08307; 3 |
| public/wordy/mixed | 2/3 | 258.8 ± 41.5 | 217.1 | 0.09725; 2 |
| public/book-store/single | 3/3 | 96.1 ± 53.4 | unknown | 0.04045; 3 |
| public/book-store/multi | 1/3 | 218.6 ± unknown | 164.9 | 0.12159; 2 |
| public/book-store/mixed | 1/3 | 332.7 ± unknown | 411.5 | 0.14914; 3 |
| public/forth/single | 3/3 | 83.1 ± 41.8 | unknown | 0.03465; 3 |
| public/forth/multi | 2/3 | 246.9 ± 54.9 | 42.1 | 0.10100; 3 |
| public/forth/mixed | 1/3 | 440.1 ± unknown | 504.9 | 0.18619; 3 |
| holdout/order-audit/multi | 1/3 | 271.0 ± unknown | 197.7 | 0.17993; 3 |
| holdout/order-audit/parallel | 0/3 | unknown ± unknown | 183.6 | 0.17642; 3 |
| holdout/order-audit/sparse | 1/3 | 305.5 ± unknown | 212.5 | 0.19407; 3 |
| holdout/shift-conflicts/multi | 0/3 | unknown ± unknown | 215.7 | 0.18335; 3 |
| holdout/shift-conflicts/parallel | 0/3 | unknown ± unknown | 193.7 | 0.19204; 3 |
| holdout/shift-conflicts/sparse | 0/3 | unknown ± unknown | 162.6 | 0.12547; 3 |

费用均值包含已知成本的成功和失败attempt，不把未知用量填零。输入/输出token、调用/工具次数、返工/迭代和预授权Leader事件次数的同类统计在JSON中。单次输入token为跨请求累积用量，不代表单请求上下文长度。

## 3. 同题配对与机制触达

配对仅纳入同题、同重复序号且双方整体通过的样本；失败仍在上表成功率分母，不能用幸存配对替代总体成功率。speedRatio=基线耗时/变体耗时，大于1表示该对中变体较快。

| 基线/变体 | 有效配对数 | 时差均值 (变体−基线，s) | speedRatio均值 ± SD |
| --- | --- | --- | --- |
| single/multi | 5 | 133.7 | 0.39 ± 0.26 |
| multi/mixed | 3 | 136.5 | 0.62 ± 0.13 |
| multi/parallel | 0 | unknown | unknown ± unknown |
| multi/sparse | 0 | unknown | unknown ± unknown |

| 变体 | attempt | completion gate触达 | lease>1触达 | client模型请求并发峰值 | 需求更新applied | 稀疏切片变更触达 | worker Fork触达 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| single | 12 | 0 | 0 | 1 | 0 | 0 | 0 |
| multi | 18 | 6 | 0 | 1 | 3 | 0 | 0 |
| mixed | 12 | 7 | 0 | 1 | 0 | 0 | 0 |
| parallel | 6 | 0 | 6 | 3 | 3 | 0 | 0 |
| sparse | 6 | 1 | 0 | 1 | 3 | 6 | 0 |

D16批准与order-audit中途需求更新都是Leader事先授权的固定事件，走真实POST/安全点/持久回执路径；这里不测量人类逐次审阅质量或耗时。额外blocking异议或集成冲突不在预授权集合内，不自动批准，记录为未完成。完成gate若全员done，恢复composition而worker Fork=0符合D17；paused worker真Fork的回归证据另见G4/G5，不用零Fork结果冒充触达。

模型请求并发峰值来自客户端start/end区间，不是provider GPU利用率；服务耗时之和可能重叠，不能当作节省的wall time。CPU/内存峰值、峰值磁盘、排队时间未采集，均为unknown；回收后的逻辑文件字节数仅是保留证据大小。

## 4. 全部未通过样本

需要额外Leader裁决 4次；角色输出契约异常 1次；上下文准入限额 20次；模型服务传输错误 2次；控制块格式异常 1次；合法advisory后缺少评审续行 1次。这些类别描述当前冻结配置下的失败位置，不把未到达验题的失败归为代码判错。

| attempt | 已有证据支持的分类 | 独立验题是否执行 |
| --- | --- | --- |
| grade-school-multi-1 | 需要额外Leader裁决 | 否 |
| grade-school-multi-2 | 角色输出契约异常 | 否 |
| grade-school-single-3 | 上下文准入限额 | 否 |
| grade-school-multi-3 | 需要额外Leader裁决 | 否 |
| wordy-multi-1 | 上下文准入限额 | 否 |
| wordy-mixed-2 | 模型服务传输错误 | 否 |
| book-store-multi-1 | 模型服务传输错误 | 否 |
| book-store-mixed-1 | 上下文准入限额 | 否 |
| book-store-mixed-3 | 上下文准入限额 | 否 |
| book-store-multi-3 | 上下文准入限额 | 否 |
| forth-mixed-2 | 上下文准入限额 | 否 |
| forth-mixed-3 | 上下文准入限额 | 否 |
| forth-multi-3 | 控制块格式异常 | 否 |
| order-audit-multi-1 | 上下文准入限额 | 否 |
| order-audit-parallel-1 | 上下文准入限额 | 否 |
| order-audit-parallel-2 | 上下文准入限额 | 否 |
| order-audit-sparse-2 | 上下文准入限额 | 否 |
| order-audit-multi-2 | 上下文准入限额 | 否 |
| order-audit-sparse-3 | 需要额外Leader裁决 | 否 |
| order-audit-parallel-3 | 上下文准入限额 | 否 |
| shift-conflicts-multi-1 | 上下文准入限额 | 否 |
| shift-conflicts-parallel-1 | 合法advisory后缺少评审续行 | 否 |
| shift-conflicts-sparse-1 | 上下文准入限额 | 否 |
| shift-conflicts-parallel-2 | 上下文准入限额 | 否 |
| shift-conflicts-sparse-2 | 上下文准入限额 | 否 |
| shift-conflicts-multi-2 | 上下文准入限额 | 否 |
| shift-conflicts-sparse-3 | 需要额外Leader裁决 | 否 |
| shift-conflicts-multi-3 | 上下文准入限额 | 否 |
| shift-conflicts-parallel-3 | 上下文准入限额 | 否 |

事后修复审查确认，v3的MeteredAdapter没有向官方Harness提供contextWindow，自动压力压缩缺少计算阈值所需的容量。上述结果因此只代表包含该适配缺陷的冻结配置，不能用于评价正常启用自动压力压缩后的系统表现；20条上下文限额失败均保留，尚无修复后的重复对照来量化影响。详见[修复证据](phase10-repair-evidence.md)。

具体角色、阶段和证据引用逐条保留在JSON的failureClassification。上下文/时长限额是冻结条件下的流程失败；额外Leader gate是有限预授权流程未完成；传输错误仅能定位到接口流失败，不能据此判断provider或本机网络根因。角色最终输出异常按观察到的契约问题分类，未确定的产生环节明确标inconclusive。独立验题未执行的样本不能解读为代码判错。

产品衔接发现：shift-conflicts-parallel-1在累计Node验证62项通过后，REVIEWER以合法concern/advisory结束；规范reviewComments为空，严格评审路由要求当前verdict，未续行取得评审结果。它不属于非法异议或模型代码错误；冻结实验没有修改产品来重跑该样本，原状态、会话和失败完整保留。2026-09-10修复已补齐有界续评及回归，保持D14合法advisory与D16 Leader终审边界；修复不改变此冻结样本的失败结论。源码接缝：[控制消息跳过普通角色结果](../../packages/runtime/executor/src/harness-executor.ts#L375)与[并行评审要求当前verdict](../../packages/core/orchestration/src/parallel-coordinator.ts#L820)。

## 5. 费用与未知用量审计

| 项目 | USD |
| --- | --- |
| v3有usage的费用估计 | 5.98675903 |
| v3未知usage请求的保守上界 | 0.31793916 |
| 历史v1正式费用估计 | 0.48979843 |
| 历史v2正式费用估计 | 0.30670790 |
| 诊断/回归有usage的费用估计 | 0.23231456 |
| 诊断未知usage的保守上界 | 1.01930048 |
| 合计预算占用 | 8.35281956 / 20 |

本表截止v3结束及当时的诊断回归；之后修复验证的增量费用单列于修复证据。费用估计由每次provider usage与冻结价目表计算，不是账户账单。冻结峰值价（每百万token）Flash输入0.44/缓存读0.014/输出1.32，Pro输入1.32/缓存读0.044/输出3.96；依请求开始时的UTC时段应用原协议折扣。不同实验跨计价时段，JSON另给固定峰值价的事后算术标准化，明确是探索性辅助指标，未替换原费用或主评分。

正式组有2笔无usage传输失败经过逐项操作审计：先确认请求结束、资源清理与执行锁释放，再按事前完整预留计上界。原run/model-requests中cost和usage继续unknown、失败保留、不重跑；预算、任务顺序、组指纹和原8小时时钟不变。对应暂停/审计/续跑文件及证据哈希见JSON。

## 6. 历史协议与修正理由

v1公开测试不可见，13条final/41条未启动保留；其中11条正常结束，2条受操作暂停影响（1条零模型调用）。grade-school题面与测试的同名学生行为不一致，wordy精确异常文案也未在题面声明。它们暴露可见契约缺口，不能把原组得分单独解释为代码能力差距。

Leader批准公开测试可读并在原USD20上限内新跑54次。v2前三条后发现可读Jest `.spec.js`被产品可信Node验证器自动收集，形成夹具冲突。3条final/51条未启动及全部费用保留；不以该冲突评价模型能力。v3仅将相同激活文本映射为`.spec.txt`，原Jest判定不变，并补真实taskDefinition→多角色Node验证的先红后绿回归。v1/v2/v3分别冻结，旧16条加新54条共70条记录，不跨协议合并分数。

一次续跑前Docker标签查询404，但固定镜像ID仍存在；重新将同一已校验ID绑定原标签后启动，未重建镜像、改变输入或新增attempt。相关startup-recovery证据保留。

## 7. 可复查证据与解释边界

v3清单fingerprint：`2606aab0d19eecf651ef97ae7a0bd6b0285bf31fb380c7ef91b940f3a036f8f7`；执行源码fingerprint：`ba0220b49e41f403f58e2ae366a5e01c0197d000657dbb548ce256b6cc91e689`。冻结时间2026-09-09T23:47:10.346Z，镜像ID `sha256:198dba14be3e05a6c663d97f2bdc53a8c5a3c32c50b090f665f131b8d9812934`。组目录`.data/evals/phase10-final-v3`保存349文件源码/配置/规格快照，逐次证据按runId关联；未提交的实际源码已哈希冻结，不能仅用Git HEAD描述本次执行版本。

收尾核对340个manifest冻结执行文件、349个保存快照文件哈希全部一致，54次cleanup检查全部通过、执行锁已释放、无未结算请求；证据见组目录`final-integrity-audit.json`。模型命令因29条未通过按契约返回1，独立报告命令返回0，两者含义不同。

公开任务固定于[Aider Polyglot源版本](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f/javascript/exercises/practice)，MIT许可与每文件哈希保留；公开测试共99条，所有xtest激活且零skip。内部两题私有判定分别10/8条，参考解正例与空实现负例预检通过。评测不使用Aider Agent或其原生prompt/重试协议，不与官方总榜横比。

每格仅3次、任务人为选定、在线模型别名可能更新、缓存与provider负载未受控，不能给统计显著性或普遍优越性结论。公开任务是可读契约下的开发结果；内部holdout报告单列，验证源码没有投给模型，但内部自建任务也不代表外部盲测总体。Benchmark补充工程证据，不替代测试/G5。

- [逐次与每格机器可读指标](phase10-final-benchmark-metrics.json)：包含样本量、均值/中位数/样本方差/SD、未知数、费用上界、全部失败分类、配对与机制证据。
- [预检与门禁证据](phase10-preflight-evidence.md)：真实模型、Docker、Harness/MCP、D17/D16与最新1105测试。
- [规格合理性评审](../reviews/task105-spec-review.md)及[公开契约修正评审](../reviews/task105-public-contract-review.md)。
