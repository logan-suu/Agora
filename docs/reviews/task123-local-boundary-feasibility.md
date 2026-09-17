# 12.3 首单元：本机文件边界可行性与待确认修订

> 历史报告：保留架构/故障分析价值，不代表当前任务状态；文中已精简的旧相对证据路径从[固定历史提交](https://github.com/logan-suu/Agora/tree/05987ccbd20e6a55a553750577a900f44bc353d0/docs/reviews)按原路径读取。当前验收见[task123-acceptance.md](task123-acceptance.md)。

> **2026-09-15规格复评后的阅读说明：** 本文保留上一轮实测、当时分类和未接受的迁移建议。当前结论以[规格合理性复评](task123-spec-reasonableness.md)及详细设计§12.2为准：旧fd现象不等于访问从未授权的新对象；不采用本文§4的强制迁移/同卷范围缩小建议。原始4通过/1失败日志保持，未改写成新契约通过，产品生命周期验证仍待完成。

日期：2026-09-15。状态：**L02/L06关键前提失败；12.3未完成，依赖实现停止。**

## 1. 结论与证据范围

在Apple Silicon、macOS26.5（25F71）、本机APFS上，最小Seatbelt策略能阻止根移动后的新路径操作，但不能阻止此前已打开的事务文件写句柄继续写入。当前§12.2规定的项目根内`.agora-operations`会随根一起移动，这个写入发生在已离开授权路径的文件上，未满足根/父链变化后拒绝副作用的要求。

本次改变的只是获批临时fixture中的**事务候选文件**，目标源文件仍为`original`。这不是任意文件逃逸、真实用户文件受损或整个Seatbelt机制不可用的证明，也不是所有其他实现方案不可行的证明。源码写入、安装、命令后代收敛及完整产品G5均未通过本报告验收。

## 2. 已执行的最小验证

- 受信C探针：`packages/runtime/sandbox/native/local-boundary-probe.c`。只用于研发验证，没有生产导出、MCP入口或自动构建/打包接入。
- 真实控制器与原始断言：`tests/integration/phase12/local-boundary-fixture.ts`、`phase12-3.test.ts`。不mock系统调用，不修改安全断言让测试通过。
- fixture全部位于新建`/private/tmp/agora-task123-validation-<随机后缀>/`，其中`project`是授权根，`outside`模拟移出后的路径；没有访问真实密钥、用户代码、全局缓存或产品状态。
- 探针一直由`/usr/bin/sandbox-exec`启动：`deny default`，仅对fixture的`project`开放写入；系统只读/映射例外依据本机Apple `dyld-support.sb`核对。没有`allow default`、全盘读写或未隔离重试。
- 编译器为Apple clang21.0.0，构建目标15.0只表示编译设置，不等于macOS15已实测。研发控制器Node24.20.0不是受管Node链路的验收。

| 场景 | 实际结果 | 结论 |
| --- | --- | --- |
| 正常`renameatx_np`交换 | 新候选到目标，旧目标到备份 | 此原语对照通过 |
| 父目录移出后交换 | `ENOENT`，两个文件均未变化 | 此时序拒绝通过 |
| 根目录移出后交换 | `EPERM`，两个文件均未变化 | 此时序拒绝通过 |
| 根内已打开候选句柄写入 | `pwrite + fsync`成功 | 正常写入对照通过 |
| 根移出后旧候选句柄写入 | 成功；`candidate`变成`prepared!` | **安全断言失败** |

交换使用根fd相对路径和`RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH`，没有使用已经移走的父目录fd作为交换根。当前SDK存在这些标志不代表最低支持系统具备同样行为；未验证时不得退化为普通路径检查。

## 3. 根因与排除过程

最初normal对照在外层研发沙箱中出现`sandbox_apply: Operation not permitted`，没有进入探针；工具审批后在外层限制之外运行控制器，探针仍使用原Seatbelt。其后dyld在main前退出，核对Apple本机规则补充只读Cryptex及可执行映射范围，normal通过。两次环境/策略失败均有独立回执，不算保护通过。

安全失败按证据排列的假设：

1. **旧fd保留写权限**：已打开文件在根移动后仍可写，是主要假设。
2. **策略误放开outside**：策略文本只有`project`写权限，需要通过重新打开对照排除。
3. **测试没移动实际目标/时序错误**：需要内核返回的实际路径及管道屏障确认。

同步屏障固定`open + dev/inode检查 → 控制器rename → pwrite`。追加的最小复核返回：

```text
openedFilePath = /private/tmp/agora-task123-validation-iOBZlW/outside/.agora-operations/candidate
reopenErrno = 1 (EPERM)
wrotePreparedFile = true
exitCode = 0
target = original
backup = prepared!
```

证据：[原始复核回执](task123-boundary-evidence/move-root-iOBZlW.json)、[保留失败断言的输出](task123-boundary-evidence/fd-recheck.log)。路径、重新打开与旧fd写入来自同一个已隔离进程，因此排除了后两种解释。增加最后一次路径检查仍有检查后移动的窗口，不能作为修复。

参考背景：[Apple对卷交换能力的定义](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsswaprenaming)、[Apple dyld启动说明](https://github.com/apple-oss-distributions/dyld/blob/main/doc/dyld4.md)。它们只解释原语/启动背景；上面的失败结论来自本机原始证据，不据上游资料宣称生产安全或推断未测系统。

## 4. 建议修订，待Leader确认

**目标仍是实际项目目录直接编辑与严格越界拒绝，不降低原验收要求。** 改动的是事务暂存位置和fd生命周期：

1. 首版事务内容、journal、命令可写输出放入已有Agora受保护状态域的专用目录，不放入可由编辑器移动的用户项目树。用户项目必须与该事务域在同一受支持APFS卷；跨卷明确`unsupported_workspace`，不复制后冒充原子交换。外置/其他APFS卷支持因此缩小，后续需独立受保护同卷根设计和验证，不能静默授权额外目录。
2. 源文件不通过可写data fd就地修改。候选在受保护事务域写入、保留必要元数据、flush、核验hash并**关闭全部可写fd/映射**后，才尝试一次根fd相对、禁链接且不越根的namespace交换；项目脚本只读源码，其输出留受保护执行域。
3. 根身份变化、交换拒绝或后置事实不匹配保留版本和journal，关闭执行，不自动回滚覆盖用户当前内容。打开的旧用户版本按原契约保全；接管、D4、D16和固定输入验证规则保持。
4. 新设计必须再验证根/父目录移动、交换前后移动、候选fd及映射泄漏、元数据/硬链接、崩溃恢复和清理。macOS15与当前系统分别验证，不因26.5上的几个对照通过就承诺整个系统调用窗口安全。无法证明仍保持入口关闭。

拟替换§12.2.4.3中“用户根内保留受保护的`.agora-operations`技术目录”的条款，建议文字：

> 首版事务暂存域位于Agora受保护状态目录内，与用户项目处于同一受支持APFS卷；不在用户项目根内建立事务内容目录。跨卷或无法证明事务域不受项目根移动影响时拒绝direct执行。候选内容仅在该域内写入，flush及版本核验后关闭所有可写句柄和映射，之后由受限helper完成根fd相对的文件交换。项目根内不保留由Agora管理的可写data fd；根或父链变化、原语不可用、交换结果不确定时保全证据并关闭执行。此路线仍须L02/L06真实验证，不视为已通过保护。

这改变了已接受的暂存位置与支持卷范围，不能作为普通实现细节直接改写正式契约。需要Leader确认该方向后，按agora-sync-docs同步蓝图/详细设计/架构/选型/计划及决策摘要，再继续单元A。**本报告尚未接受或实现该修订。**

## 5. 门禁、清理与恢复点

- TDD首轮为缺少fixture模块导致的真实收集失败；补控制器和探针后逐项验证。五场景完整运行结果4通过/1失败；失败断言保留。
- 定向`-t`调试输出中的未选择用例不是验收豁免；没有添加skip或排除默认测试入口。完整任务G4/G5未完成，未运行付费模型或Benchmark。关键保护失败后不继续依赖代码或全量批量实验。
- 静态检查及最终源码hash见本目录下证据文件和任务历史；初次typecheck因Next全局ProcessEnv要求NODE_ENV而失败，已添加固定`NODE_ENV=test`，不继承宿主环境。
- 每个fixture先保存源码/二进制/策略及结果回执，确认子进程close、lsof无句柄、无关联挂载、uid/dev/inode/规范路径匹配，再清理。没有子孙进程测试或下载，本次单C进程的退出不算L14证明。所有fixture均有删除及空间变化记录。
- 恢复点为本次原始安全失败及上述待确认修订。没有生产能力启用、提交、推送或PR；12.3不能标done。
