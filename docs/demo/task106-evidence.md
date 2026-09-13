# T10.6 演示证据索引

最新状态（2026-09-12 本地时间）：录制9已完成自然语言改价、真实确认、返工验证及 Leader 完成终审，产物已归档。新英文成片长 3分22秒，1920×1080，实拍片段保持1×、删去等待并说明返工；无音轨。归档6文件匹配15b4aa96，18项产物测试＋8项独立检查全过，工作树/容器已释放。视频播放与14处拖动定位检查通过，三个原片段无浏览器异常。成片、时间线和下载包见[新演示说明](task106-natural-chat-demo.md)。旧视频已按要求删除；下文早期暂停及待录制状态均为历史记录。T10.6仍保持in_progress，未commit/push。

历史状态（2026-09-12）：Leader指出录制6输入框直接发送JSON不符合真实用户体验；该视频撤出正式演示入口，保留原片/成片作为诊断证据及已批准产物。代码审查确认普通自然语言当前仅记chat/action none，不会更新需求；需先补齐真实用户需求变更交互、同步D9及验证后再录制。T10.6保持in_progress。此前技术验证和归档结果仍有效，不等于用户体验验收通过。

**[2026-09-11 英文演示要求]** 下次终版录屏全部使用英文，覆盖界面/系统通知、题面、Leader与Agent可见消息、展示的产物说明及媒体文案。历史中文运行保持原始证据；准备英文脚本与修正系统文案不等于完成新的全英文模型运行。当前继续暂停录制，脚本见[English recording script](task106-english-script.md)。

## 已验证的本次运行

后续全英文预演 `quote-demo-en-1` 未完成：900分返工后累计18项通过，但辅助脚本80请求阈值中断后续波次，未终审/归档。详情、失败及费用见[全英文预演记录](task106-english-rehearsal-evidence.md)；不与下面历史已完成产物混用。

项目 agora、任务 quote-demo-3。正式 macOS 本机入口、隔离数据、真实浏览器及生产 Harness/MCP/Docker/Git；六角色使用 Go deepseek-v4-flash，contextWindow65536/maxTokens8192。

- 19:09:44 UTC 启动。A 票价、B 场地费用独立，C 报价依赖 A/B。官方 JSONL 派生的 Trace 中两个 CODER 首 turn 重叠 **15.790 秒**，原片中泳道可见，非静态 running 标签推断。
- 正式 /requirement 将票价 1000→900 分，并把报价例子改为 1800+15000=16800。两个 canonical actionId 为 2ad98716-4a47-4d7a-809f-3c5dd76cf950、705f1a66-9372-443f-b9bc-b48a95930c37，均 applied。第二条等待 TESTER Step 自然结束后提交，属于非阻塞 reproject，不称为 Fork。
- C 因旧架构复制值和需求投影缺口提出 blocking 异议。停止录制，修复并完整回归后，Leader 拒绝异议，保留900/16800。22:41:04 UTC 经真实 UI 提交，actionId=181dbf24-1db8-4298-a341-1e75698ca836。
- TESTER 识别旧值导致14项中2项失败，CODER返工，重新验证 **14/14**，REVIEWER批准。最终测试/审阅完成于第二段停录后，不表现为连续镜头。
- Leader 已明确“批准完成并归档”，对应下面的候选；23:05:26 UTC已执行完成动作，canonical actionId=120cce5d-5f37-4327-96b2-e69ad2dd3188。

| 候选身份 | 值 |
| --- | --- |
| 验证/审阅提交 | 14974b70d5f188ffca9a5653f57ec6331b91a5b2 |
| 验证回执 | wave-validation:7cdfacc3-fc35-4010-933c-a04a2e5cd3c4 |
| 控制指纹 | 960ee4c1f756f0106eee893f0a98bb10b5f40c3d37aab4b2b9fae4af3a0b2587 |
| 验证文件 | validation/7cdfacc3-fc35-4010-933c-a04a2e5cd3c4.json |
| 验证文件SHA256 | abd13a2d3165784cc1a7b239c2b1d09bf47c2fcf8c67b7a27addbef984d9933a |
| 完成gate | human-gate:rv-24c0250e-eeea-4bb9-9932-9da6c582a624-1 |

