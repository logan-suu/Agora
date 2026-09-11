# Task10.5 v5 工具循环停止审查

2026-09-10。Leader明确授权向OpenCode Go发送任务提示及工具结果后启动。现已停止：1 final/fail，53 pending，无活动进程；没有继续第二个样本。v5源码359份保持冻结，旧组数据未改。

首个grade-school-single-1的19次供应商请求全部有正常finish和计费数据，没有复现STREAM_CLOSED。23次工具调用、耗时373.730秒，本轮新增Go额度USD0.015887322；正式共享账本累计28请求/USD0.089858826，剩余USD4.910141174，零未结算。输入累计356887 tokens（跨请求含缓存重复计数），输出15908 tokens；这不是单次上下文大小。

观察事实与假设复核：

1. 模型生成了无效补丁：step5/7/10/11/18共5次git_applyPatch失败。直接检查JSON解码后的参数：是真实换行，并非适配器双重转义；新文件hunk声称100行，实际只有77行，且缺末尾换行。step5第一个hunk行数也不匹配。Git拒绝畸形补丁符合实现约束。
2. 单模型工具用法有信息缺口：single-driver用自有systemPrompt覆盖CODER prompt，未保留runtime-contracts中“Use {"patch":""} to commit files already written with fs_write.”提示；Git MCP描述也没有明确空补丁行为。正常多角色CODER具有该指引。step2/3已经写完实现和测试，step4 sandbox_run退出0、lint返回空问题列表；模型之后反复手写补丁，甚至撤销现有文件以便重新apply。单模型是否会因补充提示稳定恢复尚未实测，不能把提示缺失当作唯一已证因果。
3. 停组策略覆盖不足：FlowToolPolicy目前只检测未知工具、权限/连接/unsupported schema等固定系统错误，不检测重复corrupt patch。自动机制没有在第二次补丁失败时停下；人工进一步检查原始工具事件后才写入停止标记。此前状态轮询只看请求结算和attempt状态，未及时识别工具层重复失败，这部分监控需要修正。

停止标记写入后，在途模型请求自然结束；工具审批/后续模型请求被拒绝，最终执行错误是停止后的fail-closed结果，不是新的供应商断流。没有生成最终独立验题结果，不能把早期自写测试通过当作benchmark pass。结果中model-routing=false来自失败路径没有输出trace，不能据此认定模型被错路由。

cleanup invariant通过，独立docker ps -a核对run身份无关联容器；execution.lock已释放。结构化指标见phase10-v5-stop-metrics.json；补丁结构审计位于.data/evals/phase10-final-v5/patch-structure-audit.json；原始官方session及result全部保留。

下一步修复应同时覆盖：所有适用角色共享的Git提交用法说明；对不同callId的重复补丁/工具错误做有界纠正并在下一次付费请求前持久停组（不可重复统计历史重放，也不能将普通业务测试失败直接当基础设施错误）；失败路径仍保存可审计trace，避免把缺证据误报为路由错误。先做离线故障回放与真实Docker工具验证，通过后另冻新组，共用原预算。当前不解锁v5，不追加线上请求。
