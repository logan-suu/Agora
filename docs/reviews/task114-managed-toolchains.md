# 11.4 受管工具链与安装介质验证

日期：2026-09-14。分支：`feat/task-11-4-managed-toolchains`。当前状态仍查任务索引；本报告不宣称任务done或正式发布。

## 结论与范围

**当前安装补验发现并修复启动缺陷：** 用户在macOS26.5完成Safari带quarantine下载、安装及系统“仍要打开”后，旧包仅在Dock弹跳。已确认ESM入口等待ready的死锁，以及生产file协议fuse下状态页无法加载；修复两处且保留全部安全开关。修复后的完整`.app`正式入口实测可显示本地服务Ready、钥匙串可用和工具已验证，正常退出0；针对性2项回归、G3及原生组合根12项已通过。修复版DMG已用Safari重新下载，用户替换Applications应用并确认“已打开”；安装后保留quarantine、ASAR与DMG一致、签名完整性通过，实际窗口三项环境检查均就绪。当前Mac下载安装启动补验通过；修复后完整默认回归退出0：Node7/7、Vitest187文件1330项全通过，无跳过，599.86秒，三项Go真实模型测试均通过。此前ready后加载组合根的验证没有覆盖这两处问题，不再当作实际双击成功的证据。详见[补验证据](task114-evidence/supplemental/results.json)及[实际启动截图](task114-evidence/supplemental/startup-fixed.png)。

**2026-09-14 审查修复与提交门禁更新：** 默认Vitest改为文件串行，保留全部用例、内部worker并发、原断言/期限及Go真实模型。修复后默认`pnpm test`退出0：Node7/7、185文件1328项全部通过、无跳过，783.85秒；Git冲突合并/abort用例824ms。typecheck/lint、工具G5 15项、原生G5 12项复验通过；350个构建输入全部匹配。已具备本次草稿PR交付条件，目标平台安装验收仍按下文保留。此前失败及诊断不改写；历史单次超时的精确阻塞位置未复现，不宣称发现Git合并逻辑bug。完整证据见[提交门禁记录](task114-evidence/commit-gates.json)与任务历史。

此前实现阶段的G3/G4、真实工具链与安装介质验证曾通过；下方原证据保留该时点，当前提交复验结果见上文。普通项目开发入口继续关闭。当前产物是arm64/macOS26.5上的ad-hoc开发验证包；Leader已选GitHub Releases DMG未公证分发，正式Developer ID/公证不再是当前缺口；ad-hoc升级钥匙串连续性、隔离下载和Apple Silicon macOS15干净安装仍需补验；Intel/x64已按Leader决定移出支持及验收范围。11.4保持in_progress，11.5未开工；PR交付查任务索引与历史，无tag/Release。

