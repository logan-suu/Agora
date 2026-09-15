# 11.5 Phase 11 出口验收

日期：2026-09-15。分支：`test/task-11-5-phase-exit`。当前状态以任务索引为准。

## 当前结论

**修复后提交门禁已通过。** Go空思考字段回传已修复；原LRU实网复验及最终完整回归通过：Node7/7、Vitest189文件1340/1340，0失败/跳过，591.80秒；typecheck/lint通过。当前等待提交/PR人工合并，未发布。最终结果见[修复门禁记录](task115-evidence/reasoning-fix/results.json)；首次1336/1337及原样诊断失败保留在[历史提交门禁](task115-evidence/commit-gates/results.json)，不改写为通过。

本轮完成新增出口跨模块测试及固定提交桌面候选构建；真实服务23项、Electron主进程12项、受管工具15项和安装介质3项通过。Safari下载的DMG保留quarantine，复制安装后在macOS App Translocation路径真实启动，界面显示服务、钥匙串和受管工具就绪；菜单退出后无本次应用/服务残留。

完整`pnpm test`退出0：Node7/7，Vitest188文件1337/1337项，0失败/跳过，654.08秒；三项真实Go `deepseek-v4-flash`测试通过。typecheck/lint、索引及diff校验通过，待交付文件gitleaks脱敏扫描0发现。**[2026-09-15 Leader验收调整]** Leader随后明确“当前无干净 macOS 15设备，先忽略这个验收”。此前11.5适用出口实测通过，干净macOS15不再是当前阻塞项；修复后最终门禁以上方记录为准；DEF-018保持open仅表示实际未验证，最低15.0构建目标与对外披露保持。当前macOS26.5实测不冒充干净Mac验证。新增测试尚未提交/人工合并，任务仍in_progress，版本未确认，无tag/Release。

## Go提交回归修复

官方DeepSeekAdapter的锁定序列化实现会省略空reasoning_content；通用测试切换适配器时没有继承原PiAi路径的空字段规则。新增测试先复现真实Harness工具后续请求和stream/prepareCall两入口的字段省略，再在tests/helpers/go-reasoning-transport.ts的异步作用域内补齐缺失assistant字段为空字符串。非空思考、消息历史、模型/思考/容量默认值、headers、实际signal及原生重试均保留；同一endpoint的普通请求及并发请求不受影响。

确定性验证5/5通过，原LRU实网复验通过（Go deepseek-v4-flash，281.46秒），原600秒期限及断言未改。失败记录和诊断元数据保留；部分旧缺字段请求被上游接受的具体条件仍未确定，不能把兼容修复写成对所有历史400的完整根因证明。修复仅用于当前通用测试入口，未改产品或冻结Benchmark适配。完整回归及交付结果见[修复记录](task115-evidence/reasoning-fix/results.json)。

## 规格与阶段范围

来源：蓝图§21 D18、§22.3.2；详细设计§12.3；开发计划§18.2/§18.11。

> 本阶段只开放安装与环境检查，不开放未验收的本机编码入口，也不向新桌面产品提供Docker模式。

> 任务done、阶段done、Release已发布是不同事实

11.5为本阶段最后任务，显式依赖10.7及11.1–11.4，依赖均done；Phase12每个任务均依赖11.5。无跨阶段开工。DEF-016自定义岗位自主路由归Phase24，DEF-017 Linux产品启动不在当前平台范围；未将这些延期关闭或转为本阶段能力。

## 验收矩阵

