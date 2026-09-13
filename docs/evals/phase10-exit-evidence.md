# Phase 10 出口验收证据（T10.7）

日期：2026-09-12（America/Chicago；UTC为09-13）。基线：`dev-1.0.0` 的 `a18d7ec`；分支：`codex/phase10-exit-acceptance`。Leader已确认[实施计划](../reviews/task107-exit-plan.md)。本轮新增独立出口测试、外部模型真实解释G5和本文档，未修改生产代码、依赖、State schema或冻结端口。本段为09-12实施快照。10.7保持`in_progress`；09-13交付复验见下文，任务done与阶段收尾仍须人工PR合并及`agora-pr-merge`。

## 口径与来源

控制规格为蓝图§1/§21、详细设计§3/§6/§7/§11.9/§11.10、开发计划§13、task-status及延期台账。逐字约束：

> 出口仍运行适用的完整回归和真实跨包/G5链；不得skip、移除凭据或改断言来凑绿。

> 旧的冻结Eval不得重算或混入本轮数据。

> 五条成功标准保持，其中“自主完成全流程”指正常阶段可推进、普通缺陷有界返工，最终完成仍须D16 Leader终审；“上下文不崩”应验收投影/官方压缩/容量配置与有界错误处理，不作为无限上下文质量保证；“可扩展”不扩大DEF-016/017范围。

证据分三层：出口测试仅脚本化外部模型回复与等待时机，Harness/工具/安全点/Fork/生产验证器全部真实；独立live G5使用真实官方模型解释合成需求；浏览器使用真实生产页面，其中竞态和新增显示消息明确使用夹具。脚本模型、浏览器夹具、历史视频均不冒充本轮自主模型成功率。

## 本轮执行

环境：macOS、Node.js 24.20.0、pnpm 9.15.9、真实Docker与Git、受信原生helper；生产Next.js构建；Chrome channel、Playwright 1.62.1，1440×1000与390×844。Browser plugin不可用，因此使用已有bundled Playwright，无新依赖。

| 验证 | 命令/入口 | 结果 |
| --- | --- | --- |
| 原生helper | `pnpm build:sandbox-native` | 通过 |
| G3 | `pnpm typecheck`、`pnpm lint` | 通过 |
| 独立出口 | `AGORA_PHASE10_EXIT_EVIDENCE_DIR=.data/verification/task107/exit-chain pnpm exec vitest run tests/integration/phase10/phase10-exit.test.ts` | 2/2；最终测试25.117s，总26.42s；证据目录在执行前为空 |
| G4累计默认回归 | `pnpm run test --config /private/tmp/agora107/regression.config.mjs --maxWorkers=2` | **168文件、1259测试全部通过，0skip，224.44s**；包含Phase0–10、跨阶段和已配置真实模型测试 |
| 独立真实解释G5 | `pnpm exec vitest run --config /private/tmp/agora107/live.config.mjs tests/evals/phase10/natural-input-live.eval.ts -t 'phase10 natural input live G5'` | 1/1；测试3.46s，总4.16s；不是Benchmark attempt，不进入默认测试 |
| 生产构建 | `pnpm --filter @agora/web build` | 通过；有Node URL旧API弃用提示，无构建错误 |
| 正式启动 | 专用`AGORA_DATA_ROOT`下`pnpm run doctor`、`pnpm start --port 3107` | doctor及生产服务通过；页面刷新读取真实持久状态；验收后同root执行`pnpm stop` |
| 浏览器 | 私有证据中的`scroll.cjs`、`follow.cjs`、`rendered.cjs`、`natural.cjs`、`scope.cjs` | 两宽度与四种作用域竞态通过；无页面异常、无横向溢出 |

回归配置导入原始`vitest.config.ts`，只追加不记录输入/密钥的用量观察setup；没有skip/exclude、移除凭据或删改默认测试。live配置同样导入`vitest.eval.config.ts`，仅显式选中新G5，不启动冻结Benchmark。完整回归之后只新增独立`.eval.ts`入口，已单独实测及重新typecheck/lint；生产和默认测试源码未再改变。

实际用量记录：默认回归18次官方请求，估算USD0.010005168；live解释1次，估算USD0.000478050；合计19次、HTTP200且usage完整，估算USD0.010483218。采用既有审计费率口径，并非供应商账单或实时价格承诺；无Go请求，不混入任何冻结账本。

