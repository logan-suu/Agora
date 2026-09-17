# 12.3 按出生身份停止与持久资源记录

日期：2026-09-15。承接Leader“继续”，沿用已确认的原生有界清理契约、专用fixture及固定模型测试外发授权。使用agora-retry-task、agora-do-task恢复和执行，agora-sync-docs同步检查点。

## 当前实现

### 按出生身份停止

受信native helper通过Mach task name取得内核audit token；信号仅接受同UID的完整8字token及TERM/KILL，核验身份后使用`proc_signal_with_audittoken`，不向数字PID或负进程组广播。出生身份不一致不发信号；未知或查询错误保留不确定状态。僵尸或明确ESRCH只表示原登记进程已不再执行，不能推导任意后代状态。

TypeScript内部原语固定登记cohort的副本，TERM阶段最多1秒，KILL及复核最多2秒，单次helper调用受剩余期限约束，总预算5秒；登记上限256，重复身份拒绝。返回`assurance=registered-only`及`registeredState=stopped|needsAttention`，**不返回正式cleanup checked**，也没有资源释放、删除或重新授权能力。调用者仍必须证明成员属于本条命令；从项目输出拿到PID不是成员授权。

### 有界输出

stdout/stderr独立按字节保留最多1MiB，同时记录观测字节数、truncated及读取错误。主进程exit后最多再收集1秒，继承管道未闭合时截断并关闭本方读端。主进程结果与输出结果分离；主进程0退出或EOF均不替代后代发现、清理或可信产物校验。返回结果与后续流事件分离，不让close事件修改已返回的状态。

### 持久资源日志

新增内部`LocalCommandJournal`，只用于受信控制面，不公开导出或接入产品入口。绑定控制目录与父链dev/inode，要求同UID、0700根、0600单链接数据文件；有界JSON及内容hash校验，独占锁、临时文件fsync、原子rename、目录fsync。初始化取得锁后再次核验空目录，避免并发初始化覆盖。进入发布后发生I/O失败保留锁，不能因rename已发生就假装成功。

先记录commandId/workspaceId、策略/输入hash和私有写根，再持久登记出生身份。命令重复输入只复用原记录，不重新授权；异输入、过期revision、闭合记录改写、跨记录重复进程身份、同路径/嵌套路径或改名后的同inode写域复用拒绝。上限256条命令、每条16个写根/256个出生身份、文件1MiB；满载明确拒绝，不自动删历史腾位置。

本单元没有实现后代发现和完整准入，所以已知进程停止后仍写`quarantined/discovery_incomplete`。重开日志保留reserved/quarantined并返回阻断；坏文件、遗留锁、控制根置换拒绝。没有清除隔离/回收资源/强制放行入口，日志不取代D17 lease或composition admission。

## 真实验证及范围

新增5项真实Seatbelt停止/输出测试：错误出生版本不发信号且原进程仍活、忽略TERM升级KILL、TERM正常停止、双流超限截断、主进程退出后后代继承管道超期截断，以及错误cohort保持needsAttention。固定fixture将真实内核出生身份写入日志，重新打开后仍观察到隔离。

另5项真实文件系统日志测试覆盖：中断reserved重开、路径与改名inode不复用、隔离闭合不可再改、相同输入重放、异输入/过期revision拒绝、坏JSON、遗留锁和控制根置换。错误出生版本测试不冒充实际系统PID回收压力测试；遗留锁测试不冒充全部fsync/崩溃时点验收。

Phase12本地检查点为5文件34项通过（21.84秒）。其后代码复核补充cohort拷贝、返回结果拷贝及锁内初始化检查，最终版本typecheck、lint（506文件）、native构建通过；原始`pnpm test`退出0：7项脚本测试、194个Vitest文件/1374项测试全部通过，0失败、0skip，675.99秒。LRU闭环、Harness单回合和群聊摘要均为OpenCode Go deepseek-v4-flash；未运行正式Benchmark，未改模型/额度/期限或断言。初次两个测试入口均因fixture尚未存在而红；首次typecheck发现全局ProcessEnv要求NODE_ENV，补显式最小环境后通过。无mock、skip、提供方替换或断言弱化。

当前宿主macOS26.5 arm64，clang目标macOS15不代表最低系统实测。既有native构建通过不代表新增helper已进入正式受管工具链或签名应用。

## 尚未完成

- 可信launcher的持续授权/根绑定、源文件清单及额外继承fd检查；项目网络/IPC与包管理器真实接入。
- 正式后代发现、出生身份关系验证、命令30秒总执行生命周期及安全取消；多进程cohort完整覆盖。
- 将mainResult/outputState/cleanupState/resourceState闭合到正式companion回执；仅在完整有界检查后标checked。
- 工作区/全实例阻断范围、D17额度与admission接入、完整重启恢复及生产端口G5。

12.3保持in_progress，以上原语不开放普通用户项目执行。前轮STREAM_CLOSED及原样复验通过仍保留，本轮完整全绿作为后续检查点单独留档，不把前轮失败改写为通过。

证据：[本地回归](task123-stop-evidence/phase12-regression.log)、[源码检查点](task123-stop-evidence/source-checkpoint.json)、[类型检查](task123-stop-evidence/typecheck.log)、[lint](task123-stop-evidence/lint.log)、[完整回归](task123-stop-evidence/full-regression.log)。

## TEST-CLEANUP

25个本单元固定fixture均已先保存源码/hash/原始结果，再核验进程/目录身份/句柄/挂载后删除；其中10份真实内核出生身份在日志中的持久记录及重开阻断状态再次核对一致。测试自退出期限只用于已知固定fixture清理，不作为生产收敛证明。完整回归另按独立清单执行清理，详细路径与结果见[清理记录](task123-stop-evidence/full-regression-cleanup.json)。未删除用户项目、正常依赖、共享缓存、安装应用或产品数据；未停止用户服务。

完整回归清理152个确认停用的目录，31个未证明可清理的目录保留。APFS可用空间观察为-3715072字节，不当作精确回收量。受信清理控制器已保存副本/hash后删除临时副本，旧轮保留目录不在本次时间窗内。汇总见[证据索引](task123-stop-evidence/summary.json)。
