# 11.3 Electron应用壳与本地服务生命周期

## 范围与来源

2026-09-14，Leader对11.3具体计划回复“确认”，随后显式调用agora-commit授权提交、推送和创建PR。实现位于`feat/task-113-electron-lifecycle`；任务保持`in_progress`，交付记录见[任务历史](../task-history/11.3.md)，不将本报告作为人工合并或Phase11出口完成证明。

控制原文（详细设计§12.3）：

> Phase11只开放安装、环境检查与故障反馈，11.3必须同时提供预览界面及服务端能力门禁；Phase12仅在已授权验收范围验证本机执行，Phase13才开放普通项目完整开发。

> ready、停止回执、子进程退出是三个独立事实；收到 stopped 后不得再次向已关闭 IPC 发送 stop，也不能在子进程未退出时报告所有资源已回收。

> 主进程只调用受信生命周期和既有服务入口，L1–L3 的依赖与 Executor/TaskStateStore/SandboxManager 公开方法不变。

完整落码映射见[详细设计§12.3.8](../详细设计方案.md#desktop-implementation-113)。复用既有`local-process.mjs`的Keychain/controlPath与生产instrumentation；没有改动旧CLI、Harness或公开端口。初始计划的CLI接缝抽取由直接复用替代，减少既有入口风险，原CLI回归照常执行。

## 实现与证据边界

| 项目 | 证据及边界 |
| --- | --- |
| 进程 | 实际Electron44.3.0主进程、正式ASAR内的生产组合根、包内Node24.20.0和Next15.5.24；服务不依赖源码开发服务器或宿主Node |
| 窗口 | sandbox/contextIsolation启用，Node与DevTools关闭；有限preload；关闭窗口隐藏并保持服务，显式stop等待真实exit，显式restart重新建session |
| 凭据 | 真实native helper、真实macOS Keychain专用临时文件；复用生产存储接口，固定新service ID；关闭保留同一钥匙串内容，验证结束删除本次测试Keychain。未读写用户旧产品凭据 |
| 独占 | 真实第二个Electron进程竞争同一userData锁，不spawn重复服务并唤回原窗口；真实文件owner与canonical Unix控制锁互斥，不凭PID或时间清除遗留锁 |
| HTTP/SSE | 实际Next预览页、静态chunk、React hydration与EventSource；缺capability/跨origin拒绝，全部现有产品API被前置门禁拒绝；旧session关闭连接并拒绝新连接 |
| CSP/IPC | Chromium报告内联handler被CSP阻止；外部导航/新窗口拒绝；可信主frame成功，另一真实窗口的IPC拒绝；认证capability不经preload/URL/磁盘传递 |
| 故障 | 真实空闲Node进程崩溃展示失败页；正式service-entry在读取未来格式时不报告ready、保持原文件并释放已获得的owner；启动中stop、清理失败保留所有权与重复stop由明确注明的确定性故障单元补充 |
| 打包 | 正式Packager20.3.0；fuses2.1.3配置、回读；逐Mach-O/嵌套bundle签名后整包`codesign --verify --deep --strict`；仅ad-hoc研发完整性证明 |
| 清单 | `.env*`/`.data`/`.git`/owner、越界trace、外部链接、未知资源拒绝；开发源码/测试及ssh2 Windows文件作为已审查排除项留档；许可证保留，最终资源记录hash |

G5隔离接缝说明：`validate.cjs`/`validate-host.cjs`由官方Electron启动，直接import正式包中的`DesktopService`/`runDesktop`及真实preload，只把Keychain存储目标换到专用临时Keychain。受信组合的测试注入不是renderer或产品IPC开关。正式`service-entry.js`另有未来格式拒绝实测；普通默认Keychain成功启动尚未作为真实用户安装验收，安装连续性归11.4/11.5。

## 验证记录

- 桌面专项最终17项通过（7个文件）：协议、生命周期、存储、HTTP/SSE、服务故障、资源清单、Phase11集成。
- 第一轮全量：Node任务追踪测试7/7；Vitest178文件、1300/1300项，129.07秒。真实提供方/模型为`opencode-go/deepseek-v4-flash`，包含实时Harness、摘要和Phase0 LRU链路；未改变模型/期限/思考/容量，不skip，不运行正式Benchmark。
- 最后资源清单修正后再次运行完整门禁及重建；最终结果和产物摘要见本节下方的最终核验记录。
- 桌面测试不声称Phase11出口已完成，产品预览不调用模型、不执行普通项目、不启动Docker；全量既有回归继续验证此前交付的Docker路径。

### 最终核验

- `pnpm typecheck`及`pnpm lint`通过（466文件）；完整`pnpm test`再次通过：Node测试7/7，Vitest178文件、1301/1301项，116.58秒；真实提供方/模型保持`opencode-go/deepseek-v4-flash`。
- 最终包真实运行验证23/23，生产主进程验证9/9；两次专用Keychain均已清理。预期的CSP拒绝和错误sender拒绝日志属于负向断言证据，未出现未预期的页面功能失败。已目视检查预览截图。
- 最终干净输入333文件，与工作树逐项hash比较零差异；基线`6c8a7888f5d6d6cccdab11bf9403a17e7d693ad0`，输入清单SHA256 `b15e2805d60a45e7d5441e1c30a218fe0c493871d26dbca6996346ad4d013999`。
- 正式Packager产物资源10163文件、323583839字节（这是Resources文件合计，不是整个应用或下载体积）；36个开发/异平台候选明确记录并排除。最终资源未发现禁入路径或开发源码/测试；ASAR/fuses及嵌套签名验证通过。
- 本机产物：`/private/var/folders/_r/6dh_2jf542d4p97jl9nqwk480000gn/T/agora113-build-dhyl3o/output/app/Agora-darwin-arm64/Agora.app`。同级output保留完整资源manifest及trace审查，build根保留输入manifest。
- 可追溯摘要、完整检查名称与排除明细：[results.json](task113-evidence/results.json)；真实窗口截图：[preview.png](task113-evidence/preview.png)。所有结果为研发验证，不改写后续任务和发布状态。

### 失败与修复（保留失败，不用重试覆盖）

1. 首批TDD缺模块失败后逐项实现；本机listen在工具沙箱EPERM，正常授权权限下真实监听通过。
2. Packager是命名导出且返回产物父目录，最初导入和ASAR/fuses目标路径错误；按实际API修正，正式Packager后续成功。
3. Packager `extraResource`复制把pnpm相对链接展开为绝对staging链接；最终资源审计/签名拒绝。改为审计后以`verbatimSymlinks`复制并复查包内目标。
4. 静态trace遗漏Next动态webpack别名及Babel runtime清单，真实Node启动分别报缺依赖；依据实际Next源码的动态解析补显式入口，完整重验。没有通过源码目录或全局node_modules补洞。
5. macOS `/var`与`/private/var`别名导致合法输入误报越界；使用canonical根验证真实目标，保留词法相对布局，并补真实临时目录回归。
6. stop通知监听器重入会创建第二个Promise；先补失败断言，再在通知前固定stop Promise，重入与普通重放共用同一结果。
7. 首个CSP测试把动态script当作必须拒绝对象，Chromium执行了它。规范的`strict-dynamic`信任传播允许可信脚本创建动态脚本（[W3C讨论及修订](https://github.com/w3c/webappsec-csp/issues/426)）；保留生产CSP，改为验证无nonce内联handler确实不执行且产生`script-src-attr`违规事件。外部导航、窗口、错误sender和认证断言同时保留。
8. 首次验证器销毁最后窗口导致Electron在证据/临时Keychain清理前退出；验证器显式保持生命周期至finally，单独删除该次遗留测试Keychain，后续结果均记录`keychainRemoved: true`。
9. 最终trace审查发现开发TypeScript/测试和Windows专用文件混入候选；新增分类/未知文件拒绝测试（先红后绿），输出`trace-review.json`。首次严格构建拒绝合法的web workspace包链接，明确允许五个实际运行入口后重新构建；没有放开任意仓库文件。

## 后续交付边界

- 当前构建为`development-working-tree`，有基线commit与每输入文件hash。提交获批后用`pnpm build:desktop <verified-download-directory> --revision <git-commit>`生成最终固定提交候选并核对；不擅自commit。
- 本轮只在arm64/macOS26.5开发机验证，应用标记最低15.0；Intel、最低系统和干净Mac安装未完成，不缩减平台承诺。
- 11.4负责受管Git/pnpm及完整工具链、两架构安装介质、签名/Keychain升级连续性和迁移事务故障验证；11.5负责干净目标环境与累计出口及发布候选。
- 不提供Developer ID签名、公证或Gatekeeper验收承诺；不修改Gatekeeper或quarantine。新格式1/未闭合升级拒绝不等于已完成升级事务。
- 用户项目本机执行、授权、正常工作恢复及Docker退役按12.2/13.2/13.3推进。

## 重现入口

```sh
pnpm build:sandbox-native
pnpm build:keychain-native
pnpm typecheck
pnpm lint
pnpm test
pnpm test:desktop
pnpm build:desktop <verified-download-directory> [--revision <git-commit>]
AGORA_VALIDATION_APP=<absolute-Agora.app> <official-Electron-executable> apps/desktop/scripts/validate.cjs
AGORA_VALIDATION_APP=<absolute-Agora.app> <official-Electron-executable> apps/desktop/scripts/validate-host.cjs
```

构建缓存要求`node.tar.gz`、`electron.zip`、`pnpm.tgz`，精确来源版本/校验和在构建脚本和选型§12；构建前强制校验。验证脚本使用仅含系统基本变量的环境，不继承模型凭据。它们不创建发布、全局工具链或生产项目。