另经 git show 读取同一提交核对：ticketCost(2)=1800，venueCost(3)=15000，quote(2,3)={tickets:1800,venue:15000,total:16800}，测试含零、负数、小数。生成代码未在宿主直接执行。两次gate的safePointRefs均为空，不声称发生paused worker真Fork。

## 尝试与源码边界

| 尝试 | 结果 |
| --- | --- |
| quote-demo-1 | requestId混入严格模型绑定，创建失败；0模型调用 |
| quote-demo-2 | PM首请求HTTP400；追加诊断确认Go缺少会话标识，未编码 |
| quote-demo-3 | 同任务跨两次修复暂停，返工/验证/审阅/Leader终审/归档刷新完成；录后清理补修也已验证 |

追加两次诊断已用完；第三次录制已授权，没有第四次新任务。Go专用头传递真实Harness sessionId，其他服务不受影响。Team布局、失败反馈准入/无位置引用、绑定与会话修复见[预检记录](task106-preflight-evidence.md)。

第一次停录：增加所有角色不可关闭的 currentRequirements 白名单系统切片，以当前需求优先于旧架构复制值，不扩大assignment权限、不投原始消息。第二次停录：needs_attention时停止轮询，成功裁决后只刷新Channel，导致旧任务状态残留；修复为成功消息重新读任务，再按服务端runStatus恢复轮询，失败不重发消息，旧作用域受清理保护。受控Chrome由reads=1且状态滞后转为reads=4且running，无模型调用。

源码起点dev-1.0.0：45ae0985b69d0173c01e5f08fc0db71415975fdb，分支docs/review-task106-spec，尚未提交。166执行文件manifest身份使用UTF-8 Python json.dumps(manifest, sort_keys=True)默认分隔符、无尾换行的SHA256：

| 版本 | manifest SHA256 | 与上一段差异 |
| --- | --- | --- |
| 第1段 | 27e7175011e434af9c4bd0205b36d20d5a00d006966ca47b7153a50790b6fa18 | 含Go会话修复 |
| 第2段 | affa490c29fe9b998455e32acc89c7230aef802902d31c61b841bdeb01b16e54 | project.ts/harness-executor.ts |
| 第3段 | 7a4e0f9a2eead0d4e1abda6e1deb93976ca9f86cf02a512a92ca0915363154be | 仅chat-workspace.tsx |

界面修复不改变候选代码或模型执行语义。没有重跑Benchmark；README只引用[10.5冻结报告](../evals/phase10-opencode-go-final-report.md)，本次演示不加入统计分母。

## 回归记录

| 版本 | 全量结果 |
| --- | --- |
| 模型绑定修复 | 153文件1181项0skip通过，400.28秒 |
| Go会话修复 | 154文件1182项0skip通过，397.92秒 |
| currentRequirements修复 | 154文件1183项0skip通过，349.02秒 |
| 界面刷新首次 | 2文件通过、1失败，23项通过、1失败，211.01秒，bail停止 |
| 界面刷新复验 | 154文件1183项0skip通过，407.06秒；SHA256 e9e13cd07c2c0a6bf516ba7a7305fdee14cc0bb34d444690a13b8c566a4ba101 |
| 历史工作树清理修复 | 154文件1185项0skip通过，443.27秒；SHA256 7ee9b16270c13c7e08623d0f1e9e4c263aa4a263596bd89dd70681269b8c6356 |

最新typecheck/lint399文件/Next构建/受控Chrome通过。首次界面全量失败于真实LRU的TRANSPORT；已准入请求均HTTP200且结清，累计费用加256K输出预留已接近USD0.25，初步定位预留空间不足。原计量器未记录reserve拒绝，具体失败因果未完全证实；已补安全拒绝日志。Leader将官方累计上限增至USD0.30，不移除凭证、不跳过测试。

历史完整日志SHA256：绑定版本 bd7ecd57ad26e6513183f6080ce5a7211658eda615badbe9bb390c3d715899f3；currentRequirements版本 96181f462a0e14b6be1d517482f1812819a9dad9c53b657a853faaafd4686581。原日志保存于私有审计目录。

## 费用与媒体

以下为录制与撤片前的历史费用和媒体记录；后续UI优化的累计费用及最新授权上限见文末验证记录，历史账本不重置。

