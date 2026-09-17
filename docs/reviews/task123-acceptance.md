# Task 12.3 实现与验收审查

状态：2026-09-16 PR #86两项审查问题已修复；42项定向测试、7项脚本检查及226文件/1752项完整回归全部通过，0失败/skip；原生构建、桌面编译、typecheck及587文件lint通过。仍未执行主动绕过验证；Task 12.3保持in_progress，等待PR人工合并。


## 2026-09-16 PR #86 修复复验

Leader明确“进行修复”后完成以下变更：

- P1：TypeScript文件准入/manifest校验复用保留ASCII名称检查，原生helper的逐段检查与枚举同步大小写折叠。四项准入前防御性测试先红后绿；真实文件清单用空保留名称夹具证明排除规则一致。不执行已跳过的主动绕过验证，不将静态发现改写成已实测泄露。
- P2：普通Node相对参数在依赖准备、固定输入/输出创建及prepared落盘前校验，实际解析复用相同函数。真实临时夹具先红，修复后确认错误请求没有新增控制引用，同workspace读取与后续合法命令成功。已经真实进入准备/执行的不确定错误仍保全，不自动清除旧journal。
- 最终门禁：3文件42项定向回归通过；完整pnpm test为7脚本、226文件/1752测试，0失败/skip，1005.58秒。真实Go deepseek-v4-flash LRU、本机Harness组合、D4 Fork、独立Tester/D16和归档在累计回归中通过。595项冻结源码/配置指纹全部一致。原生helper构建、桌面TypeScript编译、typecheck及587文件lint通过。
- 精简：仅新增[4份必要证据](task123-pr86-fix-evidence/validation.json)，保留两次红测原因、最终日志及hash/清理摘要。删除374份重复原始输出（4674873逻辑字节）、98个确认停用测试目录（933342逻辑字节）；8个目录因句柄/停用检查未闭合保守保留。此前目录及用户项目、共享缓存、应用未动。原始失败与现有验收记录保持可追溯。
- 两项初审发现的修复已通过上述复验；普通入口、macOS15本次例外及后续任务边界不变。PR由人类合并，不将修复或完整回归通过等同于任务done。

## 2026-09-16 PR #86 初审（修复前）

审查HEAD：`dbeea6b0ec6e5829c24d76c3552d04f424295585`；base：`dev-1.0.0`。本轮仅静态代码/规格及既有验收证据审查，未修改产品或测试代码、未重新执行累计回归。用户报告平台内容限制后，明确选择跳过主动绕过验证，继续静态审查；未尝试规避限制。以下问题不是动态复现结果。

### P1：保留路径识别没有覆盖文件系统的大小写等价名称

位置：`packages/runtime/sandbox/src/local-file-transaction.ts:177–180`；原生对应 `packages/runtime/sandbox/native/local-file-transaction.c:118–120`，目录枚举同样使用大小写敏感比较。

`validatePath`及原生逐段检查对`.env`、`.env.*`、`.git`和`.agora-operations`仅作大小写敏感字符串匹配。契约允许本机APFS，未限制为大小写敏感卷。在不区分大小写的卷上，这不足以确保被排除对象的其他等价名称仍被拒绝；上层`LocalWorkspaceFiles.read`直接把通过检查的路径交给原生读取，文件读取策略允许整个绑定根，未见额外的等价名称排除。由此存在秘密/控制文件进入普通文件访问路径的风险。当前是高置信度静态发现，按用户指示未进行主动绕过实测，不宣称已发生泄露。

控制原文（详细设计§12.2.2.2）：“默认排除 `.env`、`.env.*`（明确无秘密的 example/template 可准入）、凭据文件及用户标记的敏感路径”。修复应统一TS、原生读取/事务与manifest枚举的保留路径判断，按支持文件系统的名称等价语义拒绝受保护对象，并补充不含真实秘密的防御性回归；不能只修一层或放宽排除规则。涉及G1/G7。

### P2：参数校验晚于prepared落盘，输入错误会阻止后续工作

位置：`packages/runtime/sandbox/src/local-workspace-commands.ts:587–596`，关联同文件529行与345–370行。

普通`node`请求的入口只检查argv类型/数量/大小；特殊路径参数在不可变`workspace-command-prepared-v1`引用落盘、固定输入和输出目录创建后才检查。无效参数在这里抛出`invalid_command_argument`，此时尚未启动命令，也没有写入对应终态result。随后同动作重试因缺少result返回`workspace_command_recovery_required`；新动作的`assertQuiescent`也扫描到这条未闭合prepared并拒绝，文件操作通过相同guard受影响。模型一次参数拼写错误即可使当前工作区后续操作持续失败；现有跨进程恢复后置安排不应把可事先拒绝的输入错误变成不确定执行。

控制原文（详细设计§12.2命令端口接合）：“`@input/<relative>`与`@output/<relative>`参数分别解析到本动作固定输入和全新输出目录；拒绝越界分段。”修复应在任何prepared/依赖挂接/资源创建之前完成纯参数校验，并对确已进入准备阶段的失败保存准确闭合事实；不得把可能已启动的命令伪记为未执行。补测无效请求拒绝后，同workspace的合法读取及命令仍可用。涉及G1/失败语义。

### 已有评论与验证边界

CodeRabbit因文件数超限跳过审查，没有实际代码评审结论；API中reviews和行内comments均为空。[跳过说明](https://github.com/logan-suu/Agora/pull/86#issuecomment-5707471234)不能视为通过。人工合并、普通项目入口及macOS15未验证边界不变。此前7脚本/1748测试全绿继续作为该轮真实结果保留，本轮未运行新测试，也未发布GitHub评论、修改PR或合并。

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

此前交付时未记录新增实现或回归阻塞；本轮审查待修项见上文。Leader已按AGENTS.md §10授权并完成commit/push/PR交付；仍须按§8.1.2由人类合并PR #86。英文交付说明见[PR #86](https://github.com/logan-suu/Agora/pull/86)，目标为dev-1.0.0。未将本任务标done、未推进12.4或普通入口、未发布安装包。

## 证据精简与历史路径

2026-09-16按Leader授权删除无后续用途的临时/重复/过时产物，统计见[精简记录](task123-evidence-retention.json)。当前保留最终验收证据；历史段落中的旧短路径/文件名如已删除，应从固定提交`05987ccbd20e6a55a553750577a900f44bc353d0`的原路径读取。测试原始输出已改至Git忽略的test-outputs/reviews，运行结束筛选必要证据，其余确认无用后清理。

### 精简后的验证

仅调整21份默认测试文件的证据输出前缀及独立IPC的输出目录创建；产品/runtime/build源码不变。主回归7脚本+1748测试通过（937.92秒，609输入hash匹配）；随后三个包内入口37项定向补验、IPC 1项通过，最终typecheck/lint通过。分步来源差异见[清理验证](task123-pr-cleanup-evidence/validation.json)。当前轮次的重复原始输出已删除，必要清理事实见同目录fixture-cleanup.json及regression-cleanup.json；31个未证明停用目录保持不动。
