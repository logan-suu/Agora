# T10.6 录制预检与修复

日期：2026-09-11。本文按发生顺序保留历史预检快照，下文的“当前”“尚未”“待确认”和“进行中”均指各条记录时点。此前录屏、完成归档、清理修复及1185项完整回归已验证；成片现已按Leader要求删除，待优化完成后重录，统一见[最终证据索引](task106-evidence.md)；本记录不替代10.7出口或10.5冻结评测。

## 本机与浏览器

- 在现有Mac上执行正式`pnpm run setup`、`pnpm run doctor`、`pnpm start --port 3106`和`pnpm stop`。Node24/pnpm9.15.9、真实Docker/Git、POSIX文件helper和Keychain入口可用。没有把复用开发机描述为全新安装。
- 使用隔离`AGORA_DATA_ROOT`，预检没有启动用户任务或改动其他项目。原始截图、运行日志及录制工具证据留在私有`.data`/临时目录。
- 会话无Browser技能，按frontend-testing-debugging回退到现有Playwright/Chrome；没有新增产品依赖。原生WebM可解码到PNG，录屏工具有效。
- Team行出现Model按钮后，原`span:last-child`选择器不再匹配文字容器。修复前实测Agent名称/状态`display:block`、同一行；补充`.team-row > span + span`规则后为`grid`分行。1440×1000桌面、390×844窄屏及模型设置弹窗检查通过，无页面异常、无横向溢出。初始尚未创建任务的GET404属于空状态。

## 失败反馈与交接

完整回归真实LRU任务曾在Coordinator生成handoff时触发`invalid handoff packet`。该次原始失败条目未保留，不能推断具体缺哪个字段。代码审查发现两条可独立复现的边界问题：

1. `set('testResults')`直接类型强转；缺失/类型错误的失败字段可进入State，后续交接才报错。四类输入通过领域测试复现红灯，修复后在State写入前拒绝。
2. 真实测试工具在无TAP位置、非零退出或超时时使用`file:''、line:0`。原Coordinator无条件拼出`:0`，违反既有fileRefs语法。定向测试证明正常角色交接会因此失败。修复保留完整`testResults`和openIssues，只为有效位置生成引用；离职交接与投影复用同一语法判定，不编造源码位置。

TESTER产品提示与Phase0回归提示补充失败对象格式及无位置表示。清理旧结果继续允许`undefined`。接口未改，不清空失败以换取通过，不改变D17可信测试receipt或D16最终权威。

## 计费与验证口径

Leader分别授权官方完整回归USD0.25、Go `deepseek-v4-flash`演示最多2次/USD1配额折算，失败请求也计入。新账本独立于10.5。官方测试保留现有凭证和全部测试；Go录制使用正式产品入口。