Go独立累计USD1；官方回归累计由USD0.25授权增至USD0.30，历史费用不重置。增加授权时官方121请求保守USD0.090491198，Go48请求保守USD0.098492676，全部结清；最终官方167请求、保守USD0.120930992/0.30，Go48请求、保守USD0.098492676/1，全部settled，无悬挂预留。Go三次历史无usage请求按完整预留上界核销，raw usage仍unknown，不混称现金账单。

私有根目录.data/demos/task106-20260911含product/audit/media/raw；不发布原始State、上下文或工具参数/结果。含源码manifest、安全Trace、parallel-overlap、预算及操作时间。

| 同任务原片 | 媒体时长 | 字节 | SHA256 |
| --- | --- | --- | --- |
| 第1段19:06–19:18 UTC | 685.24秒 | 49124007 | 49cb29832d8433b9bbc1123d70c0ef830f3ab812a850f9dcde3a24598615cab1 |
| 第2段22:40–22:43 UTC | 182.04秒 | 13842259 | 8badbf35c75a2179126dde1d8884eb3fba33bc1d7d2da9ccdf84809b5fd5160b |
| 第3段23:04–23:06 UTC | 118.04秒 | 8939534 | 4a8bdaa41781d2a1e1ec72d97ed8ff7b90ee1511f970b298d21d6e40360248f3 |

metadata ended含关闭编码等待，剪辑以媒体时间为准。终版须标注等待剪辑、速度和修复重启边界；此前成片（现已删除），197秒、1440×1000、12fps、24488609字节，SHA256 afa3d2fd948790e0ebb880808cbc858982d0cbee2c1449ef240677152256d014。此前剪辑表逐段对应原片秒数，公开副本已撤下，私有审计保留，全部1×，仅剪等待。Chrome无解码错误，6处seek和完整播放到结尾通过（QA为16×快速播放，不改变成片速度）。

相关材料：[规格评审](../reviews/task106-spec-review.md)、[执行计划](task106-recording-plan.md)、[工程备答](../portfolio/engineering-notes.md)、[README](../../README.md)。

## 完成、独立归档复验与收尾修复

完成消息的completionEvidence绑定上表同一commit/receipt/controlFingerprint，最终协调台账isRequestSatisfied.answer=true、authority=leader，phase=done且gate清空。无需重发或替换已批准候选。界面自动显示completed；23:06:02 UTC刷新并重新填写quote-demo-3后状态、消息和归档入口保持。不可变归档映射SHA256为fdf907e4dd8f03543af1468fb7379bb434d272ad9e8867f771c76e405ec6a4f8。Task ID输入刷新会回默认值，未声称URL自动记住选择。

artifacts/worktree含6个文件，逐文件SHA256与批准提交的git show内容完全相同；worktree.receipt.json为不可变source→archived映射。新建无网络/只读Docker容器独立运行node --test：14 pass、0 fail/skip，运行完删除验证容器。任务容器0个，活跃worker0个，未增加Go请求。

收尾检查发现2棵历史integration工作树：①恢复只登记当前State引用的树，旧波次树不在本进程dispose清单（源码与Git列表确认）；②容器仍在使用（任务挂载容器0，排除）；③归档未完成（6文件一致、独立测试通过，排除）。这是磁盘/Git元数据回收缺口，不改候选或归档结果。按既有修复授权先停止服务，再在Git端口补充规范task目录、精确taskId/branch和既有common-dir/path/branch/HEAD校验后的回收登记；保留其他task和目录外工作树，命名错配拒绝，已有路径按macOS规范身份去重。先红灯复现，工作树7项转绿；真实Phase9增加完成后worktrees为空的检查，通过。最终完整回归154文件1185项0skip通过。23:20:38 UTC经同一生产Git清理能力回收该任务两棵历史树，任务linked worktree及容器均0；canonical repository保留，State/归档/session共21文件SHA256前后不变。

该修复在录制之后，交付166文件manifest为e8711e4060e9b88bb92893f628d8b6fac7f3b70ff0bf470adced59957464869c；相对第3段仅workspace-adapter.ts/git-service.ts变化。成片说明卡及本索引明确此版本边界。


最终构建于23:22:08 UTC正式重启复验：真实Chrome读取同任务completed/done、相同归档路径、10条持久Trace session、0截断/0页面异常，不增加Go请求。验证后正式pnpm stop，实例已停止。typecheck/lint/生产构建全部通过，30份候选文本密钥模式0命中、本地材料链接0断链；媒体关键画面可读，无模型密钥、原始推理或工具参数/结果。

