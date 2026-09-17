# 12.3 工作区领域类型与不可变身份

日期：2026-09-16。沿用Leader“继续”、固定本机测试及Go固定载荷授权，使用agora-retry-task与agora-sync-docs；没有提交、推送或创建PR。

## 规格复评

来源：详细设计§12.2.3.2的WorkspaceRefV1、WorkspaceVersionV1、FileVersionV1、FileChangeV1和WorkspaceCall；§12.2.3.3：“`workspaces` 是不可变 WorkspaceRefV1 引用集合，技术生命周期从 registry 读取。”同节：“新端口位于既有 `runtime/sandbox`，领域类型放 `core/domain`，编排只依赖 L3，MCP 适配位于既有 `tools/*`；不新增顶层包。”

此前“严格schema、现有字符/长度校验”只规定方向，没有一处完整实现。先在详设补齐边界，再实现L1纯函数：ID沿用内部绑定的1–128字符格式，hash与Git对象沿用现有规则；相对路径保持原文、按UTF-8字节限长，拒绝空段、点段、控制字符、无效Unicode，支持中文和空格。absent.name绑定目标文件名，remove必须依据regular版本。文件身份是待受信回执解析的不透明引用，不凭字符串判定真实根或文件身份。

文件adapter只要求注入codec，不能独立保证workspace不被改绑。真实红测证明：接受宽松fixture codec时，旧实现允许混搭字段、删除已有workspace和修改其projectId。这是本单元修复的缺口，不是已开放产品入口的授权绕过。

## 实现与边界

- `core/domain/local-workspace.ts`提供五种正式类型、纯校验器及引用集合转换校验，零I/O/新依赖。各联合拒绝未知/缺失字段和版本混搭；JSON对象拒绝继承属性、accessor和隐藏字段，集合拒绝稀疏数组及额外属性。复用既有Git对象/受管分支校验，未伪造direct的WorktreeRef。
- 集合最多4096个唯一workspaceId；允许追加及重新排列，已有ID全部字段保持不变。改变模式、scope、root/grant、基线或Git身份必须使用新ID；技术关闭/撤权不删除引用以重用ID。
- `LocalRegistryFile`在输入复制前、持久内容解码后独立校验workspace集合。CAS取得文件锁后重读当前revision，再校验不可变转换，最后才发布pending文件；拒绝转换时释放本次锁、保持原文件字节不变。两个adapter间的陈旧CAS与对新增记录的遗漏均被拒绝。
- 完整roots/grants/claims/operations生产codec仍为必填受信依赖，尚未实现。新存储测试的fixture codec只检查空其他实体及固定操作串，刻意把workspace交给真实adapter验证；固定workspace记录不是Leader授权。

这一步不授予文件/进程权限，不把合法WorkspaceCall当可信调用，不校验实际根/授权状态，不新增MCP或产品执行入口。TaskState.localExecution、模型写入拒绝、双存储prepared/committed、恢复、D16和版本混搭的全链路校验仍待接入。当前型别检查不能替代这些门禁。

## 验证

- 初始红测：领域模块缺失。实现后40项通过。
- 存储红测：定向选择新增3个场景，3项失败，明确复现不受限制的workspace转换；原22项未用于该定向红测结果。修复后全文件及领域共65项通过。
- 复核新增集合accessor/隐藏字段负测，原校验返回true而红；改为检查自有数据descriptor，不执行getter。补每种联合逐字段缺失/额外字段检查后，最终42项领域+25项真实文件测试全通过（4.35秒），0skip。
- typecheck、lint（521文件）及native构建通过。冻结9份源码后原始完整pnpm test退出1：7项脚本通过，200个Vitest文件中199通过/1失败，1478项中1477通过/1失败、0skip，710.57秒。新42项领域与25项registry全部通过。真实LRU164.251秒、Harness20.282秒、群聊摘要8.144秒均Go deepseek-v4-flash。未修改旧断言、真实模型提供方/模型或测试期限，没有运行正式Benchmark。

### 累计回归失败：根因尚未确定

