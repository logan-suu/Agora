# Task10.5 Go STREAM_CLOSED 根因排查

2026-09-10。正式v4首题第二次请求失败后保持停止。Leader要求排查原因，并在自动审批拦截后明确授权：将该失败请求的原任务提示和工具结果重放到同一OpenCode Go接口，仅最多2次、沿用原USD0.50诊断剩余额度。正式USD5账本及unknown记录不作修改。诊断重放只消费模型响应，不执行工具或生成代码。

已确认的本地证据：

- 锁定官方adapter的`streamIdleTimeoutMs`默认300000ms，Eval没有覆盖。原错误为`STREAM_CLOSED`，不是`TIMEOUT`或`ABORTED`；此前同模型成功请求持续38.930秒。因此不支持本地固定30秒超时假设。
- 原输入估算3418/65536 token，输入15573字节；四次fs_read均成功，未记录context-limit错误。重放从官方JSONL重建同内容请求，通过字节数和估算值断言；这不等价于持有原HTTP字节级抓包。
- 官方适配器在遇到`[DONE]`前暂存finish和usage。Go工具身份兼容层又会暂存工具块至底层流结束。因此原日志没有usage/finish，不能证明原始HTTP没有发送这些字段，也不能单凭`STREAM_CLOSED`认定模型内容被截断。
- 使用锁定官方DeepSeekAdapter和SSE解析器离线验证4种结束形式：完整双换行`[DONE]`成功；完整响应但无`[DONE]`、`[DONE]`无尾换行、实际截断三者均产生`STREAM_CLOSED`。不弱化生产解析，不修改依赖，不补造结束标记。

相关一手问题报告仅作为排查线索，不能代替本次传输证据：[Harness完整响应缺DONE讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/4972)、[Harness无尾换行DONE讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/388)、[Go V4 Flash连接问题报告](https://github.com/anomalyco/opencode/issues/40465)。后者报告的是响应前断开，与本次已收到内容不完全相同。

诊断文件放在`.data/evals/go-stream-investigation/`，不改动v4冻结源码；`probe.test.ts`通过透明TransformStream记录原始SSE结构、HTTP状态、白名单响应头、间隔和结束情况，不记录响应正文/reasoning/请求密钥。私有脚本不进入默认测试或产品执行路径。离线3测试通过，日志`/private/tmp/agora105-stream-probe-offline.log`；其中在线测试在未授权模式下直接返回，不算在线验收。

两次授权重放均成功：

| 重放 | 时间 | HTTP | SSE帧数 | 结束与计量 | 额度上界 |
| --- | --- | --- | --- | --- | --- |
| 1 | 150.951秒 | 200 | 7780 | tool_calls、usage、DONE完整 | USD0.005304450 |
| 2 | 31.804秒 | 200 | 1149 | tool_calls、usage、DONE完整 | USD0.000749970 |

最大读取间隔分别4515ms、6351ms，未出现流内error对象。两次共新增诊断额度USD0.006054420，累计诊断USD0.100082670，共49请求，零未结算；正式账本仍是1已结算+1unknown，不通过成功重放倒推原失败请求费用。

结论：未复现故障；证据更符合偶发的Go响应流结束异常。可排除固定30秒本地超时、这份输入必然触发上下文超限及每次均缺DONE的兼容性问题。无法凭本地日志定位到Go网关、上游模型或中间连接具体哪一段，也无法确定原HTTP是内容截断还是结束标记缺失/未分隔；该部分仍inconclusive。原失效请求未经HTTP字节级抓包，重放一致性仅证明同内容、同配置、同字节数和估算值，不夸大为原HTTP逐字节回放。

没有确认需要更改的生产代码，未增加重试次数、扩大超时、改依赖或补造DONE/usage。两次授权请求已用完，不继续诊断消耗，也未恢复54次正式组。建议下一次获准运行前，为请求异常补充白名单传输观测（HTTP状态、结束原因、DONE/usage是否收到、计量及请求ID）；如此复发时能分辨实际截断与解析边界，观测实现须另行冻结，不改写v4。

日志为`/private/tmp/agora105-stream-probe-online-1.log`、`/private/tmp/agora105-stream-probe-online-2.log`；响应结构指标见[metrics](phase10-go-stream-investigation-metrics.json)。所有357份正式源码仍与冻结哈希一致，未commit/push。