这次交付仍含工作区代码变更，尚未commit/push或创建PR，Task10.6保持in_progress等待后续优化及重新录制；此前验证不自动完成10.7。检查日志与清理、重启审计保存在私有audit/checks及相邻审计文件，此前公开剪辑表已撤下。

[2026-09-11 Leader撤片决定] 当前成片及其本地剪辑副本、公开封面和剪辑表已删除，README/作品集播放入口已移除。原片、运行State/session、归档产物和修复测试证据保留。待Leader提出的优化全部完成再录制，本轮不调用模型或重跑评测。

## 撤片后的群聊可读性优化

[2026-09-11 群聊可读性验证完成] PM需求/验收清单、ARCHITECT分组方案、REVIEWER结论与说明已落地，JSON原文默认折叠；旧消息与SSE共用组件。新增14项测试，完整155文件1199项全过、无skip，365.52秒；日志SHA256 2d6f3ab9bbd20a846f4d41f667f34885745cb5fc65a7b9d6ede9b34151e27bcb。typecheck/lint及生产构建通过。正式入口真实Chrome在1440×1000及390×844验证3类历史交付、原文展开/收起和刷新，当前任务无页面异常、无横向溢出。控制台既有404分别为隔离数据不存在的默认lru-demo及favicon.ico，单独记入审计，未冒称全站无404。任务State SHA256前后同为9bdd0dff893a3f35a139741e510a3e1ab5b90377b3962cb03ebb9b79e64d1b98；正式pnpm stop完成。官方累计180请求保守USD0.127503326/0.30，Go48请求USD0.098492676/1，全部settled，无本轮Go调用；完整回归保留真实官方模型及既有凭证。审计存于私有audit/checks/readability，截图在/private/tmp/agora106-qa/readability-*.png。未录制新视频；10.6继续in_progress等待后续优化与重录，无commit/push。

## 群聊Markdown呈现验证

[2026-09-11 Markdown最终验证] 完整回归156文件1205项全过、0skip，377.46秒，日志SHA256 caecdd5c12f7b756f3ae45d05fbfdd9e56e2e9caba3b7cebd649fdba9a632c70；typecheck/lint（403文件）/最终冻结依赖生产构建通过，git diff --check通过。新增Markdown6项与旧展示/聊天共33项定向通过，实际浏览器1440×1000及390×844验证通过。截图为受控显示fixture，不冒充新模型交付；另已用真实历史消息/API复验。原文、任务State和归档保持；官方累计194请求保守USD0.135472268/0.30，全部settled，Go仍48请求USD0.098492676/1，无本轮Go调用。未重新录制、未commit/push/建PR；10.6保持in_progress等待后续优化和最终重录，10.7未启动。README、详细设计§11.9、技术选型§12、开发计划和任务notes同步；私有审计audit/checks/markdown保存日志与浏览器检查，截图位于/private/tmp/agora106-qa/markdown-*.png。

浏览器路径：正式本机入口→选择quote-demo-3→历史消息；另以受控SSE快照/新消息检查Markdown→键盘滚动表格→展开与收起原文→刷新重选。页面身份Agora、非空、无框架错误遮罩、当前任务无脚本错误，窄屏无页面横向溢出。已知默认lru-demo不存在及favicon的404已单列，有限受控SSE结束显示Offline；它们不作为真实运行证据。正式实例验证后已停止。

## Current task侧栏精简验证

[2026-09-11 侧栏最终验证] 完整157文件1206项全过、0skip，382.29秒，日志SHA256 5872c48a434b20249e23720160cc371e1317cd51e87ae4ed36e47eae58cfd0d0；typecheck/lint（404文件）及生产构建通过。桌面1440×1000和移动390×844真实任务API验证：默认目标3行/65px、概览245.25px，进度首屏可见；键盘展开/收起后完整goal文本一致，产物入口保留，刷新及切换任务恢复折叠，当前任务无页面异常/横向溢出。已知默认任务及favicon 404继续单列。官方累计208请求保守USD0.144879002/0.35、Go48请求USD0.098492676/1，全部settled，无本轮Go调用；本轮保守预算占用增加USD0.009406734，新增上限仅作请求预留门禁。State哈希不变、正式实例已stop；未重新录制、未commit/push/建PR。10.6保持in_progress等待后续优化与最终重录。日志及浏览器审计在私有audit/checks/task-overview，截图在/private/tmp/agora106-qa/task-overview-*.png。