失败为既有`phase12-3-command-start.test.ts`的撤权场景：预期`command_start_denied`，实际第一次`captureLocalProcess`调用受信control helper时发生`ETIMEDOUT`。现有每次helper调用上限250ms；检查点仅到admission，bootstrap已发ready，但未取得出生身份、未发`s`创建项目目标，更没有执行release撤权回调。持久记录为quarantined/control_failure，launchDurable=true、released=false、payloadResult=null，哨兵未变、fixture已清理。安全关闭成立，但不能据此宣称原撤权场景通过。

按证据检查三个假设：①宿主调度/首次helper启动迟缓符合超时现象，但未录制调用时序或负载，不能定为根因；②过早捕获/身份竞态缺少支持，ready先于capture，但超时没有返回token，不能排除内核查询迟缓；③新增workspace改动间接影响缺少支持，失败路径11份源码与此前通过检查点及当前版本hash完全一致，尚未调用workspace registry。

保持代码、期限和断言不变，原启动测试完整文件重跑12/12通过（8.98秒）；失败场景的重跑达到release并返回预期拒绝，11份源hash一致。**结论仍为inconclusive，G4完整回归未过**。未将重跑通过当修复、不覆盖失败日志、不继续批量试跑凑绿。后续需针对首次helper捕获增加可追溯的耗时/错误分段证据，再决定最小修复；不扩大250ms调用或既定5s启动/清理期限。

[失败汇总](task123-workspace-evidence/regression-result.json)、[三假设及源码对照](task123-workspace-evidence/startup-failure-analysis.json)、[原失败fixture](task123-start-evidence/revoked-x9iNlW.json)、[原文件重跑](task123-workspace-evidence/start-reproduction.log)。

## 证据入口

[领域红测](task123-workspace-evidence/tdd-red.log)、[首轮领域](task123-workspace-evidence/domain-green.log)、[存储红测](task123-workspace-evidence/storage-red.log)、[集合红测](task123-workspace-evidence/collection-red.log)、[最终67项](task123-workspace-evidence/unit-final.log)、[类型](task123-workspace-evidence/typecheck-final.log)、[Lint](task123-workspace-evidence/lint-final.log)、[原生构建](task123-workspace-evidence/native-build.log)、[源码快照](task123-workspace-evidence/source-checkpoint.json)、[完整回归](task123-workspace-evidence/full-regression.log)。

## 下一接合点

先定位上述首次helper捕获超时；依赖执行保护的产品接合保持关闭。随后按已接受契约实现根/授权/claim/operation的封闭生产记录与转换，明确LocalExecution的可信引用形态，再接TaskState串行提交、加载/投影、模型准入拒绝及registry双存储闭合。不能让未闭合或旧Docker记录成为可执行本机授权。12.3保持in_progress，G4有未解决失败，完整产品G5尚未完成。

## 清理与最终证据

160个固定fixture（registry78个，包含首次红测、完整回归失败及原文件重跑）已保存来源/版本/结果/hash并逐份核验删除。另152个确认停用回归目录删除，31个证据不足保留；APFS可用空间观察+5627904字节，不作为独占回收量保证。临时清理控制器归档并核验身份/hash/句柄/挂载后删除；没有停止用户服务或删除用户项目、正常依赖/共享缓存、应用、产品数据。9份源码快照保持，9组历史证据hash保持，task-status check及git diff --check通过。

[固定fixture清理索引](task123-workspace-evidence/unit-fixture-cleanup-index.json)、[回归清理记录](task123-workspace-evidence/full-regression-cleanup.json)、[控制器清理](task123-workspace-evidence/temporary-controller-cleanup.json)、[最终证据汇总](task123-workspace-evidence/summary.json)。

## 后续修复闭合

2026-09-16：Leader要求审查并修复后，已区分helper程序初始化与短时身份查询，补同deadline就绪阶段及私有端点存活确认；原测试正文保持，新增真实故障覆盖，新的原始完整回归1490/1490通过。此处原失败/重跑与当时inconclusive结论保留；后续诊断、修复和新证据见[helper启动超时修复](task123-capture-timeout-fix.md)。
