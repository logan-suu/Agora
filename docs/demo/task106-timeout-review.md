# T10.6 录制3超时审查

日期：2026-09-12。Leader要求先审查超时，不切换提供方、不开始新录制。本次审查只读取既有证据并执行本地合成HTTP/请求头检查，没有新增付费请求。Go仍为原配置。

## 结论与证据边界

直接失败链已确认：Go的B会话明显慢于同批A会话，当前自定义120秒等待策略触发TIMEOUT；最后一个请求取消后usage未知，录制计量器按“异常停查”写stop.json。之后官方Harness发起的两次重试被本地guard拦截并映射为TRANSPORT，没有再次到达Go。因此不能称“Go连续三次重试均超时”，也不能以部分HTTP200和usage证明模型完整成功。

服务端为什么对B很慢仍为inconclusive。没有Go内部排队/路由日志，也没有当时完整逐网络块时间线；不能断言某个上游节点故障、账号限流或缓存路由错误。录制2的HTTP400属于另一事件，不能与本次TIMEOUT混为同一根因。

## 三项假设核查

| 假设 | 证据 | 结论 |
|---|---|---|
| Go侧响应慢触发本地阈值 | A的5个请求约0.779–10.199秒；B的已结算请求约82.149–250.617秒。B第一步首个有效原生chunk在119.514秒才到达，136.870秒结束；最后一次120.001秒AbortError | B链路延迟显著、超时触发属实；Go内部成因未确认 |
| 本地等待策略过于紧 | compatible-model.ts显式SDK timeoutMs=120000、Go streamIdleTimeoutMs=120000；锁定dsh-llm-pi-ai原生DEFAULT_STREAM_IDLE_TIMEOUT_MS=300000 | 当前120秒是Agora覆盖值，不是1M上下文或384K输出容量，也不是费用预算；低于插件原生默认，需评审恢复正常有界策略 |
| 计量包装破坏取消/凭证或会话缺失 | 原样Request克隆与observeResponse包装加入真实本地HTTP+强制GC测试，30.59秒通过：旧连接关闭后才重试。真实Harness请求头检查确认deepseek-harness/0.1.1-rc.2及稳定session ID。实际录制账本全部请求含会话头 | 未复现取消信号丢失；无会话头缺失证据。不能以一个本地测试完全排除实际网络差异 |

输入规模仅约4.7K–7.3K，B已知输出41–633 token，远低于配置容量；没有CONTEXT_WINDOW_EXCEEDED、401/403或429证据。B响应未报告缓存字段，不能把“未报告”解释为确定没有缓存，更不能据此定位上游路由。

## 原生时间语义

锁定dsh-timeout idleWatchdog只在等待iterator.next()时计时，向原生迭代器发送取消信号并等待其响应，不是对整个任务设置总时限。dsh-llm-pi-ai在toStreamChunks之后等待，SSE心跳或仅连接建立不必然构成有效模型进展。故一次HTTP完整结算超过120秒不等于watchdog没有工作；历史失败流的完整字节结算还可能晚于Harness失败事实。未保留逐块时序的步骤不能反推出精确空闲区间。

B turn 3 step 3：17:35:17.431Z发出，17:37:17.432Z记录AbortError/usage未知；17:37:17.435Z官方TIMEOUT；17:37:17.927Z原生retry1被本地stop guard拒绝，17:37:17.935Z为TRANSPORT；retry2同样未出网，17:37:18.973Z turn error。计量器的停查行为是既有约定，最终诊断必须同时查看官方Trace和传输账本。

## 已完成修复与后续

发送中草稿覆盖修复已通过真实浏览器慢响应/失败重试检查、typecheck、lint及规范生产构建；完整161文件1216项0skip通过（415.26秒，日志SHA0d7d425a95d831402818be3afba30aa70aa2c8eadad5ea7854a72531f6ad396f）。官方新增17请求USD0.013468122，累计385请求USD0.252132812。录制3共16个Go请求、已知折算USD0.028903908、1次usage未知；此前另有1次未知，不能宣称精确总额。录像已按Leader要求删除，保留hash、State、session及失败审计。服务已正式停止。

建议先保留Go，分别核验请求头等待和流空闲等待，评审恢复Harness原生有界等待策略，而不是无限加长超时或直接换服务；下一次小范围验证应记录脱敏的响应头到达、首个有效chunk、最后有效chunk、取消时间及原生失败代码。只有验证通过后再开始新录制。本次审查尚未改动超时参数或启动新模型任务。

本地证据：.data/demos/task106-20260911/audit/english-recording-3/timeout-timeline.json、request-latency-summary.json、failed-recording-summary.json、composer-validation/result.json。请求头/取消测试日志在/private/tmp/agora106-qa/recording-timeout-headers.log和recording-meter-cancellation.log。

