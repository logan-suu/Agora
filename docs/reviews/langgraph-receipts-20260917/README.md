# LangGraph 派工回执故障窗口实验

日期：2026-09-17。Leader在D9修复交付后要求“继续”。本轮仅继续独立方案的协议实验，不启动12.4、13.2或19.2，不增加产品依赖、不改产品代码、不提交或发布。沿用锁定LangGraph 1.4.15与官方SQLite saver 1.0.4；完整版本和来源hash见[机器结果](results.json)。

## 控制依据与宿主边界

详细设计§12.3.3.3原文：“无有效所有者证明的旧控制记录返回可恢复故障，不能凭 PID 数字或文件年龄删除后启动第二个服务。”§12.3实现映射明确“不自动清除陈旧锁”。同节要求：“崩溃/IPC 断开立即禁止新请求并进入安全收尾；不得自动重跑工作或自动重试不可确定的外部副作用。”

因此，上轮`state_in_use`是当前桌面owner契约的失败关闭行为。正式退出/主动恢复属于13.2，整队异常退出与恢复契约属于19.2/19.3；独立LangGraph实验不自动变更阶段依赖。应用取得有效owner、任务读取核验、用户明确继续，是三个独立条件。图checkpoint不能充当其中任何一个授权。

本轮由单个测试控制器串行启动独立Vitest进程，使用自己专用的业务/SQLite目录；没有接入desktop owner，也没有删除任何产品锁。其结果只适用于“已有唯一合法执行者”这一前提下的协议行为，不增加整应用冷启动覆盖。

## 实验构造

- 使用真实`JsonTaskStateStore`、`applyMutations()`、官方LangGraph与SQLite。派工收据和worker注册在一次业务commit中写入；完成收据和worker done在一次业务commit中写入，图只存两个收据ID。
- 新控制收据尚无生产schema。本实验将其放入隔离State的`experimental_dispatch_receipt`消息payload，专用解析器校验形状、scope、操作键、输入指纹、worker绑定和阶段链。**这不是生产控制写入入口，也不能据此允许模型创建收据。**生产实现仍须采用方案§6.4的受信schema及WorkerRuntime边界。
- 外部效果为测试驱动写入的固定计数文件，并核验文件hash。没有创建Harness Context、调用模型、执行用户代码或workspace工具。它验证协议与持久化机制，不能代替真实Harness/MCP/Git/D16的G5。
- 在六个确定窗口写入故障标记并立即SIGKILL当前独立测试worker；控制器要求runner非零、标记窗口匹配、记录PID已退出。只读检查与继续均在后续新进程中运行。没有用异常抛出冒充进程崩溃，也没有杀LLM流。
- 正式矩阵执行期间实验源码hash保持一致，定向TypeScript检查通过。正式矩阵前一次正常路径探针用于检查依赖/夹具，不计入下表38个进程。前轮六份D9生产修改hash仍与已通过1768项回归的来源一致；本轮未重复运行付费全量回归或Benchmark。

## 结果

最终矩阵共38个独立runner进程：32次正常退出并通过该阶段断言，6次预期故障退出。不能称为“38项普通测试全绿”。

