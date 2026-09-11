# Task10.5 公开契约输入修复证据

2026-09-10。Leader要求“进行修复”后完成修复、验证和v5冻结；本轮未启动Go正式测评，未commit/push。Task10.5保持in_progress。

## 修复内容

四个公开题的API和行为澄清现在进入三个配置共同的goal及TASK.md，工具为空的PM可以直接从真实角色投影取得。澄清仅根据固定revision的starter、题面及公开断言编写；全部来源SHA256逐项验证，缺失、重复或变更均拒绝使用，不能把更换后的公开文件与旧澄清混用。

Grade-school明确公开案例：先add('Aimee',2)，再add('Aimee',1)，grade(2)应为[]；两次调用不抛异常。该案例不单独断言新年级内容，add返回值也未被断言，因此没有补写新年级结果或布尔返回策略。澄清对冲突的原始文字具有明确优先级。

PM工具权限、公开spec.txt、原始独立验题、参考解隔离、holdout输入均保持原约束。公开任务version升至4；两个holdout仍为1，18个holdout trial的任务及seed指纹与v4一致。没有放宽末尾控制块解析；v4 mixed格式失败与公开输入缺口是不同问题。

完整回归同时发现混合路由fixture仍硬编码旧Pro模型名。实际配置早已按Leader要求使用deepseek-flash，因此更新四处明确模型名断言，保留每次真实Harness请求的角色路由校验及完整Docker闭环，不从实现配置派生期望值。

## 验证

- 定向回归：16文件46项通过；包含来源漂移拒绝、真实PM投影、三种配置共同goal、holdout不变。
- 真实Docker预检：4个公开题共99项原始断言通过，4个starter负例均拒绝；12个题目×配置组合均验证PM投影。两个holdout正反例也通过。
- 完整pnpm run test --maxWorkers=1：151文件1138项中，初次1137通过，1项因旧Pro断言失败；修正后该文件7项全部通过。没有跳过既有测试或重跑已经通过的付费链路。这里记录“完整执行＋受影响文件复验”，不声称初次完整命令退出码为0。
- 最终pnpm typecheck通过；pnpm lint检查388文件通过；v5 freeze通过。
- 全量回归日志：/private/tmp/agora105-contract-full.log；修复复验：/private/tmp/agora105-contract-benchmark-recheck.log；预检：/private/tmp/agora105-contract-preflight.log；冻结：/private/tmp/agora105-contract-freeze.log。结构化汇总见同目录phase10-public-contract-repair-metrics.json。

## 冻结与费用

v5冻结54个pending，尚无started/final。组指纹：65d2b89e180c9e5fc04f5a52b7e743fd06ed37830d4011f6a5defb2958d07601；源码指纹：a125c4836dc0c331d61a01c1fc684d9426c57b17ad198adafcbbfe36bb9acae2。359个源码文件已复制并逐项校验到.data/evals/phase10-final-v5/frozen-source，source-snapshot.json留档。旧v3的349份、v4的357份快照逐项验证未变；v4四次失败及费用保留。

v5沿用现有Go正式USD5账本，入口拒绝缺失账本，不能借新组重置费用。正式累计9次请求、USD0.073971504，剩余USD4.926028496，零未结算；本轮Go新增请求为0。既有官方DeepSeek回归使用独立旧账本，本轮新增USD0.027098692，累计USD8.499622596，零未结算；未占用Go额度。

后续正式执行仍须逐次检查：请求异常或任一attempt非pass即先停组审查，不在已知问题存在时继续批量花费。本轮验证证明输入修复已落地，尚不能证明模型不会再发明需求、违反控制格式，或再次遇到偶发STREAM_CLOSED；没有新增成功率结论。