外部约束：[OpenCode Go官方文档](https://opencode.ai/docs/go/#where-can-i-use-it)要求客户端标识及稳定会话头用于路由与缓存；该文档不能证明本次具体慢请求的服务端原因。

## 审查后已批准的恢复（2026-09-12）

[2026-09-12 Go等待恢复执行] Leader回复“那就这样继续”，批准先补诊断、恢复正常有界等待、小范围Go验证及完整回归，再英文预演与重新录制。opencode.ai SDK与idle统一300秒，normal最多2次重试不变，正常1M/384K不变。RED阶段3个180秒合法等待/360秒持续流案例失败，修复后6个等待边界测试通过，连同会话/推理兼容共3文件8项通过。诊断只记录时间、用量、脱敏状态，合成SSE分片/心跳/取消本地2项通过。完整回归、真实Go与构建待完成；未切换服务、未录制。

真实Go合成验证已通过：同一原生Harness循环3次HTTP200、两次probe执行、最终OK，1M/384K。前两次响应头564/501ms、完整1264/1048ms；第三次响应头96902ms、首个有效内容96910ms、完整96947ms。第三次延迟主要发生在响应头到达前，不能据此确定是服务内部排队、路由还是网络建立阶段。该实测未超过旧120秒阈值，300秒修复的边界证据来自RED/GREEN本地原生Harness测试，不能声称已在真实Go复现并消除全部超时。新增3请求已知USD0.000696108，Go累计325请求、已知USD0.502408080，历史2次usage未知仍保留。来源audit/go-waiting-validation/live/{timing.jsonl,result.json}。

[2026-09-12 Go等待恢复验证完成] 161文件1221项0skip完整通过（398.08秒，日志SHA4eac3cdc4a35c81f30b39d310ea401a90dd9c9d29bb1ebd29f1421010e79b064），typecheck/lint/正式生产构建/doctor通过。新增时序观察器本地分片/心跳与真实HTTP强制GC取消验证通过。Go合成3次成功、两次工具调用；第三次响应头96.902秒到达，总96.947秒。官方新增16请求USD0.010728864，累计401/USD0.262861676；Go累计325请求已知USD0.502408080，历史2次未知保留。现开始无录屏全英文预演quote-en-rehearsal-4，1M/384K、Go服务不变；消息回执按本次display精确关联，逐次canonical复核。新候选须Leader终审。

[2026-09-12 Git环境指引修复与验证] 预演4停于TESTER反复搜索容器Git，并非新Go超时：49请求全部200、用量完整，USD0.094315980；后续3次由本地停查guard拦截未出网。MCP git_applyPatch/git_diff实际已授予，固定镜像无Git CLI，产品遗漏了Eval既有环境说明。已将MCP Git/禁止CLI探测/运行时核验HEAD指引共用于文件角色及波次验证；不扩权限、不新增循环。合成真实Go TESTER在Docker中6请求/6工具执行完成写测试、运行、MCP提交及diff，0shell Git，累计1项测试通过、干净HEAD；首轮夹具baseDir错误在付费前被正确拒绝，保留日志后修正夹具。完整161文件1221项0skip再次通过（384.56秒，SHA04226928a6c1424ab6fd19d5b13dab9fa865c19ad01f2184978d0d5073a00f5e），静态及正式构建通过。官方累计415/USD0.270997166；Go累计380/已知USD0.598734984，历史2次usage未知保留。源清单SHAc252bc63371d1ef931cd242e17c928338da158bd9253037faa47f80e5d11562f。预演4服务/浏览器已关闭、8份会话及State扫描0泄漏，无录屏无完成候选。接下来无视频预演quote-en-rehearsal-5，A/B真实并发请求发出后及时发送两条有序需求变更，逐字段核对canonical回执。

[2026-09-12 架构交接恢复修复] 预演5的5次Go请求全部200、USD0.012789288，无新超时；ARCHITECT将conventions嵌入architecture，通用格式修复两次仍失败。保持严格schema与原生两次无工具上限，增加受信角色静态outputFormatHint并由生产组合根接入，执行器不理解/自动修改schema，不传原异常文本。新增嵌套错误回归RED/GREEN，格式/重试27项通过；一份合成错误注入后，真实Go仅一次纠正即恢复双顶层字段并保留conventions值，USD0.000582。Go累计386请求、已知USD0.612106272，历史2次未知保留。预演5已正式stop、浏览器关闭，2份会话及State扫描0泄漏，无视频/候选。静态与正式构建通过，完整回归待收尾；下一轮无视频全英文预演6仅已准备，尚未启动。

[2026-09-12 格式恢复完整验证] 161文件1222项0skip完整回归通过（409.70秒），静态/正式生产构建与真实Go合成格式纠正通过，source/hash/计量见audit/format-hint-validation/result.json。测试配置可选字段的纯类型修正后另跑27项格式/重试测试通过，生产逻辑未变化。现在开始无视频英文预演quote-en-rehearsal-6，保持Go 1M/384K与300s等待；新候选仍须Leader终审。