| 出口条件 | 实际证据与结果 | 范围边界 |
| --- | --- | --- |
| 固定输入及安装资源 | 固定提交`891bc93420b6e7df0e18cae8d930c4d15394c61f`构建；354项输入与当前源码hash一致；资源/trace清单及嵌套ad-hoc签名通过 | 本次只新增集成测试和文档，生产输入未变；未来提交/选定版本若改变构建输入须复验 |
| 真实服务和界面 | 23项通过：包内Node/Next、React水合、HTTP/SSE、受限预览、CSP、IPC、格式拒绝和真实临时Keychain | 验证器的服务接缝仅替换为隔离真实Keychain；独立实际`.app`启动补足正式入口/fuses验证 |
| 主进程生命周期 | 12项通过：实际第二次启动、窗口关闭保留后台、重启互斥、旧进程退出后替换、旧会话撤销、正常停服及崩溃反馈 | 故障注入针对无模型预览子进程；正常关闭另观察实际应用菜单退出及进程消失 |
| 工具与环境隔离 | 15项通过：包内Node/npm/pnpm/Git版本、真实依赖下载和生命周期、项目版本拒绝、linked worktree及helper读写/越界拒绝 | 私有临时测试项目和受管PATH；不是无全局工具的干净OS安装证据 |
| 安装介质 | ZIP/DMG校验和、解压/挂载复制、严格签名与工具清单通过；卷已卸载 | ZIP仅内部验证；公开计划为DMG+SHA-256，未上传 |
| 隔离下载安装 | Safari从loopback下载317283884字节DMG，hash匹配；quarantine保留，隔离转位应用实际显示三项就绪并正常退出 | 已有macOS26.5用户环境，本轮未出现首次允许弹窗；不声明GitHub托管下载、免提示或干净安装 |
| 新增出口跨模块测试 | 3项通过：完整性→唯一写者→格式→认证HTTP/SSE→关闭/重开；损坏工具在取状态锁前拒绝；升级中断阻止readiness，回滚后原配置字节及目录身份保留 | Next readiness受控、工具内容为完整性夹具；已在文件头注明，不冒充G5 |
| 钥匙串升级及拒绝恢复 | 复用11.4跨构建36项及锁定恢复19项实测；新候选Keychain helper、服务及local-process三文件与该证据目标逐字节相同；本轮另实测候选原生启动 | 未重新生成/改写旧证据；人工Deny点击未单独观察，已有原生denied与人类ACL授权证据 |
| 干净macOS15设备 | 未验证，DEF-018保持open；当前11.5获批忽略，不再阻塞 | 最低15.0构建目标和实际macOS26.5范围披露不变；后续阶段不自动豁免 |
| G3/G4 | typecheck、lint通过；完整回归Node7/7，Vitest188文件1337/1337项，0失败/跳过 | 保留所有原断言、期限、凭据及Go deepseek-v4-flash，未启动正式Benchmark |
| 发布准备 | 英文说明草稿、固定候选验证及checksum已归档；测试二进制已按要求清理；只读查询当前GitHub Releases为空 | 应用内部版本仍0.0.0，发布版本待确认；未commit/push、人工合并、tag或Release |

## 可复现入口

1. `pnpm build:sandbox-native`、`pnpm build:keychain-native`。
2. `pnpm exec vitest run tests/integration/phase11/phase11-exit.test.ts`；需要本机Unix socket/loopback权限。
3. `pnpm typecheck`、`pnpm lint`、`pnpm test`；通用真实模型使用OpenCode Go `deepseek-v4-flash`，原正式Benchmark不启动。
4. `pnpm build:desktop <verified-download-directory> --revision 891bc93420b6e7df0e18cae8d930c4d15394c61f`。本轮复用已存在官方归档，构建器再次校验固定hash；所有版本仍用选型§12锁定值。
5. 对该包运行`apps/desktop/scripts/validate.cjs`、`validate-host.cjs`、`validate-tools.mjs`、`media.mjs`和`validate-media.mjs`。Electron验证使用临时真实Keychain并核实清理；安装/转位启动另通过原生UI实测。

实际构建根、介质、结果、hash与对应证据见[机器记录](task115-evidence/results.json)、[隔离安装](task115-evidence/quarantined-installation.json)、[钥匙串证据复用比对](task115-evidence/keychain-evidence-reuse.json)及[SHA256SUMS](task115-evidence/SHA256SUMS)。[英文发布说明草稿](task115-release-notes.md)尚不可当作已发布说明。

## 本轮失败与处理

- 首轮出口测试在工具沙箱1通过/2失败，服务控制监听错误被映射为`state_in_use`；最小Unix socket探针返回`EPERM`。允许本机监听后原测试3/3通过，未修改断言或产品代码。
- 下载复制辅助检查首次使用了宿主Python尚不支持的`hashlib.file_digest`，在挂载前失败；改为兼容的流式SHA-256后完成挂载/复制/签名核验。
- CUA输入URL时键入方式丢失冒号，导航未下载；改为粘贴准确URL，服务端记录成功GET，下载文件hash一致。读取隔离安装原路径超时，原因为系统将应用运行于App Translocation；按工具返回的实际路径检查，画面正常。该工具超时不记录为产品启动失败。
- 验证日志中的不可信IPC断言和CSP violation来自显式负向测试；原生报告与退出码均通过。主进程故障场景中的连接重置不冒充正常浏览成功。

## 后续收尾条件

干净macOS15项按Leader明确授权忽略。Go思考字段兼容修复及最终门禁已通过，按已获授权提交/创建PR后等待人工合并；发布版本及发布动作另行确认。按TEST-CLEANUP清理后的历史产物不再作为可下载附件；发布需重建、校验新hash和适用安装证据。

## 测试后清理完成

按Leader要求，归档清单、版本、hash和测试结果后，确认进程、挂载及打开文件均无占用，删除14项测试下载/临时构建/安装副本，包含Safari下载DMG和3处已核对hash的历史测试下载缓存。删除文件分配量约7.29 GiB，清理期间磁盘可用空间实测增加约6.66 GiB（APFS共享块及同期系统活动会影响差值）。原候选、DMG和ZIP不再保留，发布时须重建并验证。正常依赖、已安装应用及产品数据未清理。完整路径、身份、归档hash和删除结果见[清理回执](task115-evidence/cleanup/receipt.json)。