## 独立生产链与权威边界

入口：[phase10-exit.test.ts](../../tests/integration/phase10/phase10-exit.test.ts)、[exit-fixture.ts](../../tests/integration/phase10/exit-fixture.ts)。使用真实MessageRuntime、TaskOrchestrationRuntime、WebTaskComposition、全局cap3 Scheduler、HarnessRequirementInterpreter、HTTP handlers、State、SSE、MCP、Git/Docker、JSONL。

主任务`phase10-exit/natural-exit`有A/B并行、C依赖二者的显式DAG。模型夹具必须读实际工具结果才能继续，测试并非预先伪造测试报告：

1. 两个CODER活动期间由第三个lease解释关联需求；确认前State不变，经真实cohort安全点才将a=2/sum=5原子改为a=4/sum=7。稳定输入/确认重放不重复解释或应用，跨任务确认409。
2. 在真实TESTER验证Step中请求D4，等待自然step/end后持久gate；此时无产物，lease=0。Leader resolve后新Context/官方seed真Fork再执行。官方Trace确认恰一个TESTER child且父节点存在、seedLength>0。
3. REVIEWER活动期间确认第二组保留既有功能契约的关联需求，控制指纹改变使旧验证失效；重新验证从上一精确验证HEAD继承全部测试，没有重新执行CODER波次。累计测试数依次2、5、8、10、13，原有测试逐字保留。
4. 完成候选仍保持isRequestSatisfied=false；预声明的合成测试Leader先request_changes，再对新review批准。CODER/TESTER/REVIEWER均收到经验证、resumed=true的completionFeedback；gate/done下新草案确认409。
5. 批准后completion receipt绑定同一accepted验证回执；8个归档文件（3源码、5测试）与验证工作树逐字节一致。新Docker独立重跑13测试、0失败。新runtime读取completed，真实SSE覆盖74条main消息且不带payload；官方Trace包含19个session并证明CODER时段重叠。任务worktrees空、lease=0，验证容器在finally回收。

本次保存的accepted HEAD：`47a18a0e43cab1d7d7984a51d6f5bfa550d7acd9`；回执：`wave-validation:c9c2f97e-8d91-44d7-83aa-69814afb0144`。这些身份属于合成出口任务，不能替代用户产品任务的Leader裁决。

第二测试在真实cohort等待期间通过规范串行commit改变草案依赖事实；安全点后二次检查返回409，没有部分应用关联需求、没有confirm消息。后续仅进入未批准completion gate，不能宣称完成；清理后无占用lease。

独立[live入口](../../tests/evals/phase10/natural-input-live.eval.ts)使用官方`deepseek-v4-flash`解释合成票价1000→900及总价17000→16800，经正式消息handler确认关联需求，保留不处理支付约束；重复原输入和确认都幂等，新runtime重新读取一致结果。全部依赖真实，仅输入是合成数据。它验证自然语言解释与应用，不宣称另一次完整自主编码任务。

## 五条标准及E01–E12

| 成功标准 | 本轮证据与边界 |
| --- | --- |
| 闭环 | 新出口跨包链、DAG、累计验证、D16返工/批准/归档；真实模型LRU等既有默认入口本轮重跑。不能从脚本模型推导自主成功率 |
| 产品形态 | 真实生产构建/doctor/启动/状态恢复、桌面和手机浏览器、真实官方Trace。已有英文成片由Leader接受，本轮未重新录制；未实测空白Mac完整安装 |
| 协作可控 | 本轮D9确认/过期拒绝、安全点、D4真Fork、D16；既有Channel/roster/离职/接手专项在完整回归中通过 |
| 工程质量 | 完整静态/回归、真实Docker工具与归档复验、故障恢复/官方压缩/容量专项；公开/holdout冻结审计分别可追溯，不宣称无限上下文 |
| 可扩展 | 既有模型设置、绑定/Fork、角色生命周期、MCP权限专项本轮回归通过；DEF-016任意自定义角色自主调度与DEF-017 Linux产品适配仍延期，不新增云端路线 |

