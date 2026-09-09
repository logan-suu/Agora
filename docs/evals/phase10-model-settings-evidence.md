# 10.3 用户模型配置验收记录

**[2026-09-09 Leader 本地范围同步]** 本记录中的服务端、运行配置均指用户本机 Agora 后端；当前不部署云端。D8、任务 10.4、相关设计/计划与 README 已同步；仅文档变更，源码内容哈希与任务 ID/status/dependencies 对照无变化，JSON/Lint/diff 检查通过。本次未重新运行模型或集成测试，也未把本地启动器或自动主密钥管理记为已实现。

日期：2026-09-09。分支：`feat/phase10-model-routing`。Leader 已确认逐 Agent 模型配置及一次统一配置全部 Agent 的修订计划。任务保持 `in_progress`；历史诊断与最新交付结果分别记录于下文，未宣称 PR 合并。全 Flash/全 Pro/混合预设、九次对照与 USD10 实验建议已撤回，未执行；本记录不提供 Benchmark 成本/效果结论，10.5 保留。

## 交付门禁首次执行：未通过（2026-09-09）

Leader 调用 `agora-commit` 后重新执行交付检查。当前分支 `feat/phase10-model-routing` 与最新 `origin/dev-1.0.0` 基线一致，任务 9.5 已完成。原生 helper、`pnpm typecheck`、`pnpm lint` 通过；37 个交付文件约 1.40MB 的 gitleaks 脱敏扫描及已有环境秘密值检查通过，`.data/local/start-agora.sh` 未进入交付清单。

本轮 `pnpm run test --maxWorkers=2`：**128/129 文件通过，1050/1051 测试通过，1 失败、0 skip，244.39s**。唯一失败是 `packages/tools/git/test/git-service.test.ts:81` 的 `initializes a nested task repository without discovering or branching the enclosing checkout`，错误为 `Test timed out in 5000ms.`。本次只确认超时现象，尚未定位根因，不能判定为负载抖动或实现缺陷。未修改超时、弱化断言、移除凭据或跳过测试。

10.3 专属真实 HTTP/SSE/Harness/MCP/Docker/Git/Fork 集成在本轮通过。因完整回归门禁失败，按 `agora-commit` 的 `Stop on any failure.` 停止后续交付；独立显式 `model-connection.eval.ts` 未在本轮继续执行。下文之前的全部通过与 live G5 结果保留为历史证据，不替代本轮结果。日志：`/tmp/agora103-delivery-test.log`。未暂存、提交、推送或创建 PR，10.3 保持 `in_progress`。

## 超时审查与复现（2026-09-09）

Leader 授权“进行审查修复”后，按三个假设检查：①串行真实 Git 操作在全量负载下超过默认 5 秒；②外层测试仓库继承宿主 hook/签名/fsmonitor 配置；③初始化/清理的锁等待或实现问题。未查到相关宿主配置项，顺序调用路径未发现明显锁循环；不能仅凭代码检查排除所有环境问题。

| 原样诊断 | 结果 |
| --- | --- |
| 单独选择失败用例 | 1/1 通过，952ms；同文件另外 25 项未选择，仅作最小复现，不作为完整门禁 |
| 完整 Git 文件 | 26/26 通过、0 skip；原用例 1614ms，整次 23.22s |
| 完整 Git 文件 + 透传子进程计时 | 26/26 通过、0 skip；原用例 923ms，整次 16.32s；观察到 29 次真实 Git 命令，均 exit 0，累计子进程耗时 391.87ms，最大 38.58ms |

临时计时器只观察真实子进程的命令类别、退出码和耗时，不替换 Git 或伪造结果，不记录命令参数/输出/凭据，不进入仓库。诊断日志位于 `/tmp/agora103-git-repro.log`、`/tmp/agora103-git-file-repro.log`、`/tmp/agora103-git-profile.log` 与 `/tmp/agora103-git-timing.jsonl`。

结论：原超时尚未复现，耗时波动是当前较符合证据的解释，但根因仍为 inconclusive。没有据此修改生产代码、拆减断言、增加 timeout/retry 或移除测试；后续门禁仍按原 `maxWorkers=2` 完整运行，结果单独记录。CodeRabbit 外部审查命令被自动审批拒绝（第三方代码出站未获明确授权），未发送本次改动，已向 Leader 请求单独授权；上述结论仅来自本地诊断，不冒充 CodeRabbit 审查结果。

## 审查后交付门禁：通过（2026-09-09）

原样完整复跑 `pnpm run test --maxWorkers=2`：**129 文件 / 1051 测试全通过，0 失败 / 0 skip，322.85s**，日志 `/tmp/agora103-review-full-test.log`。原嵌套仓库用例 1150ms；10.3 独立 HTTP/SSE/Harness/MCP/Docker/Git/Fork 集成 3153ms；既有真实 DeepSeek LRU 闭环 245529ms，全部 Docker 与累积回归实际执行。未设置自动 retry、未排除用例、未调整测试/产品超时，未修改生产源码或断言。

