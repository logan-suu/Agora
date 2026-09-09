# Task 10.4 macOS 本地启动与主密钥管理验收

日期：2026-09-09。分支：`feat/phase10-local-startup`。实现与交付记录：[PR #71](https://github.com/logan-suu/Agora/pull/71) 已创建并推送，任务保持 `in_progress`，待人工合并；不是 Phase 10 最终出口或 Benchmark 报告。

## 范围与实施

Leader 先要求开始10.4，随后明确“先仅适配macOS”，并在修订计划后再次要求“开始10.4”。本轮仅实现和验收 macOS 产品启动器、自动钥匙串管理及相关配置体验；Linux 产品适配见 DEF-017，不阻塞本轮，既有底层 Linux 沙箱支持保留。

- `pnpm run setup` 检查 Node24、pnpm9.15.9、Git、clang、Docker，构建沙箱 helper、Keychain helper 和 Next 生产产物；`pnpm run doctor`、`pnpm start`、`pnpm stop` 为正式本机入口。未引入新 npm 或 Linux 系统依赖。
- 本机 Next custom server 固定回环监听，按规范数据根锁定权限0600 Unix控制socket，拒绝重复实例、端口冲突和跨站请求。启动等待 instrumentation 完成凭据初始化后才开放HTTP；停止先拒绝新工作，等待已接收写请求/模型请求和全部run自然收敛，最后关闭HTTP/SSE并保留数据。
- macOS Security.framework helper 使用原子新增与重复项回读，复用 service `com.agora.local.credentials` / 当前用户名 account。先列 item refs 再读内容，拒绝锁定/冲突/无效形态；没有默认更新/删除凭据入口。不同数据根共用系统原子创建语义，不新增一个进程内调度器。
- 显式高级环境值优先，但不自动写回系统；缺失或不匹配的历史密钥不被替换。扫描当前数据根内所有不可变连接版本，包括旧任务仍可能引用的版本。`credentials:adopt` 只显式接管相同密钥，不轮换或重加密。
- 主密钥只在受信启动层与后端内存/私有管道中使用，构建、Git、MCP、用户沙箱不继承它。保留已配置的 `DEEPSEEK_API_KEY` 测试凭据。设置页只展示白名单恢复提示，不要求普通用户输入主密钥。
- 未更改 Executor、SandboxManager、TaskStateStore、MessageBus 或 collaboration 冻结端口；State schema 与任务模型绑定不变。

## 测试与真实执行证据

| 检查 | 结果 / 证据 |
| --- | --- |
| 密钥生命周期单元 | 6/6：并发首次创建/重启解密、历史缺失与不匹配、显式有效/无效配置、不覆盖系统项、异常安全反馈、坏JSON/符号链接及显式接管 |
| 真实 macOS 钥匙串 | `tests/integration/phase10/phase10-local-startup.test.ts` 1/1；独立有密码临时钥匙串，创建/回读、并发新增复用、锁定/解锁、删除原测试项后拒绝换钥、错误测试密钥拒绝解密；最终定向808ms |
| 停止与环境隔离 | admission同步关闭；在途worker完成前drain不返回，随后保留completion gate且不归档；LocalTemp真实子进程收不到主密钥；构建子进程环境保留其他配置 |
| 完整回归 | `pnpm run test --maxWorkers=2`：**134文件 / 1077测试通过，0失败 / 0 skip**，247.17s；包括既有live DeepSeek、Docker及D4/Fork等全部回归；日志 `/tmp/agora104-full-test.log` |
| 独立产品链 | `local-launcher.eval.ts` 1/1，14.93s：真实Keychain→Next/HTTP保存→停止/重启→原连接主动请求→生产Harness/MCP/Docker/Git/State/session/Trace执行fs_write与sandbox_run；本机provider固定响应，未冒充真实模型；重复实例/跨站写入拒绝；测试资源全部正常清理 |
| 独立真实模型 | `local-keychain-live.eval.ts` 1/1，5.31s：自动Keychain生成、持久复用、真实DeepSeek Flash配置及生产composition；实际fs_write与sandbox_run成功，检查State/Trace不包含API Key；日志 `/tmp/agora104-live-g5.log` |
| 原有开发Mac兼容 | 在没有 `AGORA_CREDENTIALS_KEY` 的进程中，以正式launcher读取现有用户Keychain及默认 `.data` 历史连接，127.0.0.1:3105正常ready且无credentials unavailable提示；随后正式stop成功。未修改模型设置/原密钥、未运行用户任务 |
| G3与构建 | `pnpm typecheck`、`pnpm lint`通过；原生helper和Next生产构建通过，日志 `/tmp/agora104-final-build.log`。正式setup命令另行核验见本记录收尾段 |
| 安全扫描 | 交付文件精确集合先行gitleaks脱敏扫描通过；无主密钥明文文件、argv或DTO新增。最终扫描与差异结果见收尾段 |

显式G5命令：

```sh
pnpm exec vitest run tests/integration/phase10/phase10-local-startup.test.ts
pnpm exec vitest run --config vitest.eval.config.ts tests/evals/phase10/local-launcher.eval.ts
pnpm exec vitest run --config vitest.eval.config.ts tests/evals/phase10/local-keychain-live.eval.ts
```

所有模型代码均通过真实沙箱执行。新两个 `.eval.ts` 是显式基础设施/live G5入口，不匹配默认测试，不产出Benchmark指标。耗时仅记录本次执行，不宣称性能结论。

## 浏览器QA

环境：`http://127.0.0.1:3104`，桌面1440×1050、手机视口390×844；**Browser plugin not available**，按技能使用捆绑Playwright与已安装的Chromium headless shell 1194。捆绑Playwright默认寻找的1234浏览器未安装，明确指定已有浏览器路径，未下载依赖。手机验证是本机浏览器视口模拟，不代表从远程手机访问回环服务。

流程：本机主页→团队统一模型设置→保存测试连接→刷新→CODER单独覆盖→手机导航→恢复默认；另以无效高级配置启动独立临时实例→设置页显示安全恢复指引。只保存无效测试API Key，浏览器QA未发起外部模型请求。

| 检查 | 结论 |
| --- | --- |
| 页面身份 | URL匹配，title=Agora |
| 非空与框架错误 | 有完整工作区及设置弹窗，无Next错误overlay |
| 桌面操作 | 全6角色批量保存、仅CODER覆盖、刷新持久恢复均经API状态复核 |
| 手机操作 | 经Open workspace navigation进入设置，恢复默认成功，API确认全部connectionId清除 |
| 凭据 | 保存后密码不展示；DTO不含测试API Key；无效主密钥时展示恢复操作，无普通用户主密钥输入框 |
| Console / 网络 | pageerror为空；新任务尚未创建时默认 `lru-demo` GET返回404，由界面显示Not started，属于预期空状态，非框架错误 |
| 视觉检查 | 已实际查看桌面保存、手机及密钥恢复提示截图；手机弹窗可滚动，控件可用，无横向重叠。恢复默认按钮操作后截图处于弹窗下部滚动位置 |

截图（临时验收文件，不入源码）：

- `/tmp/agora104-desktop-saved.png`
- `/tmp/agora104-mobile-config.png`
- `/tmp/agora104-mobile-reset.png`
- `/tmp/agora104-keychain-recovery.png`

QA脚本中的初次定位失败分别来自API Key标签附带帮助文本、Connection标签包含选项文本、保存通知文案及手机侧栏尚未打开；按实际DOM与源码修正定位后全流程通过，没有为此修改产品行为或弱化断言。先前错误提示只见于这些临时自动化脚本，不是产品保存失败。

## 发现与修复记录

1. 首组密钥测试在无实现时红，增加生命周期逻辑后绿。
2. 真实Keychain初验发现 macOS文件钥匙串不接受当前 `returnData + matchLimitAll` 组合（OS -50）；修正为列refs再读内容。锁定item可返回auth-failed，改为读取所属Keychain状态后明确标locked，真实锁定/解锁验证通过。
3. 产品链发现Next prepare返回与异步Keychain初始化存在时序差，增加显式完成通知并等待，再开放HTTP；原完整产品链复验通过。
4. sandbox的旧LocalTemp.run会继承父环境；现在只移除主密钥变量并运行真实子进程证明，未移除开发模型凭据。
5. 停机除run外也等待已接受HTTP写请求，保护主动连接测试等在途模型请求；drain失败保留可重试进程，不强制终止token流。

macOS授权拒绝、系统不可用和冲突等异常由注入OS端口的单元测试覆盖；原生OS链实际覆盖锁定、原项丢失、错钥及真实创建/读取，不把模拟的授权拒绝宣称为手动点击系统拒绝按钮的实测。钥匙串授权弹窗的人工交互体验未作自动化承诺。Linux不属本轮验收。异常进程退出仍没有任意时点自动续跑能力，按D4/D10既有边界解释。

## 收尾核验

- 正式 `pnpm run setup` 成功，包含依赖检查、两个原生helper和Next生产构建；日志 `/tmp/agora104-setup.log`。正式 `pnpm run doctor` 成功，日志 `/tmp/agora104-doctor.log`。使用 `run doctor` 避免调用pnpm自身同名命令，README及启动器错误提示已同步。
- 最后控制socket增加断开客户端错误处理后，产品启动G5复验1/1通过，17.09s，日志 `/tmp/agora104-final-launcher-g5.log`。
- 所有临时验收服务已停止；真实开发数据、已有Keychain项和开发模型凭据保留。该段记录的是提交前检查点；随后已创建并推送PR #71，当前保持in_progress，待人工合并。

- 最终全量回归：**134文件 / 1077测试通过，0失败 / 0 skip**，345.81s，日志 `/tmp/agora104-final-full-test.log`。最终类型检查和lint通过（339文件），日志 `/tmp/agora104-final-static.log`；最后仅修正doctor命令提示，无运行逻辑变化。
- G7：33个交付文件的精确集合gitleaks脱敏扫描通过，无泄漏；日志 `/tmp/agora104-final-secrets-scan.log`。`git diff --check`通过。

## 提交门禁复核（2026-09-09）

提交前审查发现此前停机代码虽然记录activeWrites，却未真正await，与前文停止说明不符。新增真实Next启动G5：延迟provider返回、发起设置页test请求、请求stop，证明请求必须完整成功后才能关服。修复前实际出现socket提前关闭（红，`/tmp/agora104-commit-drain-red.log`）；修复为关闭写入admission后先等待全部已接收写请求，再drain任务和关闭HTTP（绿）。此前“等待已接收写请求”的实现结论以本次修复后证据为准。

修复后 `pnpm typecheck` 与 `pnpm lint` 通过；两条显式G5共2文件/2测试通过，12.62s，日志 `/tmp/agora104-commit-g5-final.log`，包括真实Keychain/Next保存重启/在途请求停机/生产工具链及真实DeepSeek。首次门禁命令的maxWorkers参数被pnpm test自身拒绝，未执行测试；已改用 `pnpm run test --maxWorkers=2` 执行全部测试，无跳过或排除。

提交门禁完整回归：`pnpm run test --maxWorkers=2` **134文件/1077测试通过，0失败/0 skip**，260.91s，日志 `/tmp/agora104-commit-test.log`；静态检查日志 `/tmp/agora104-commit-typecheck.log`、`/tmp/agora104-commit-lint.log`；33文件精确秘密扫描无泄漏，日志 `/tmp/agora104-commit-secrets.log`。`git diff --check`通过。Leader已显式授权提交、推送及PR，任务仍保持in_progress，PR信息记录于task-status.json。

## PR #71 评审修复

Leader授权修复后，新增归档失败与资源释放失败的停机回归：两例在旧实现均失败，修复后相关Runtime测试18/18通过。`drain()` 先重试 pendingFinalization；未完成则保留 composition 并报告失败，完成后才允许停机，已归档的重试不再归档。红日志 `/tmp/agora71-fix-red.log`，绿日志 `/tmp/agora71-fix-runtime.log`。这些是明确注入归档/释放故障的Runtime回归，不冒充真实Docker故障G5。

其余审查项：重复实例断言限定具体控制socket错误；产品G5从首次资源获取即进入清理保护，每次获取登记逆序清理；非macOS检查移至创建临时目录前；主密钥先断言ready/存在再检查日志，无no-key占位；OS失败断言完整字段与空key；测试helper补stdin错误监听；类型声明经公开包入口导入。保留Node24产品锁定，不按bot建议扩展未验收版本。交付状态更新为PR #71已创建、待人工合并。

修复后交付门禁：`pnpm typecheck`、`pnpm lint`通过；`pnpm run setup`成功，原生helper及Next生产产物已重建（`/tmp/agora71-build.log`）。完整回归 **134文件/1079测试通过，0失败/0 skip**，288.34s（`/tmp/agora71-test.log`）；两条真实G5 **2/2通过**，12.59s（`/tmp/agora71-g5.log`）。秘密扫描无泄漏（`/tmp/agora71-secrets.log`），`git diff --check`通过。修复更新同一PR #71，任务仍in_progress，须人工合并。