| 优化项 | 本轮验证入口与结果 |
| --- | --- |
| E01 | message-content/markdown专项通过；真实PM原文展开与持久display完全一致；浏览器合成JSON和独立完整agora-result节点折叠，脚本不执行、图片不请求、javascript链接无href、普通代码保留 |
| E02 | task-overview/chat-ui专项及两宽度真实页面；完整goal展开、切换重置，服务端completed独立可见；侧栏/Team布局可读 |
| E03 | 原生12px轨道；真实滚轮、滑块拖动、Home/End；精确32px跟随、33px保留位置；稳定msgId重放不增加未读、键盘跳最新/手动回底恢复、切换与刷新重置、输入框固定。新增显示事件为合成SSE事件，不写State |
| E04 | chat-ui/run-error专项；浏览器同msgId失败重试、草稿保留、四组旧成功/旧失败×切离/切离再返回竞态；真实最终状态和刷新。竞态HTTP响应是夹具 |
| E05 | 新跨包两项+独立live G5；浏览器可读关联前后对照、刷新恢复、失败后同ID确认、stale禁用；请求只有proposal引用，无浏览器自报mutations |
| E06 | 本轮D16 request_changes到新review再approve，三角色反馈/resumed断言；completion-feedback专项完整回归 |
| E07 | 主链最新有效价格与独立assignment工具行为、TESTER validationScope；assignment-project/project专项完整回归 |
| E08 | 本轮旧回执失效复验、精确HEAD、累计测试逐字继承和新Docker重跑；既有wave-validation/reducer/coordinator/Phase9专项完整回归 |
| E09 | model-capacity/model-settings及phase10-model-settings完整回归；已知预设/手动值/旧binding保留，官方压缩真实压力测试仍执行；不改冻结容量 |
| E10 | compatible-timeout/cancellation/session/reasoning和resilience完整回归；本轮无新增Go在线请求，Go历史实测与冻结结果单列保留 |
| E11 | 英文modules+DAG和真实CODER Trace重叠；MCP Git实际提交；complexity/output-repair专项完整回归 |
| E12 | 既有accepted英文视频/媒体仍为历史证据；新出口归档、精确HEAD、新runtime刷新和资源清理独立通过；冻结Benchmark只读审计通过 |

浏览器真实后端数据来自保存的出口根目录；为保留归档绝对路径，92个文件按原路径恢复并逐一hash匹配，无State重写。页面默认project=agora，真实数据访问仅将请求query的projectId改为phase10-exit；响应仍来自实际服务。竞态/natural UI另使用显式本地HTTP夹具。默认尚不存在的lru-demo返回404属于夹具初始作用域，未将其计为页面异常；无其他未处置应用错误。截图/报告记录真实数据与合成新增消息的区分。

初次验证出现的是测试接缝/选择器问题：typecheck纠正不存在的顶层完成字段，改用规范coordination ledger；空任务切换等待空快照而不是不存在的消息行；结果标签夹具由inline段落改为规格支持的完整HTML节点（经真实Markdown AST确认）；手机点击抽屉外露backdrop而非被抽屉遮住的中心。未改生产行为或弱化权威/安全断言，失败日志保留。出口测试直接通过时如实记录，不人为破坏生产代码制造红灯。

## 冻结Benchmark只读审计

审计脚本核对原groupFingerprint、冻结源码文件hash、每次result与归档一致性、task/model/output/image身份、全部artifact引用、重复次数、已报告均值/样本方差及失败分类；只作一致性复核，不改写冻结指标文件或生成新的成绩。

- 公开v11：365源码文件、36归档引用一致，12格各3次；原33/36与3次失败完整保留。sourceFingerprint=`f1352ccf5d20bf6d8a0e343e8d53a076650a6ea1e6f5fd0c8d45d2dbc447316e`。
- 内部v14：369源码文件、18归档引用一致，6格各3次；原14/18与4次失败完整保留。sourceFingerprint=`93cafece021f1c5ada5a7db7173738405317a11569665ec555ba82efdd89f1e4`。
- 两组源码不同，公开/holdout及四比较语义沿[最终报告](phase10-opencode-go-final-report.md)分别解释；无合并成功率、补跑或模型调用。原unknown usage和审计预留上界保留，不以估算冒充reported usage。

## 证据索引与交付门禁