同期只读资源采样：8 逻辑核，1/5/15 分钟 load average 为 37.90/71.96/56.55；该观察支持资源竞争可能性，但不是首次超时的直接因果证据。超时根因仍标 inconclusive，不将本轮成功描述为已修复确定的业务缺陷。

独立显式 live G5 `tests/evals/phase10/model-connection.eval.ts` 本轮 1/1 通过，测试耗时 4390ms、命令总耗时 5.26s，日志 `/tmp/agora103-review-live-g5.log`；使用保留的开发 DeepSeek 凭据，经加密配置及生产组合根真实完成模型/MCP/Docker 工具操作。`pnpm typecheck`、`pnpm lint`（324 文件）及 `git diff --check` 再次通过，原生 helper 沿用同一源码下本次交付已通过的构建。源码/测试内容哈希与首次门禁一致；先前浏览器与生产构建证据适用于相同实现。本轮继续用户已授权的 commit/push/PR，CodeRabbit 外部审查仍未获出站授权、未执行，不属于这些本地门禁结果。

## 已实现行为

- Team 的每个 Agent 有 Model 入口，Team 级入口一次配置全部成员；人类 Leader 没有模型设置按钮。弹窗中的角色选择包含项目自定义和 disabled 成员；departing/departed 不进入目标。
- Base URL、模型名、API Key、显式 no-auth、已有连接复用、上下文/输出上限；保存、取消、主动连接测试、恢复部署默认值。保存后只展示凭据是否配置，不回显原 key，也不使用 localStorage。
- 全员保存通过同一 revision 的单次 collaboration CAS，另一个页面或成员变动产生冲突，不循环单人写入。保存与恢复默认不发模型请求；可以统一保存后单独覆盖 CODER。
- AES-256-GCM 加密 API Key，项目内连接版本不可变；Task 模型绑定在重资源创建前原子固定。后续波次和 D4 真 Fork 使用原绑定，新的项目设置只供新任务。任务开始后新入职角色使用该任务固定的部署默认模型，D13 保留。
- Harness 官方 `dsh-llm-pi-ai` + `dsh-credentials` 同版本 `0.1.1-rc.2` 公开接缝；真实 provider/model/maxTokens 在 `agent/request` 固定，未自研 loop/retry。Next.js 将 pi-ai 作为服务端外部依赖，避免其动态模块加载被打包破坏。

## 本地运行配置与边界

本机 Agora 后端进程须通过环境变量取得 `AGORA_CREDENTIALS_KEY`：32 字节随机值的 base64 编码，跨重启保持同一值，与 `.data` 分开管理（用户可通过本机安全凭据管理向启动进程注入；当前代码没有自动生成或系统密钥库接入）。本地运行仍需保护已保存 API Key，不需要云端服务器或云秘密管理服务。缺失或无效时保存新 API Key 明确不可用；无鉴权连接及原有部署 DeepSeek 默认路径仍可用。丢失/直接替换主密钥会使历史连接无法解密；本任务没有在线主密钥轮换/重加密 UI。不要将 API Key 或主密钥写入仓库、浏览器存储或普通配置文件。旧任务仍引用连接，因此恢复默认不会删除连接文件。

**[2026-09-09 本机操作与 10.4 目标补充]** 当前开发 Mac 已将随机主密钥保存至 macOS 钥匙串，并以 gitignored `.data/local/start-agora.sh` 读取后注入本机后端，仅监听 `127.0.0.1`。真实 `JsonModelConfigStore` 加密/读取解密验证通过；本机模型设置 GET 返回 HTTP 200、`credentialsAvailable=true`，验证数据已清理，未输出主密钥或写入明文配置。此项是本机操作验证，不是产品自动初始化或跨平台验收。Leader 随后确认普通用户无需手工配置主密钥：10.4 必须提供首次自动生成/系统安全存储/重启复用，环境变量仅为高级兼容入口，并按蓝图 §21 D8、详细设计 §3 验收异常恢复与旧凭据保留。该产品能力尚未实现，10.3 原有实现和测试结果不替代 10.4 验收。

协议范围：Chat Completions、文本/SSE/function tools，HTTPS 或回环 HTTP；不声称支持 Responses-only、OAuth-only 或任意服务商私有参数。手工模型默认 context 32768 / output 4096，用户按服务能力编辑。服务端仅允许当前指定的精确请求 URL，禁止重定向、URL userinfo/query/fragment，不继承无关凭据；普通非模型 HTTP 调用不受请求范围策略影响。保留 D8 受信单用户单实例边界，没有新增公开多用户认证或跨实例协调。

主动连接测试只发短文本请求，不代表工具能力或完整项目任务验收；以下真实工具链单独验证这些能力。

## 测试证据

