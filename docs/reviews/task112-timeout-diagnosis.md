# 2026-09-14 Go真实回归超时排查

直接原因已定位到V4.1服务响应：HTTP连接建立后只发送SSE保活，未产生可交给Harness消费的模型数据，最终触发外层Vitest的120秒期限。客户端无法凭保活完成一个turn。尚不能区分Go路由/账号上游调度与DeepSeek推理资源排队，不能宣称已定位供应商内部故障。

## 证据对照

| 实验 | HTTP与首数据 | 结果 |
| --- | --- | --- |
| 裸Node fetch → Go V4.1 Flash | HTTP200约1.11秒，首次保活13.10秒 | 65秒内5条`: keep-alive`，0 data/推理/正文/结束帧；无模型内容后结束闲置诊断，用量unknown |
| 同一Go配置 → V4 Flash | HTTP200约1.09秒，推理约1.09秒 | 1.454秒完成，11条data帧及DONE；usage输入101、输出16 |
| 原生Harness → Go V4 Flash | HTTP200约3.45秒 | 45.43秒完成；done、安全点、非空回复、单条messages append断言通过；用量未采集 |

两项裸HTTP对照使用同一Go认证配置、同一JavaScript 2+2合成问题、enabled/high思考、64输出上限、stream及include_usage；每次使用新的随机会话标识。Harness对照使用既有真实HarnessExecutor/DeepSeekAdapter、原Coder投影、原生默认256000输出，模型只在独立诊断中显式选V4 Flash。两种客户端都能完成V4 Flash，且裸HTTP下V4.1仍无模型数据；客户端故障或大输出上限不是复现该停滞的必要条件。顺序少量对照不构成统计延迟Benchmark。

## 为什么HTTP200仍超时

[DeepSeek官方说明](https://api-docs.deepseek.com/quick_start/rate_limit/)定义：请求等待推理时可发送SSE保活注释；保活不等于模型回答。已锁定`dsh-llm-deepseek@0.1.1-rc.2`的`parseSse`把注释交给transport activity回调，不把它作为模型数据；回调调用idle watchdog的pulse，重置300秒空闲计时。外层G5测试独立设120秒总期限，因此持续保活期间会先由测试超时。没有证据支持修改解析器、放大测试期限或把HTTP200视为G5成功。

详细脱敏时序、请求配置、计数与SDK源码指纹见[诊断数据](task112-timeout-diagnosis.json)。前轮失败原样保留于[Go测试路由记录](task112-go-test-routing.json)。没有记录密钥、实际模型正文或推理文本。

## 当前处理

停止进一步V4.1重复调用，保留Go优先及新模型名配置。正式测试绑定和期限未变，未把独立V4 Flash对照替换成V4.1回归通过；G4仍阻塞，PR未新增提交/推送/解决会话。若后续显式改用可用的Go模型验收，须记录所选模型并完整重跑，而不能静默fallback。

一项额外256000输出上限的裸HTTP对照被自动审批以潜在费用/资源扩大拒绝，未执行；此前已获准的原生Harness同上限对照随后成功，使该额外请求不再必要。未启动64上限Harness追加对照，也未启动正式Benchmark。