私有原始证据保存在`.data/verification/task107/exit-chain`、`regression/official-requests.jsonl`和`audit/`；不进入Git。`audit/`含命令日志、观察器/config、浏览器脚本/JSON/PNG、冻结审计和SHA-256清单。公开文档仅记录合成任务身份与脱敏摘要。

| 证据 | SHA-256 |
| --- | --- |
| audit/full-test.log | `5bc9bf783b21dfa80cad8efd59caa235aaafc20a8b8ebc53d3dfb58f498cf66e` |
| audit/exit-final.log | `334a055cc1cb1f9f68ab66f1389cadf6ca74d76f3f781239ffc2f84ee8866b72` |
| audit/natural-live.log | `f0319db6bbb25f14d7bee7d495ded773361a72f6b9f887e23968bf24422b809f` |
| audit/benchmark-audit.json | `118b57eb12c8fc130b45f22b487e180e700d06c7ab926f54378135041188a28d` |
| audit/rendered.json | `d97c0eb7780745c9606c0d46c887fc471dc2f942a2c362ffe4b6996ded3edda3` |
| audit/chat-follow-report.json | `d653fe995ae47eb32eb7114dd1324793baf1311dba34f5cf0bc0e38c3daefefa` |

G1规格/来源已校准，G3/G4/G5已实测，G6记录本文及task-status；G7对本轮拟交付文本做gitleaks检查，原始证据留在gitignored目录。未新增未处置产品缺陷或延期项；DEF-016/017按台账保留。正式交付前仍执行agora-commit规定的提交检查，本次没有自动提交或推进done。

## 2026-09-13 交付复验

Leader显式调用`agora-commit`授权提交、推送与创建PR。分支调整为`test/phase10-exit-acceptance`，远端`dev-1.0.0`仍为a18d7ec；生产源码未变。

- `pnpm typecheck`、`pnpm lint`通过；默认完整回归再次168文件/1259项全绿0skip，229.21s，含独立出口真实链2项（23.385s）。命令为`pnpm run test --config /private/tmp/agora107-delivery/regression.config.mjs --maxWorkers=2`，仅追加同一用量观察setup，不更改include/exclude或凭据。首次`pnpm test --config ...`因pnpm快捷命令未转发参数而在测试启动前退出，原日志保留；使用run形式后正常执行。
- 显式`natural-input-live.eval.ts`真实模型G5再次1/1通过，测试2.483s，总3.26s，使用同目录live.config.mjs；未运行冻结Benchmark。
- 本轮交付官方请求17次回归+1次live，18次均HTTP200且usage完整；按既有费率估算回归USD0.010916922、live USD0.000237138，合计USD0.011154060。与09-12的19次/估算USD0.010483218分别记录，不替换历史日志或冻结账本，无Go请求。
- 敏感信息扫描覆盖8个拟交付文件，gitleaks无泄漏；文档链接、任务依赖与git diff --check核对通过。PR链接及提交身份写入task-status notes；10.7不提前标done。

交付私有证据：`.data/verification/task107/delivery/`（命令/config/日志/hash清单）与`delivery-regression/official-requests.jsonl`。`test-full.log` SHA-256为`a7a1f100724d316b76745e533eb48b01b8ae1faaa4eaf728e1bec0c89e84b3c7`；`live.log`为`9948e8262d9e766954914c621f8c85d6473a9159725e9f57e17432f8faec43f0`。以上为当前交付门禁；正文中的09-12未提交状态及测试数量/费用均为当时快照。

## PR #76 评审修复（2026-09-13）

Leader授权修复两项P2测试缺陷。此前live G5仅检查数字子串，可能把1900/11800/116800及未请求的场地改价误判为正确；角色entry barrier无失败出口，Vitest整体超时不展开测试体finally。修复不修改生产源码或冻结接口。

控制原文：详细设计§11.9“保持非目标和未请求的验收条件。”；已确认计划规定“所有资源清理动作都尝试并保留原错及清理错误。”