实现入口和边界见[详细设计§12.3.9](../详细设计方案.md#desktop-implementation-114)。完整过程及失败修复见[11.4历史](../task-history/11.4.md)。未新增依赖，公开领域端口、D18阶段启用与既有模型测试约定不变。

## 实现

- 随包提供锁定Node24.20.0、npm11.19.0、pnpm9.15.9、Git2.53.0及Keychain/secure-files helper；构建固定来源/hash，资源清单复核文件内容、执行权限和内部符号链接。
- 只读项目版本选择；未支持版本/范围语法/lockfile冲突明确拒绝。包内绝对路径与私有环境，不继承宿主模型密钥和Node注入选项。两个npm配置入口必须不同，已通过真实npm验证。
- 受信下载器只使用固定HTTPS来源，校验hash/体积后flush及原子发布，失败/取消不动已发布版本。真实pnpm下载成功和错误hash拒绝均实测。
- 状态升级基础在同一owner下执行备份、持久journal、逐文件转换、最后格式提交；准备不完整只允许在原状态未变时撤回。坏备份/路径/源状态/owner拒绝。生产格式仍为1；测试格式用于故障验证，不擅自加入未来领域迁移。
- arm64/x64独立本架构构建入口、明确嵌套签名和DMG/ZIP生成；实际完成的是arm64开发介质。无签名身份不尝试公证/上传，不改Gatekeeper或quarantine。
- 原生复验发现正常停服时的迟到导航拒绝可能污染状态；修复后只由当前ready服务报告窗口故障，并以真实子进程及包内原生检查复验。

## 验证与证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| typecheck / lint | 0错误、0违规 | [日志hash清单](task114-evidence/logs.json) |
| 完整pnpm test | Node 7/7；Vitest 185文件、1328项全通过；0失败/跳过 | [结果](task114-evidence/regression.json) |
| 真实模型 | 原Harness、频道摘要、LRU闭环均使用Go `deepseek-v4-flash`；原断言/期限不变，正式Benchmark未运行 | 同上 |
| 完整工具链G5 | 15项通过：包内版本/依赖准备、npm/pnpm真实安装和生命周期/测试脚本、版本不兼容拒绝、Git worktree及回收、helper读写与越界拒绝 | [工具结果](task114-evidence/tools.json) |
| 原生Electron组合根 | 12项通过；正常停服state=stopped、exitCode=0；独立临时Keychain已清理 | [宿主结果](task114-evidence/host.json)、[截图](task114-evidence/window.png) |
| DMG复制后启动 | 同一复制产物再次通过12项原生组合根检查，临时Keychain清理、exitCode=0 | [安装后宿主](task114-evidence/installed-host.json) |
| 下载失败 | 从同一固定官方pnpm来源获取真实字节，错误预期hash被拒绝；未发布档案，staging清理 | [失败路径](task114-evidence/download-failure.json) |
| ZIP与DMG | 两介质校验和一致；ZIP解压后签名完整性通过；DMG只读挂载、复制后签名/工具清单通过；本次卷已卸载 | [安装结果](task114-evidence/installation.json)、[介质](task114-evidence/media.json) |
| 升级与失败回归 | 准备、备份、文件替换、格式提交中断；继续/回滚、坏备份、外部改动、失效owner；新Phase11跨模块回滚保留配置 | `apps/desktop/test/upgrades.test.ts`、`tests/integration/phase11/phase11-4.test.ts`及完整回归 |
| 构建身份 | 工作树输入hash、固定依赖与下载、资源清单；非固定提交发布候选 | [输入](task114-evidence/build-input.json)、[包](task114-evidence/package.json)、[下载](task114-evidence/downloads.json) |

首轮完整回归的故障注入时点错误、npm双重配置、路径别名和一次原生导航竞争失败全部保留在历史与日志hash清单中；不以最终通过覆盖历史失败。

## 重现

1. 使用原生目标macOS构建机及已锁定仓库依赖，运行`pnpm --filter @agora/desktop build`；依`toolchain-catalog.mjs`准备下载，或运行`node apps/desktop/scripts/download-toolchains.mjs <new-directory> arm64`（旧x64入口不代表当前支持承诺）。
2. 运行`pnpm build:desktop <verified-download-directory>`生成开发验证包；`--revision <approved-commit>`才是固定提交输入。`--arch`必须与构建机原生架构匹配。
3. 运行`node apps/desktop/scripts/validate-tools.mjs <app>`。此命令在新临时项目实际安装固定依赖及执行测试脚本，需明确授权的测试范围和网络；不作为普通项目开发入口。
4. 运行`node apps/desktop/scripts/media.mjs <app> <new-output>`生成ad-hoc开发介质；当前发布沿用ad-hoc签名；Developer ID参数仅保留为可选能力，不自动启用。隔离下载与ad-hoc钥匙串升级仍须实测。
5. 运行`node apps/desktop/scripts/validate-media.mjs <media-directory>`核验ZIP和DMG，检查结果中的mounted=false；输出installedApp可传给`AGORA_VALIDATION_APP=<installedApp> pnpm --filter @agora/desktop exec electron <absolute-path>/apps/desktop/scripts/validate-host.cjs`，使用隔离真实Keychain运行生产组合根。
6. 门禁命令为`pnpm typecheck`、`pnpm lint`、`pnpm test`；原始日志路径和hash见证据目录。证据快照本身不是可执行工具包，不把本机临时路径当跨机器依赖。

## 未完成条件

按Leader新决定，不再等待Developer ID/公证权限。仍需两个不同ad-hoc构建之间的钥匙串访问/授权连续性、真实隔离下载安装，以及Apple Silicon macOS15和干净无开发工具环境证据。未收到可用环境前不能补写通过。旧包已完成本机Safari隔离下载、普通Applications安装及用户授权，但发现启动失败；修复正式包直接启动成功，修复DMG的同一路径安装启动已通过。升级测试发现新ad-hoc helper访问旧测试钥匙串被拒绝，重新授权测试仍待具体权限批准；没有改动登录钥匙串。阶段出口、固定提交候选及人工PR合并仍按原流程执行。
