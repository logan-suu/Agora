# 12.3 命令私有写域首单元

日期：2026-09-15。Leader已确认[原生有界清理方案](task123-native-execution-options.md)，正式约束以详细设计§12.2.6为准。

## 已实现与验证

新增内部`buildLocalCommandPolicy`策略原语；只允许指定可执行文件派生执行，源码和固定输入只读，每条命令使用独立新建输出根，模拟凭据、控制目录、相邻命令输出、源码/输入根下的`.git`、`.agora-operations`及`.env`路径显式拒绝。拒绝重叠根、根符号链接、非空输出根及输出内的可执行文件。

真实C探针与固定受管Node 24.20.0在Seatbelt中执行，覆盖子进程及其exec后代。C路径28项操作、Node路径8项操作同时验证允许读输入/写输出与拒绝源码写入、模拟凭据读取；C路径另验证相邻写域、控制目录、符号链接、硬链接、rename/unlink及只读fd写入失败。外层控制器复核哨兵未变。4类准入拒绝包含名称为`..output`的真实嵌套目录，避免把所有`..`前缀误认成向上遍历。

当前宿主macOS 26.5 arm64；Node可执行文件与已安装Agora工具链manifest版本/hash匹配，未修改已安装应用。编译目标macOS15不能替代最低系统实测。固定探针按已知父子链同步wait，清理前再核验目录身份、句柄与挂载；这个测试闭合方式不证明任意项目命令全部后代退出。

## 验证记录

- TDD先运行测试，因fixture尚不存在而收集失败；补充实现后通过。首次类型检查发现`map(JSON.parse)`回调签名不兼容，改为显式单参数解析后通过。
- `pnpm build:sandbox-native`、`pnpm typecheck`、`pnpm lint`通过；native构建仍是既有正式helper，不代表新增探针已打包。
- Phase12本地回归：3个文件、24项测试通过，用时9.72秒。见[本地回归日志](task123-isolation-evidence/phase12-regression.log)。
- 完整回归前两次被自动审批拒绝，均未启动：第一次要求具体外发目的地/载荷授权；第二次不接受从历史工具取回的旧授权。Leader随后直接确认本次固定测试外发至OpenCode Go `deepseek-v4-flash`，原始`pnpm test`执行完毕：7项脚本测试通过，Vitest 191文件通过/1失败、1363测试通过/1失败，用时607.72秒。LRU在197.145秒后因`STREAM_CLOSED`失败；真实单回合与群聊摘要均使用相同Go模型并通过。原始失败不能改成全绿，见[完整日志](task123-isolation-evidence/full-regression.log)。

版本、原始结果和清理路径见[证据汇总](task123-isolation-evidence/summary.json)。早期记录保留各自源码hash，不以最终文件覆盖其版本归属。

## 断流诊断与清理

锁定的官方DeepSeek适配器`0.1.1-rc.2`在SSE结束而无`[DONE]`时主动抛出`STREAM_CLOSED`；现有Go兼容层没有改写底层响应流。证据支持在适配器边界观察到截断，不能据此确定网络或Go内部的具体根因。新命令策略不在LRU执行链路中。保留3类假设和来源hash，见[诊断记录](task123-isolation-evidence/stream-failure-analysis.json)。随后一次不改代码/模型/载荷/期限/断言的LRU最小复验通过，用时180.83秒，见[单例复验日志](task123-isolation-evidence/lru-reproduction.log)。本轮1364项各有通过记录，但首次完整调用仍为失败，不能改写为一次全绿；上游截断根因仍为inconclusive。后续交付前仍须取得完整全绿调用，不扩大自动重试或追加批量模型实验。

本轮完整回归后先保存日志/hash与测试目录文件清单，复核来源/身份/无句柄/无挂载后删除152个测试目录；31个未证明可清理的目录保留，未停止用户服务。APFS可用空间观察增加4071424字节，不能当作精确回收量，见[清理记录](task123-isolation-evidence/full-regression-cleanup.json)。原有历史31个保留目录不在本次时间窗内，没有删除。单例复验另删除1个确认停用的LRU目录，无新增保留项，见[复验清理](task123-isolation-evidence/lru-reproduction-cleanup.json)；该次空间观察-1658880字节，反映并发APFS活动，不推断负回收。7次新命令隔离fixture均已按各自结果清理。

## 明确尚未实现

该原语没有公开导出或接入registry、MCP、普通项目入口。策略构造时的路径检查不替代持续根身份绑定；源码清单/嵌套仓库与既有硬链接准入、继承fd关闭、环境重建、网络与IPC实测、安装代理、授权撤回、有界监督、输出截断、资源记录和恢复仍待后续单元。

后续按获批计划实现：可信launcher绑定授权与固定输入→有界停止和输出收尾→不可复用资源记录→崩溃恢复与容量控制→正式端口及L01–L18真实验收。源码/凭据隔离不能因接受漏检后代而降低；`checked`只表示有界检查完成，不表示所有后代已退出。12.3保持`in_progress`，不将局部验证写成完整G5。