| 窗口/输入 | 新进程观察 | 显式继续与重复调用 |
| --- | --- | --- |
| 派工commit前退出 | 图待dispatch；无worker/收据/效果 | 控制节点重新核验后一次注册派工；效果计数1，重复继续不改State |
| 派工commit后、图结果前退出 | worker和dispatch收据同时存在；图仍待dispatch | 复用原派工身份；效果计数1 |
| started后、效果前退出 | started存在，效果不存在 | 分类needs_attention；继续拒绝，效果仍不存在 |
| 效果后、完成收据前退出 | started和一次效果存在，缺完成收据 | 分类needs_attention；继续拒绝，效果计数保持1 |
| 业务完成commit后、图结果前退出 | worker done及完成收据同时存在；图待effect | 核验原效果hash后只补图结果；State不变，计数1 |
| 图pending writes已提交、后续checkpoint前退出 | 当前tuple保留`result` pending write；`getState`已显示结果且next为空 | 完成事实经外层核验；无重复效果，State不变 |
| 图正常完成后再读/继续 | 图完成、业务证据闭合 | 只读和重复继续均不改State，计数1 |
| 同操作键、不同请求输入 | 原完成事实仍在 | 外层准入报INPUT_CONFLICT，无新效果 |
| 图完成但业务完成收据被删 | 图仍显示完成 | 外层准入报GRAPH_BUSINESS_CONFLICT，无新效果 |
| 图完成但业务收据指纹损坏 | 图仍显示完成 | 外层准入报RECEIPT_CONFLICT，无新效果 |
| 图完成但效果文件与完成hash不符 | 图仍显示完成 | 外层准入报EFFECT_CONFLICT，无新效果 |

后三项只改测试专用虚构JSON/计数文件来构造损坏，不改生产代码或用户数据。只读检查前后业务State hash一致；每个拒绝场景的继续前后State及效果也一致。

## 进入方案的结论

1. 恢复入口必须先独立核验业务事实，再调用图。不能只依赖节点内检查：pending writes或终态checkpoint可能让框架直接得到结果，跳过节点体。
2. `started`不是“尚未执行”的证据。本轮效果前和效果后两个窗口均保守拒绝；真实适配器以后只能凭受信session/工具事务等额外证据细分，不能看不到回执就重试。
3. “历史完成可复用”和“当前可继续执行”分开判断。历史收据固定输入；同操作键异输入拒绝，下游另行核验当前需求/授权/版本，不能把旧结果当当前有效交付。
4. TaskState内部两组字段的原子可见性、SQLite pending writes和进程恢复已在本夹具观察到；没有证明整机断电零丢失。当前JSON快照使用write/rename，未在本实验增加fsync保证；不能将本结果扩展为跨存储全局事务。
5. 后续实施仍须定稿受信收据schema/权限、Continue授权、宿主owner恢复衔接，再做生产端口上的故障窗口与多worker Worktree/D16验收。当前没有理由直接开始全产品引擎切换。

## 复现与清理

从原项目开发依赖开始，创建`test-outputs/langgraph-receipts/`，把本目录`sources/receipts.test.ts`放到`src/`，`sources/run.py`放根目录，两个配置放根目录。把[第二轮package与lock](../langgraph-spike-20260917/README.md#4-复现)放到`runtime/`，不能改成latest。

```sh
npm ci --prefix test-outputs/langgraph-receipts/runtime --cache test-outputs/langgraph-receipts/npm-cache --no-audit --no-fund
pnpm exec tsc -p test-outputs/langgraph-receipts/tsconfig.json
python3 test-outputs/langgraph-receipts/run.py
```

必须用新空fixture目录复跑；脚本不会覆盖已有业务State以伪造新一轮结果。SIGKILL及后续只读检查是矩阵的一部分；任意非零不能当成成功注入。安装只在测试目录，使用Node24.20.0/ABI137、macOS26.5 arm64、SQLite3.53.2。npm报告prebuild-install弃用提示，固定版本安装和原生模块加载成功，未更新产品依赖。

保留源码、锁引用、版本/hash、每阶段观察及必要故障证据；删除测试专用依赖/cache、原始重复日志和全部虚构State/SQLite/计数文件。清理前核对进程退出、无句柄/挂载及目录身份，结果见[cleanup.json](cleanup.json)。既有应用、产品state、正常项目依赖及历史实验附件不动。

清理已完成：5865份测试专用文件、83444484逻辑字节；观察可用空间增加119296000字节，不声称独占回收量。六个故障进程均已退出，全部runner已结束，lsof无打开句柄，无相关挂载。必要证据先行保存，已删除候选不提供运行或下载链接。