- `natural-input-checks.ts`为本合成英文场景逐字段核对完整数值、cents单位、票数/小时数、未改场地价格和两项nonGoals；允许英文two/three、数字分组与措辞变化，不做整句匹配，不是通用自然语言语义判分器。真实live入口在确认前调用该检查器，持久化/重放检查独立保留。
- `exit-wait.ts`为每个CODER/TESTER/REVIEWER进入等待设置20秒截止，监测真实runtime失败/结束，保留状态读取错误，结束时清除计时器。cleanup只取消测试侧进入等待、释放脚本barrier，不取消Harness模型请求；fixture与SSE/独立验证沙箱注册`onTestFinished`钩子，与正常finally共用一次清理Promise。drain后再读取最新composition列表回收，所有清理错误继续保留。
- 新增断言/等待回归：初次14项中11失败、3通过，证实原缺口；修复后14项全绿，后补2项清理取消等待的回归。错误票价/票价总额/组合总额/场地价格/数量/非目标和额外错误数字均必须拒绝，正确改写必须通过。
- 真实出口专项4/4通过（30.962s）：保留原2项，并增加PM提前失败、真实CODER活动时等待截止两条路径；两者均验证lease=0、临时根目录已删除。真实官方模型解释G5再次1/1通过（2.240s），未启动冻结Benchmark。
- 单独临时探针故意触发Vitest 3秒整体超时，日志保留1个预期失败；实际结束钩子继续执行，afterAll验证真实worker drain、lease=0与根目录移除。总9.12s。它是失败清理机制证据，不计为默认套件通过，也不以skip或改超时断言隐藏失败。

修复后的完整门禁、CodeRabbit复核及提交身份见task-status最新notes。私有修复日志/config/探针留在`.data/verification/task107/pr76-fix/`，用量在`pr76-fix-regression/official-requests.jsonl`，不重写前述历史结果。PR保持开放、任务保持in_progress，未执行自动合并。

修复门禁：typecheck/lint通过；完整默认回归170文件/1277项全绿0skip，236.84s，包含新增16项校验/等待回归及4项出口真实链；独立live G5另计1项。只有用量观察setup附加到原配置，既有凭据、include/exclude及真实模型测试均保留。官方用量为30次回归+1次live，31次均HTTP200且usage完整；按既有审计费率估算回归USD0.014166966、live USD0.000190938，合计USD0.014357904。无Go或冻结Benchmark新请求，历史结果不变。`full-test.log` SHA-256=`db0b291b1d26c8b9df286eda6ec9b6c5481d6c97318b3be1be35675db3a7e4e3`；`live.log`=`ef10ba173ee3a7d6b89b06c60ed8bb20928066dedce214b30b4256bffb9e712c`；预期失败探针`runner-timeout.log`=`910b1fe17b56fb17bca5de4bea6f1937dcfc55fa6a2c33c37f427a08ff172ceb`。

包含新增文件的CodeRabbit复核进一步指出：只比较排序后的数字集合会接受金额/数量/时长互换。已用5项反例复现（5红），随后增加字段中的cents、票/人数、venue hours和计价单位关联断言；两张票/两人/三小时与1800/16800的关系分别校验，原完整数值检查继续拒绝额外错误数字。21项校验/等待测试全绿，真实模型G5再次1/1通过（3.382s），typecheck/lint通过。上面的1277项和31请求为这一追加修复前的快照；最终版本的全量回归与累计请求按后续记录，不把中间门禁冒充最终源码通过。

**最终修复门禁（同日，覆盖数字关联追加修复）：** 170文件/1282项默认回归全绿0skip，236.52s；包含15项价格/关联检查、6项等待回归及4项真实出口链。独立真实模型G5 1/1，3.382s。typecheck/lint与11个交付文件的gitleaks均通过，CodeRabbit最终覆盖全部11个修复文件并返回0 issues（此前包含新增文件的复核提出1项数字关联问题，已补5项红绿回归修复）。最终全量日志`full-test-final.log` SHA-256=`e468b9b1a757ee3ec7cc50dfc77b38d1730a4df925c1f93b01c1ffb466028b68`，最终live日志`live-association.log`=`f2a2b86cf7705c020576284d4e9c50522a7edbc6d183c0e11edc9c1a5c5d01f9`；CodeRabbit日志=`b18a389c91dc3c220978340b6b8fbac6d2e628279b4faf7c426a8cd2504233cd`。本轮修复累计55次官方请求均HTTP200、usage完整，按既有费率估算USD0.029965644；其中最后一次G5 USD0.000388338、最后一轮回归23请求/USD0.015219402，其余属于已记录的上一轮修复验证。无Go/冻结Benchmark调用，所有中间结果与预期超时失败保留。