| 检查 | 结果与范围 |
| --- | --- |
| 领域/存储/服务 | 纯角色变换、旧字段兼容、AES 加密与重启、错误主密钥/密文元数据、URL/路径/符号链接拒绝、任务首次绑定、竞争 goal、disabled/custom 批量、并发 CAS、单独覆盖、reset 保留历史引用、Origin 与 Next Host 兼容 |
| HTTP 协议 | `packages/runtime/executor/test/compatible-model.test.ts`：2/2；真实官方 HTTP/SSE adapter，正确模型与 Authorization、拒绝 307 跳转、并发密钥隔离、显式无鉴权、AUTH 不重试、公开错误及嵌套 cause 脱敏、无关 fetch 不变 |
| 10.3 独立组合 | `tests/integration/phase10/phase10-model-settings.test.ts`：1/1；外部 HTTP 回复脚本化，其余为真实 Harness/MCP/Docker/Git/State/lease/JSONL/Fork。CODER/TESTER 使用不同连接和模型，真实写文件、Docker 执行与 Git 提交；设置变更后新任务用新配置，旧任务 child 用旧模型；3 个官方 session 可读，错误模型拒绝恢复，压缩 JSONL/State/Trace 无测试密钥 |
| 最小 live G5 | `pnpm exec vitest run --config vitest.eval.config.ts tests/evals/phase10/model-connection.eval.ts`：1/1，4.10s 测试耗时。现有开发 DeepSeek 凭据经新加密配置及**生产 Web composition**，模型 `deepseek-v4-flash` / `https://api.deepseek.com`；真实 `fs_write` 产生精确 `compatible-ok` 文件，`sandbox_run` 工具成功、Docker 独立 worktree、官方 Trace 和 task binding。该显式探针不进入默认测试，不作为 Benchmark |
| 原生 helper | `pnpm build:sandbox-native` 通过 |
| 静态检查 | `pnpm typecheck`、`pnpm lint` 通过；无错误/违规 |
| 生产构建 | `pnpm --filter @agora/web build` 通过；包含动态 `/api/model-settings` 路由 |
| 全量回归 | `pnpm run test --maxWorkers=2`：129 文件 / 1051 测试全通过，0 失败 / 0 skip，189.92s，包含既有 live DeepSeek 和全部 Docker 回归。日志 `/tmp/agora103-full-test.log`。首轮新增错误文案断言不符已修正为同时断言公开错误、AUTH 与脱敏 cause，未修改生产错误契约或跳过测试 |

新增单元最初以缺少模块/能力运行失败后实现；UI 入口先红后绿。真实 G5 首次调试修正的是验收脚本的已定义 projection slice `global.summary` 和 Trace `succeeded` 枚举，不弱化工具执行/文件内容断言。官方日志默认 `.jsonl.zstd`，证据读取按真实格式解压，且显式 flush TESTER 完整回合后核对 3 个 session；不以空日志判断“无泄漏”。

## 浏览器 QA

环境：`http://127.0.0.1:3103/`，Chrome/Playwright，桌面 1440×1050、手机 390×844。Browser plugin not available；使用环境自带 Playwright 和已安装 Chrome，不增加项目依赖。测试服务采用 `/tmp/agora103-ui-data` 和进程内临时主密钥，模型服务为本机 3104 HTTP/SSE，未修改用户真实模型设置。

流程：Team 全员入口 → 输入连接/模型/密码 → 全部 6 个 Agent 保存 → 主动测试 → CODER 单独覆盖 → 刷新/单人入口仍为覆盖值 → 手机导航/弹窗 → 统一保存 → 恢复全部默认 → 关闭。

| UI 检查 | 结果 |
| --- | --- |
| 页面身份/非空 | 标题 Agora、正确 URL、完整 Team 与设置表单 |
| Framework overlay | 修正 provider 动态导入外部化后无 Next 错误覆盖层 |
| 控制台/网络 | 最终流程无 pageerror；临时项目尚未创建 lru-demo 时 `/api/tasks` 的 404 为既有未启动状态，非设置错误；设置保存/测试均 200 |
| 密钥 | 输入 type=password；保存后密码框不回填；GET/DOM/localStorage 不含测试 key；保存不增加模型调用计数 |
| 真实交互 | 6 角色统一值、仅 CODER 覆盖、刷新保留；手机保存/reset/关闭均成功 |
| 布局 | 桌面/手机截图已检查，无横向溢出，窄屏表单可滚动、底部动作可达 |

浏览器发现并修复 Next 内部 Request URL 使用 localhost、实际浏览器 Host 为 127.0.0.1 时误报同源冲突；新增服务回归验证实际 Host，并保留跨站拒绝。截图：`/tmp/agora103-desktop.png`、`/tmp/agora103-mobile.png`；临时脚本 `/tmp/agora103-ui-full.cjs`、`/tmp/agora103-ui-mobile.cjs`。未测试 Safari/Firefox 或第三方商用服务；不据本机脚本服务宣称普遍兼容。

## 规格与交付

同步蓝图 §16/§21、详细设计 §2/§3、系统架构 §9、技术选型 §4.1/§12、开发计划 §13 与 task-status 的 10.3/D2 索引。D1/D4/D12/D13/D15/D16/D17、既有冻结端口和 DEF-016 状态不变。新增依赖仅为批准的官方组件，pnpm frozen/offline 安装通过，未升级既有版本。提交与 PR 进展见最新交付记录；任务在人工合并前保持 in_progress。
