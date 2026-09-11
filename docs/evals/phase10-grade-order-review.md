# Task10.5 grade()排序范围审查与修复

2026-09-10。v6目前2pass/2fail/50pending，全部旧结果保留，原冻结源码359份不变。第一个mixed失败已审查为模型工具使用失败（一次不存在文件、一次shell git缺失），原规则生效；第二个multi独立验题9/10通过，唯一失败是grade()返回[Franklin, Bradley]而非[Bradley, Franklin]。

PM明确把grade()顺序写入nonGoals，CODER、TESTER、REVIEWER均沿用；生产流程完整完成，测试和完成门绑定有效，但独立公开断言发现错误。原澄清把姓名排序落在roster()说明段，对工具为空的PM存在API范围歧义。因此增加逐API事实：grade(grade)即使乱序添加也必须按姓名字母序返回，不能把这一行为标为unspecified/non-goal。原测试/参考解/评分不变，三个公开配置同用此事实；不是人工修候选让旧成绩通过。

复核wordy的23个、book-store的17个、forth的49个公开断言：现有说明分别涵盖唯一answer/cost入口的运算与错误/最小分组总价，以及Forth算术、栈操作、词法绑定、重定义、局部作用域和大小写；未发现与grade/roster相同的双API范围歧义。不新增未被公开证据限定的边界政策。

TDD新增真实PM投影对grade排序的断言，先红后绿。修复后16文件50项相关测试、typecheck、lint通过；真实Docker预检另行记录。仅公开契约文字和版本改变，生产代码与工具修复未再改变；本轮不重复此前151文件1143项全量真实模型回归，保留该检查记录并用受影响测试及真实验题复验本次变更。

公开task version升5，组及协议升v7，holdout version仍1，沿用同一USD5正式账本；当前累计USD0.139740210，剩余USD4.860259790，无未结算，修复检查不产生Go请求。v6的两次通过仅属旧组证据，不能并入v7成功率。

Docker预检通过：99公开断言、4个公开负例、12个PM配置投影及2个holdout正反例。v7已冻结359份源码；组指纹dcc51fc6df938bb738575bfc6835d33be376f44bcdfb4ece3bc01b0aefb7c766，源码指纹ff6eae9bcae38082d216fa2c9faf426705d97baa3454be5f4a91a68b4a91b494。18个holdout任务/seed/roster条目与v6逐项相同。随后在原授权内恢复测评，结果另记。
