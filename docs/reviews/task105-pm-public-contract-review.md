# Task10.5 PM 公开契约可见性复审

2026-09-10。状态：Leader已要求进行修复；按下列方案修正输入并准备v5。当前v4保持停止，原冻结源码和结果保留。

实际证据：

- `grade-school-multi-1`与`grade-school-multi-2`中，PM均产出“已在另一年级的学生重复添加时保留原年级”的规范需求；ARCHITECT读取公开测试后发现冲突，正确提交blocking objection并打开Leader gate。两次均在planning结束，未启动CODER。
- 固定公开测试第80–84行：先`add('Aimee', 2)`再`add('Aimee', 1)`，断言`grade(2)`为`[]`。这直接否定PM的“原名册不变”，但该单一断言并不单独证明新年级包含学生；澄清只表述已由测试证明的事实，不扩大推断。
- 上游题面同时称重复添加应“indicate that this is incorrect”，没有精确规定迁移、返回值和异常；评测goal要求读取starter及spec.txt解决这些歧义。
- PM的冻结RoleSpec为`tools: []`，投影只有goal/requirements/leaderDecisions/coordinationContext；runtime prompt明确不得发明边界策略。它无法执行goal中的读文件要求。ARCHITECT及后续角色可读取，导致需求阶段得到的信息不足，之后才因冲突升级。
- `grade-school-mixed-1`另有独立的模型格式错误：concern控制块后还有JSON数组，违反末尾控制块规则。公开契约修正不自动解决或豁免该格式问题。

结论：第一例单独看可视为模型擅自推断；重复出现后，输入契约对PM不可读且题面与测试行为存在歧义的结构性缺口已经值得修正。保留已产生失败，不以改后规格倒改评分。

建议具体改动：

1. 为4个公开题提供紧凑、可追溯到固定公开测试和starter的接口/行为澄清，进入所有变体共同的goal投影；不把原测试代码全文塞入PM上下文。PM可据此形成需求，无法确定的行为继续显式留给文件核对，不臆造错误/返回值。
2. 优先说明公开测试对题面歧义的裁定；原题面保留且明确这类歧义由澄清覆盖。仅写公开测试支持的事实，配合source hash防漂移。
3. 保持PM无工具和生产权限矩阵；公开spec.txt继续可读，独立验题仍使用原测试，参考解与holdout不进入澄清。
4. 用离线回归验证澄清进入PM投影、各变体输入一致、公开source绑定、holdout隔离；真实Docker正反例预检仍须通过。
5. 新组拟为v5、仍54次、与v4共用现有USD5正式账本（当前保守占用USD0.073971504）；保留v4四次失败，总attempt数由54增为58。源码/任务version/协议/manifest另行冻结，不覆盖v4，也不把两组成功率合并。请求异常和每次非pass仍先停止审查。

执行范围：先完成契约修复、离线/真实Docker验证及新组冻结；本轮不自动发起54次模型请求。

修复已完成并冻结v5；验证、唯一回归失败及修正、账本和历史快照证据见[修复证据](../evals/phase10-public-contract-repair-evidence.md)。本轮没有新Go模型请求。
