# Task10.5 工具循环修复验证

2026-09-10。Leader已授权发现问题后直接审查、修复、验证；AGENTS.md §7已记录（v2.12）。本次基于v5失败的真实工具事件审查实施，保留全部旧结果及费用，不更改工具权限或Git接口。

- Git MCP和模型实际使用的Harness桥接工具描述及patch参数说明采用同一常量，明确fs_write后以空patch提交现有工作树，禁止无必要地回退文件重建diff。真实MCP测试证明空patch产生新commit并保留已写文件；真实single模型请求检查实际工具描述。
- Eval每个attempt允许一次普通工具错误纠正；第二个独立sessionId/toolCallId错误在下一次供应商I/O及费用预留前写入持久停止标记。未知工具、畸形补丁等isError统一计数；仅绑定sandbox_run的126/127失败信封额外纳入，普通业务测试退出1及任意文件内容不纳入。重复历史读取、投影变化不会重复计数；已有基础设施错误立即停组。
- single无论执行成功或失败，均在step自然结束后flush官方闭合session并保存安全trace；执行错误和trace错误均保留。缺失trace的路由指标为unknown，不能当作实测错路由。

TDD先确认两个policy失败和两个真实集成失败；首次修复验证揭示桥接工具描述覆盖了MCP描述，已改为同源且再次验证。最终定向6文件33项通过，涵盖真实Docker/Harness/MCP/Git、两次无效patch后供应商调用恰为2、费用记录恰为2且已结算、失败trace包含闭合CODER turn、真实空patch提交及正常单/多/混合链路。

原v5官方session无模型I/O回放：在step8请求前因第二次patch失败停止；每个边界重复inspect两次不误计数。原v5执行到19次请求后人工停止，旧结果不改，回放证据.data/evals/phase10-final-v5/repair-policy-replay.json。

最终完整pnpm run test --maxWorkers=1：151文件/1143项全通过，退出0；包括保留的真实DeepSeek测试。typecheck和lint（388文件）通过；真实Docker预检4公开题99断言、4负例拒绝、12个PM配置投影以及2个holdout正反例通过。

日志：/private/tmp/agora105-loop-full.log、/private/tmp/agora105-loop-green-final.log、/private/tmp/agora105-loop-preflight.log、/private/tmp/agora105-loop-types-delivery.log、/private/tmp/agora105-loop-lint-delivery.log。

v6已冻结54项，题目/seed/roster指纹与v5完全一致；源码359份快照逐项验证。组指纹bb40f05275c9d5bcb1fb9c14c7d0ea93a23ee825db904267d90167673e6f5c30；源码指纹4354b1c10264733ca783afb4e5051c114cc2f518346ad7ccbfa62aeb9a0f7d02。旧v3/v4/v5的349/357/359份快照仍逐项匹配。

修复与验证阶段没有Go请求。正式共享USD5账本仍累计USD0.089858826，剩余USD4.910141174；独立官方回归新增USD0.037003252，累计USD8.536625848，零未结算。随后按既有授权恢复v6测评；在线结果另记，不把离线/fixture验证等同于Go任务通过。未commit/push，Task10.5保持in_progress。