临时官方费用保护最初以32K拦截Harness实际256K输出上限，请求未外发，账本0请求。确认锁定适配器和真实请求参数后，改为按实际请求上限及调用时段预留，不修改请求。费用按历史/现行费率中较高者保守计入；[官方费率](https://api-docs.deepseek.com/quick_start/pricing/)于2026-09-11核对。Go按[官方峰值配额费率](https://opencode.ai/docs/go/)保守预留和结算，unknown/HTTP/传输异常停止后续请求、在途流自然闭合。

最新3文件146项领域/编排定向回归通过；完整回归、最终构建与录屏结果在任务notes和最终演示索引更新。早期失败保留，不将失败运行描述为完整通过。

## 首次浏览器启动暴露的绑定问题

2026-09-11T18:46:52Z，正式浏览器输入`quote-demo-1`后点击Start task。创建失败，服务端报`invalid model record shape`；未持久化TaskState、Go账本零请求，失败录屏保留。原因是生命周期将含`requestId`的TaskStartInput作为scope传入，ModelSettingsService.freeze以`...scope`复制了额外字段，严格绑定存储拒绝记录。原服务测试仅传两个身份字段，未覆盖真实组合。

先补充带requestId的实际输入形状，复现红灯；freeze改为显式选取projectId/taskId，保持存储exact-key门禁与首次绑定不可变。2项真实JSON存储/配置测试通过，随后重跑完整回归。此失败作为第1次尝试留档，不冒称成功录屏；第2次必须使用修复后的构建。

前一版完整回归153文件1181项通过、零skip，428.97秒；官方累计51请求/保守USD0.048020552、无未结算。绑定修复后的全量结果另记，不将旧版检查冒充新版本验收。后续官方请求按2026-09-11已核对的现行费率预留与结算，既有偏高保守扣账保留不退回；总授权仍USD0.25。

## 绑定修复后的复验快照

`pnpm typecheck`、`pnpm lint`（398文件）、Next生产构建与`git diff --check`通过。完整`pnpm run test --config <仅计费审计的临时配置> --maxWorkers=1 --bail=1`：153文件1181项通过、0skip、400.28秒；配置仅增加费用观察，不排除测试或修改请求/响应。真实官方DeepSeek、Harness/MCP/Git/Docker与各阶段链路均执行。原始完整日志SHA256：`bd7ecd57ad26e6513183f6080ce5a7211658eda615badbe9bb390c3d715899f3`。

官方账本累计73请求、USD0.061306952（前序按较高旧费率保守计价），低于独立USD0.25授权；Go累计1请求，usage仍unknown，已用请求前完整预留上界保守核销USD0.0128796，低于USD1。两账本均无悬挂预留。Go停止标记保留，正式本机演示服务已停止，没有继续收费请求。

## Go 会话路由修复与最终源码回归

Leader追加授权最多2次接口诊断和第3次录制，继续共用原Go USD1上限，不增加费用预算。第1次诊断保留了HTTP400的MissingSessionID安全错误；Go官方接入说明要求稳定的`x-opencode-session`。兼容适配器现在仅对Go从真实Harness request.sessionId注入此头，连接测试使用唯一会话ID。定向红→绿覆盖并发会话隔离、同会话多Step稳定、其他提供商及作用域外请求不污染；3文件17项通过。第2次正式连接测试HTTP200且ok=true，验证修复。

计量器仍透明转发请求/响应；若提供商缺少可选缓存细分，则把全部已报告prompt tokens按未缓存费率保守计价，不把未知总usage记零。两次诊断旧计量没有可用usage，各按完整预留上界USD0.0015273核销，保留raw usage unknown。第3次录制首请求已取得完整真实usage。

最终源码的typecheck、lint、Next生产构建通过；完整回归154文件1182项、0skip、397.92秒。配置仅增加费用观察并串行执行，未排除任何测试，真实官方DeepSeek、Harness/MCP/Git/Docker链路均执行。官方账本累计94请求、保守USD0.075817100，无未结算，低于独立USD0.25授权。完整日志SHA256：`a8c1697ea4882feefc22a14569754aac660c388942406b0855eb52afe0c775a8`。后续录制结果以[当前证据索引](task106-evidence.md)为准。

## 连续需求投影修复

第三次录制触发旧架构1000与新报价16800的blocking异议，当前State两条需求正确。CODER无requirements切片、leaderDirective仅最新一条，导致前一条900分对后启动worker不可见。按既有授权先停录，修正规格，补currentRequirements只读系统切片与当前需求优先规则；真实最小回归红→绿，3文件44项通过。详见[证据索引](task106-evidence.md)，完整回归另记；不将先前154/1182成绩冒充新源码检查。

## 当前修复版本最终检查（等待Leader裁决）

currentRequirements修复后，typecheck、lint（399文件）、Next生产构建和diff空白检查通过。完整回归154文件1183项、0skip、349.02秒全部通过，包含真实DeepSeek、Harness/MCP/Git/Docker与Phase9并行、重投影、Fork和归档链路。完整日志SHA256：96181f462a0e14b6be1d517482f1812819a9dad9c53b657a853faaafd4686581。

防御性复制检查在同一恢复对象上修改投影后重投，确认未污染状态。28个变更候选文件的密钥模式检查0命中，6份材料本地链接0断链。官方累计112请求、保守USD0.085056104/0.25；Go累计24请求、保守USD0.065782440/1，均全部结清。

正式演示实例已停止，耐久gate、工作树和会话保留。尚未执行Leader reject，也未到D16完成终审。收到真实裁决后，以当前构建恢复同一quote-demo-3，修正旧实现并重新测试/评审，再请求D16终审。当前修复和回归通过不等于T10.6录屏完成或10.7出口完成。

[2026-09-11 Leader裁决与UI刷新修复] Leader回复“按照你的建议”，22:41:04Z经真实浏览器提交reject_objection，canonical actionId=181dbf24-1db8-4298-a341-1e75698ca836，保留900/16800要求。后台TESTER识别14项中2项旧值失败，CODER返工，重新验证14/14；REVIEWER批准，验证/审阅绑定14974b70d5f188ffca9a5653f57ec6331b91a5b2，receipt=wave-validation:7cdfacc3-fc35-4010-933c-a04a2e5cd3c4，controlFingerprint=960ee4c1f756f0106eee893f0a98bb10b5f40c3d37aab4b2b9fae4af3a0b2587。Leader随后明确“批准完成并归档”，授权当前D16 gate human-gate:rv-24c0250e-eeea-4bb9-9932-9da6c582a624-1；按承诺待当前验证后才执行，不重复询问。
另发现前端暂停时停止轮询，成功提交裁决后只刷新channels而不刷新任务，UI仍needs_attention；假设①客户端未重读（浏览器reads=1且POST成功、源码确认），②服务端未恢复（后端真实测试/返工排除），③API错误（成功响应与受控复现排除）。停止受影响录制并正式drain到D16 gate，不中断模型流；最小修复让成功消息触发一次服务端任务快照读取，再按真实runStatus恢复状态/Trace轮询，异步旧作用域仍受active保护，读取失败不重发消息。受控Chrome复现由失败reads=1转通过reads=4，无模型调用；typecheck/lint/生产构建通过，完整回归进行中。UI修复不改变候选代码或模型执行语义。
