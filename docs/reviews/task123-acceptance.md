# Task 12.3 实现与验收审查

状态：Task 12.3当前明确范围的实现与验收已就绪，G1/G3/G4/G5/G6/G7通过；macOS15仅按本次Leader例外处理。实现提交`f11bde5`已推送，[PR #86](https://github.com/logan-suu/Agora/pull/86)已创建，目标`dev-1.0.0`；人工合并前任务保持in_progress。

## 交付行为

- 明确获批的本机APFS普通目录使用文件manifest版本，不制造Git分支；Leader授权经规范POST、registry与TaskState闭合后，活worker/lease和写claim共同约束工具调用。
- 原生文件事务核验同次安全打开的版本和字节，支持创建/替换及有界批次；竞争或不确定副作用保全用户当前版本、候选和journal，阻止后续应用。
- 项目命令只读固定输入，写新建私有输出；由Seatbelt、held launcher、出生身份绑定和有界监督约束。真实退出与清理保证分别记录，发现残留/不确定资源不复用。
- 官方Harness、角色投影、MCP、GlobalScheduler与D4暂停/真Fork/新lease接合；独立Tester实际运行固定版本，Reviewer和Leader D16引用同一验证，终态归档及claim释放再次核验。
- `node-generate`只在副本生成，经MCP读取候选，再走普通版本事务；`pnpm-install`先按获批origin下载校验过的包，禁网安装和执行生命周期，冻结真实依赖树/锁。后续Node与独立Tester消费不可变依赖，而非用户已有node_modules或活安装输出。
- 五项本机helper加入15.0目标构建、桌面打包/签名/清单；本机工厂在模型配置/角色准入前实测隔离能力，失败保持`sandbox_unavailable`。

## G1 与责任边界

控制来源：详细设计§12.2、蓝图D18/§22.3.1、开发计划§18.2。冻结Executor/SandboxManager/TaskStateStore方法未改变；未新增第三方依赖；未移除Docker回归；普通项目入口保持关闭。

| 条目 | 本任务真实证据入口 | 保留的边界 |
| --- | --- | --- |
| L01 普通目录编辑/安装/生成/构建/测试 | phase12-3-grant、phase12-3-live-workspace、phase12-3-installation、phase12-3-composition | 12.6负责普通入口；本轮仅明确授权验收目录 |
| L02 越界、链接、父链/根漂移 | phase12-3-transaction、creation、root-registration、command-binding、command-isolation | 12.5继续接管/撤销与外部编辑完整流程 |
| L03 凭据、环境、fd、IPC及后代 | command-isolation、command-start；补充`task123-ipc-evidence/ipc.validation.ts` | 只用模拟秘密；Mach探针只查端口，不消息调用/读取Keychain |
| L04 禁网和授权下载 | phase12-3-download、grant/download与installation；local-execution-probe | 下载origin/GET/443/SHA-512及每跳边界；项目子进程不联网 |
| L05 安装/生成边界 | grant/generation、grant/installation及独立安装机制G5 | 不覆盖用户已有输出/cache/node_modules；候选不自动写源码 |
| L06 版本、创建/替换、半事务保全 | transaction、creation、grant/batch等 | rename不是内容CAS，不承诺瞬时撤销旧fd |
| L14 进程与资源收敛 | command-start、binding、stop、discovery、supervision、journal | bounded检查，不宣称全部后代必然退出；完整退出恢复归13.2 |
| L15 失败关闭、工具链及平台 | command-start、桌面toolchain-installation、local-task-composition与启动探测 | 仅macOS26.5实测；macOS15按Leader本次例外跳过，DEF-018保留 |
| L16 双存储闭合/幂等 | state-binding、grant中断、terminal-release等 | 新桌面主动恢复和退出归13.2 |

L07/L08/L09/L10/L11/L12/L13/L17/L18仍由表中后续责任任务完成，不将本任务的部分底座证据改写为Phase12/13出口通过。

## 明确限制

首个安装适配要求最多32个明确HTTPS/SHA-512包，完整匹配根package.json的精确dependencies/devDependencies。已有lock/config、workspace/override/optional/peer解析、源node_modules和未缓存传递依赖不受支持；真实离线失败或不支持错误如实返回。包的可执行脚本受同一边界；当前不是任意生态安装器。源码改变后须为新完整版本重新安装。普通目录输入有4096项/256MiB总量/16MiB单文件上限，MCP单次字节1MiB；超限拒绝。

macOS15未验证，最低15.0构建目标不变。本轮未生成发布DMG，helper构建/清单准备及桌面编译不能替代12.7介质验收。代码任务仍须PR人工合并才成为done。

## 检查记录

- 静态检查：`local-final-typecheck.log`；`local-final-lint.log`（585文件）；`local-final-desktop-compile.log`。
- 累计回归：`task123-command-evidence/final-full-regression.log`，冻结输入`final-source-checkpoint.json`（609文件）。最终7项脚本、225个Vitest文件/1748项测试全部通过，0失败/0skip，912.90秒；609份冻结源码hash全部一致。分层统计见final-test-summary.json，核验见final-source-verification.json。
- 补充IPC G5：`local-ipc-native-2.log`（1/1）；源及fixture清理在`task123-ipc-evidence/`，重跑命令为`pnpm exec vitest run --config docs/reviews/task123-ipc-evidence/vitest.config.mjs`。它是额外真实机制验证，不混入默认pnpm test计数；不修改默认匹配或排除既有测试。
- 生成/安装定向测试包含红测原因和中间失败，最终相关单测21/21及正式安装到独立验证/归档通过；各轮固定下载、编译副本和依赖先hash留证后删除，索引`local-generation-installation-cleanup-index.json`。

## 清理与交付状态

152个已确认停用的测试目录已清理，逻辑字节1523674，APFS可用空间观察增加25567232字节（不是独占回收量）。另31个本轮测试目录仍被PID76991的macOS Virtualization服务持有只读目录句柄，保守保留，不终止该系统/用户服务；清单及未删除原因见final-full-regression-cleanup.json。旧的证明不足目录、用户项目、全局缓存/正常依赖、已安装应用、产品状态/钥匙串不删除。原生夹具内下载/安装副本另由各自留证收尾，补充IPC夹具与临时控制器也已归档删除。

没有新增实现或回归阻塞；Leader已按AGENTS.md §10授权并完成commit/push/PR交付；仍须按§8.1.2由人类合并PR #86。英文交付说明见[PR #86](https://github.com/logan-suu/Agora/pull/86)，目标为dev-1.0.0。未将本任务标done、未推进12.4或普通入口、未发布安装包。

## 证据精简与历史路径

2026-09-16按Leader授权删除无后续用途的临时/重复/过时产物，统计见[精简记录](task123-evidence-retention.json)。当前保留最终验收证据；历史段落中的旧短路径/文件名如已删除，应从固定提交`05987ccbd20e6a55a553750577a900f44bc353d0`的原路径读取。测试原始输出已改至Git忽略的test-outputs/reviews，运行结束筛选必要证据，其余确认无用后清理。

### 精简后的验证

仅调整21份默认测试文件的证据输出前缀及独立IPC的输出目录创建；产品/runtime/build源码不变。主回归7脚本+1748测试通过（937.92秒，609输入hash匹配）；随后三个包内入口37项定向补验、IPC 1项通过，最终typecheck/lint通过。分步来源差异见[清理验证](task123-pr-cleanup-evidence/validation.json)。当前轮次的重复原始输出已删除，必要清理事实见同目录fixture-cleanup.json及regression-cleanup.json；31个未证明停用目录保持不动。