采用原目标的三行预览和完整Markdown展开，任务ID/状态独立显示；不生成或持久化另一个模型摘要，不把初始目标冒充后续更新的需求事实。此轮仅修改前端呈现，未新增依赖或修改任务接口。

## 群聊原生滚动条验证

[2026-09-11 群聊滚动最终验证] 完整157文件1206项全过、0skip，373.17秒，日志SHA256 9d487fd6521ca070daf40c196e18c3a693a83bcf0e8c08ed1ad0ae5bc066f552；typecheck/lint（404文件）/生产构建及34项聊天定向通过。真实Chrome在1440×1000和390×844验证12px可见原生轨道、滚轮、滑块拖动、Home/End到顶/底、输入框固定和页面无横向溢出；测试显式省略Playwright默认--hide-scrollbars。其他浏览器保留标准回退，本轮未声称完成跨浏览器实测。默认lru-demo/favicon 404单列。State SHA不变，正式实例已stop。官方累计225请求保守USD0.153391436/0.35，Go48请求USD0.098492676/1，全部settled，无本轮Go调用；未重新录制或commit/push/建PR。10.6继续in_progress等待后续优化及最终重录。详细设计§11.9、开发计划、录制计划和任务notes已同步；私有audit/checks/chat-scroll保存日志，截图位于/private/tmp/agora106-qa/chat-scroll-*.png。

原实现已有独立overflow滚动，滚轮550px可用；本轮提高滚动条可见性并补键盘聚焦，不引入自制JS滚动条或强制自动跳转。无头测试最初的拖动失败由工具默认隐藏原生滚动条的参数导致，省略该参数后真实交互验证通过。后续录制已同步此参数要求，当前仍暂停重录。

## 英文录制准备验证（尚未重录）

[2026-09-11] Coordinator的14处中文展示模板改为英文；新英文脚本要求PM将语言标准写入需求验收，后续角色从既有currentRequirements读取。内部角色提示、中文识别词和历史消息保持不变。62项编排定向、typecheck/lint、生产构建通过；完整回归157文件1206项、0skip，382.89秒，日志SHA256 `0d81f39dd9651a1f8637507e4be3bf076c18fd3f8177fdbcfa34286d072a50af`。私有审计在`audit/checks/english-demo`，包含122个生产文件字符串检查。官方累计245请求保守USD0.161894108/0.35，Go仍48请求USD0.098492676/1，全部settled；旧任务State哈希不变。脚本/文案检查不代表新的全英文模型交付或录屏已完成，仍等待后续优化及获准重录。

## 消息跟随与简短通知（录制仍暂停）

[2026-09-11] 初次载入定位最新，距底部32px内的新消息/内容变化保持跟随；回看历史保持位置，按msgId去重的未读提示与Back to latest支持点击、键盘和焦点返回。任务/Channel切换清空本地计数。8处新Coordinator派发通知不再复制完整goal/title，保留角色、动作及必要subtask引用；完整目标、payload和历史消息保持。

96项定向、typecheck、lint（405文件）、生产构建通过；完整157文件1206项全过、0skip，378.48秒，日志SHA256 `20bea3febaf3906f0c70ed1e90fb87da7f0d41ae64a67bb787f85cb5edec1590`。Chrome桌面1440×1000及窄屏390×844验证跟随、回看、重复SSE去重、键盘/鼠标返回、任务/Channel切换、刷新、窗口缩放和展开内容；12px原生条、滚轮550、拖动及输入框固定复验通过。主流程以真实历史/API/SSE加合成display事件检查新消息；Channel/resize采用受控显示fixture，不冒充新的模型执行，有限流结束的Offline单列。当前任务无脚本异常或页面横向溢出，默认lru-demo/favicon 404保留记录；未实测其他浏览器。

官方累计266请求保守USD0.173984486/0.35，Go48请求USD0.098492676/1，全部settled。旧State SHA256不变，正式实例已stop；无新Go任务、录屏或提交。日志/报告位于私有`audit/checks/chat-follow`，截图在`/private/tmp/agora106-qa/chat-follow-*.png`。全英文真实演示仍待后续新运行验证。
