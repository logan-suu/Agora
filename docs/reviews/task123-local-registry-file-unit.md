# 12.3 Registry 持久化文件底座

日期：2026-09-16。沿用Leader“继续”、固定本机验收目录及Go固定模型外发授权；使用agora-retry-task恢复、agora-sync-docs同步。未改变冻结接口、部署或产品入口，未提交。

## 规格评审与范围

详设§12.2.3.1：“跨重启先取得现有桌面唯一写者锁，再重放 journal。”同节：“两存储的动作在 registry prepared → TaskState canonical 引用提交 → registry committed 闭合；普通执行只接受双方闭合绑定。”

现有JsonTaskStateStore和JsonProjectCollaborationStore使用临时文件rename及进程内队列，不能直接冒充本机registry所需的唯一写者、fsync和中断阻断保证。保留既有实现，在runtime/sandbox增加内部LocalRegistryFile，复用真实桌面acquireState owner能力；无新依赖，不从L4业务代码导入桌面实现，仅通过结构接口接收owner。测试使用真实桌面实现。

本轮只完成文件发布层。它不能签发grant、判断跨根writer冲突、提交Leader动作、证明TaskState闭合或启动项目。**roots/grants/workspaces/claims/operations的生产记录schema和转换语义仍未实现**；测试使用严格固定codec：前四个数组为空，operations只接受fixed-*字符串。这是存储fixture，不是假造已授权工作区。该底座不从包index导出，不接MCP或桌面生产组合根。

## 实现

- 路径固定为owner.root下`local-workspaces/registry.json`，文件包络为`{snapshot, sha256}`；snapshot严格限定schemaVersion、revision、roots、grants、workspaces、claims、operations，schemaVersion固定local-workspaces-v1。SHA-256只校验损坏，不作为授权签名。
- 必须提供同步、严格、不转换输入的record codec；所有读写均经codec。外层字段、版本、revision、数组形态先校验；每个数组最多4096项，文件/读取总量最多16MiB。拒绝未知格式、额外外层字段、坏hash、整数溢出及codec修改/归一化输入。完整领域校验仍须由后续生产codec实现。
- 显式initialize只为本次新建的私有目录创建revision0空快照；已有有效记录原样加载，已有空目录/缺文件/坏文件不自动初始化或重置。目录0700、文件0600；拒绝symlink、多硬链接、权限异常及根/父链身份变化。每个入口及关键异步边界检查现有桌面owner；owner本身不替代格式升级门禁或Leader授权。
- compareAndSwap要求当前revision精确匹配、下一revision恰好加1且不回绕。调用进入时复制输入，返回深复制；调用者后改对象不影响已提交内容。文件排他registry.lock防同一owner下多个adapter并发丢写，无TTL抢占或自动删未知锁。
- 写入顺序：私有排他锁→同步锁及目录→重读/校验CAS→私有pending文件→同步文件→复核owner/根/锁身份→rename→同步目录→复核owner/根→只移除本次身份匹配的锁并同步目录。写入前CAS拒绝不污染旧快照；发布开始后的不确定错误保留锁/临时文件。
- 读取使用O_NOFOLLOW、同fd分块有界读取、前后文件元数据和当前路径身份检查，并复核根与pending状态；不把路径字符串或缓存对象当活能力。
- 发现registry.lock或registry.pending-*即拒绝load/open/CAS，返回registry_recovery_required；没有自动恢复、覆盖或释放入口。发布后锁被替换也必须报错并保持阻断，不能因新snapshot可见就报告写入成功。

磁盘发布锁属于存储技术层；它不等于业务operations中的prepared/committed。后续必须实现严格领域codec、不可变身份/撤权/epoch/冲突规则及TaskState双存储协议，不能直接调用CAS绕过这些控制。任意宿主同UID恶意进程/管理员不在现有强制边界内；本底座也不声称路径检查撤销已发出的OS操作。

## 验证与失败记录

TDD因缺少LocalRegistryFile模块而红。首轮22项真实文件测试全通过（3.30秒）；复核补有界读取和锁模式/硬链接检查，最终22项再次通过（3.88秒）。初次Biome指出测试清理finally中throw、未用导入及字符串格式，已改成显式断言/规范格式，无忽略规则。typecheck、lint（519文件）、native构建通过。

测试覆盖：跨实际owner生命周期重开、拒绝第二owner、owner释放后禁读写、初始化幂等/不重置缺文件、陈旧revision不污染、双adapter并发仅一成功、输入/返回对象隔离、版本/额外字段/codec记录/hash/整数溢出拒绝、残留锁/临时文件保持、链接和权限拒绝、根替换不跟随、codec缺失/偷偷转换拒绝；中途owner释放、目录移动、发布后锁替换均通过真实文件故障验证。故障wrapper先调用实际owner.assertHeld，再在固定测试目录操作文件，不mock实际store或owner；移回故障目录仅为测试留证清理，不是产品恢复路径。

5份源码冻结后原始完整pnpm test退出0：7项脚本测试、199个Vitest文件/1433项测试全绿，0skip，684.78秒。新增22项在完整环境再次通过；真实LRU199.686秒、Harness14.951秒、群聊摘要9.068秒，均Go deepseek-v4-flash的授权固定载荷。未切换提供方/模型、放宽断言或期限、恢复正式Benchmark；源码hash保持冻结版本。

## 未完成的产品工作

生产记录schema/转换、Leader授权来源、真实根/冲突域检查及TaskState prepared/committed闭合；固定输入/工具链及OS探测；持久输出、workspace端口/companion、D17与恢复及完整L01–L18。当前实现不能给LocalCommandBinding提供有效产品授权，也不签发checked。12.3保持in_progress，完整产品G5未完成。

按已批准契约，下一接合顺序为：core/domain完整记录及WorkspaceRef/LocalExecution校验（纯函数）→串行控制面的不可变身份、撤权/epoch/冲突转换→registry prepared与实际TaskState canonical引用及committed闭合→LocalCommandBinding从这一路径读取当前受信授权。还须同步State加载/合并、worker写入准入、投影和版本混搭拒绝，不能仅给文件adapter补一层“active=true”。这只是剩余工作定位，不表示上述能力已实现。

## 证据

[红测](task123-registry-evidence/tdd-red.log)、[首轮](task123-registry-evidence/registry-first.log)、[最终22项](task123-registry-evidence/registry-final.log)、[类型](task123-registry-evidence/typecheck-final.log)、[Lint](task123-registry-evidence/lint-final.log)、[原生构建](task123-registry-evidence/native-build.log)、[源码快照](task123-registry-evidence/source-checkpoint.json)、[完整回归](task123-registry-evidence/full-regression.log)。

## 最终清理与核验

136个固定fixture（其中registry66个）已留证并删除；完整回归另删除152个确认停用目录，31个证据不足保留。APFS可用空间观察增加5091328字节，不作为独占回收量保证。临时清理控制器源码/hash归档后删除；未停止用户服务或触碰用户项目、正常依赖/缓存、应用及产品数据。89份本轮证据、5份源码快照和fixture索引逐份核验；8组历史hash保持。

[最终汇总](task123-registry-evidence/summary.json)、[固定fixture清理索引](task123-registry-evidence/unit-fixture-cleanup-index.json)、[回归清理](task123-registry-evidence/full-regression-cleanup.json)、[临时控制器清理](task123-registry-evidence/temporary-controller-cleanup.json)。
