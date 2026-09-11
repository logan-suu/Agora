# 10.5 候选基准与执行接缝预检

> 时点说明：本文件保留Explore/Plan阶段的审查记录。Leader随后回复“确认”，当前10.5已进入in_progress；实施与实测进度见docs/evals/phase10-preflight-evidence.md，正式结果以后续冻结manifest为准。

日期：2026-09-09。阶段：Explore/Plan。所有候选及预算为待确认实施建议，未开始 Code 或模型实验。

## 环境实读

| 项目 | 本次结果 |
| --- | --- |
| 主机架构/内存 | macOS arm64 / 17179869184 bytes（16 GiB） |
| Node / pnpm | v24.20.0 / 9.15.9 |
| Docker | 29.2.1，Linux aarch64，8 CPU，8217341952 bytes内存 |
| 工作区所在卷剩余磁盘 | 约89 GiB，随系统使用变化 |
| 已有相关镜像 | node:20-slim，约222 MB；未拉取新镜像 |

最初沙箱内Docker/socket与sysctl读取被权限拒绝；随后经只读提权取得上表结果。未重配Docker、停止现有容器、读取密钥或清理用户数据。这里只证明工具/资源可读，不证明候选依赖能安装或验证器能运行。

## 候选比较与推荐

| 候选 | 本次证据 | 判断 |
| --- | --- | --- |
| SWE-bench Verified | 官方资料说明Docker实例环境和补丁验证；本轮未下载任务或试建镜像 | 保留为后续仓库级评测候选。本轮不因完整套件资源建议直接判定单题不可行，但其Python仓库/环境适配尚未验证，不作为首个实现。 |
| Terminal-Bench 2 | 锁定`2fd12b88aafdd04a52c298e3940bcb189f9766d6`；读了log-summary-date-ranges、multi-source-data-merger、regex-log题面与部分环境 | 题面绑定/app或/data，部分需要Parquet/Python；regex-log verifier现场安装uv/Python/pytest并要求网络。与默认离线、规范worktree及Node/TAP链之间需要更多适配，不作为本轮推荐。未执行参考解或判定器。 |
| Aider Polyglot JavaScript | 固定源`7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`，四题均为MIT、Jest测试、相对代码路径 | 推荐本轮先接通该生态的小型子集；复用任务、原测试和测试启用语义，仅使用Agora/Harness执行，不安装/接入Aider编码Agent。必须公开Node/Jest环境、迭代与上下文协议差异，不与完整Aider排行榜直接比较。 |

推荐题目如下。数量来自源码声明计数，不是本轮运行的测试通过数。

| task ID（javascript/exercises/practice下） | 主要行为 | test/xtest声明 | 当前默认xtest |
| --- | --- | --- | --- |
| grade-school | 可变名册、年级分组、排序和返回值隔离 | 10 | 9 |
| wordy | 文字算式解析、运算顺序及非法输入 | 23 | 22 |
| book-store | 优惠组合与最小价格计算 | 17 | 16 |
| forth | 栈操作、整数运算、自定义词与错误语义 | 49 | 48 |

四题package.json均声明`jest ^29.7.0`，`npm test`为`jest ./*`。Aider执行辅助脚本锁定于`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`的`benchmark/npm-test.sh`：链接预安装依赖、把`xtest(`改为`test(`后执行npm test。因此不能原样只跑默认启用的一题就判通过。计划在隔离verifier副本中执行同样启用处理，保留原文件hash与变换后hash，要求运行总数与冻结发现清单一致且0 skip；不修改上游断言。不得把该激活步骤误称为弱化测试。

公开候选package/LICENSE/test/stub的Git blob及SHA-256已只读计算，元数据留`.data/plans/task105-public-candidates.json`；尚未下载题目全集、参考答案或安装依赖。正式清单还要加入所有指令附件、Babel配置、解析后的完整依赖锁及镜像digest，当前清单不是最终运行manifest。

## 现有接缝与实现取舍

- `tests/evals/core/{contracts,runner}.ts`可复用schema、fingerprint、隔离root、结果生命周期。组清单/预算/统计在Phase10增加，不改产品State或冻结端口。
- `apps/web/src/server/task-composition.ts`支持sandbox镜像、注入LLM adapter、scheduler；组合工厂输入带`buildChannelContext`，可以由Eval包装同一生产工厂，仅改变已经授权返回的ChannelContext内容保留，不新增产品投影开关。
- `MessageRuntime`支持独立dataRoot/roster；在每个run初始化冻结带明确model的RoleSpec，Fork前后复核同一映射。Metered adapter必须按实际请求model转发，不能沿用Phase9强制Flash的实现冒充角色路由。
- `WorktreeGitService`支持明确canonical repo路径；Eval先在其隔离taskRoot准备只含题面/原始源文件/必要公开配置的seed repository，再由生产工厂接管真实Git worktree。
- 公开题继续走Node用户代码与现有可信Node/TAP的产品验收；官方Jest验收在最终产物的独立新容器执行，恢复可信上游配置和测试并只复制允许的解题代码，输出精确测试数/失败数/hash。两种验收分别记账，不把Jest结果伪装成生产wave receipt。
- 单Agent driver复用HarnessExecutor、真实MCP/沙箱与JSONL，接受任务投影和工具反馈；不自研token loop，不伪造角色/Leader/D16事实。多角色仍走真实生产HTTP/State/编排/评审/终审/Fork/归档。
- 所选JavaScript题无需立刻将生产WaveValidationService扩成任意语言测试器；若真实安装/验证发现不可行，先记录阻塞并修订计划，不能改断言或偷换官方Outcome。

## 仍需实测

Node20 + 固定Jest/Babel依赖的安装和正反验证器运行；reference proof的可用性；public fixture seed/归档代码移交；同一生产链各role实际模型请求及Fork保持；内部场景真实触达上下文差异、D4和并行。上述动作在实施计划批准后进行；公开任务或任何代码都不在宿主执行，构建阶段无模型/API凭据。

## 官方来源

- [SWE-bench Quickstart](https://www.swebench.com/SWE-bench/guides/quickstart/)
- [Terminal-Bench 2固定源](https://github.com/harbor-framework/terminal-bench-2/tree/2fd12b88aafdd04a52c298e3940bcb189f9766d6)
- [Aider Polyglot固定源](https://github.com/Aider-AI/polyglot-benchmark/tree/7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f)
- [Aider JavaScript测试脚本](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/benchmark/npm-test.sh)
- [DeepSeek官方计价](https://api-docs.deepseek.com/quick_start/pricing/)：2026-09-09读取HTML，Flash-0731/Pro-0813；Flash峰值输入/缓存命中/输出每百万token为USD0.44/0.014/1.32，Pro为1.32/0.044/3.96，非峰值减半。实际运行前复核来源并冻结；网页model id为可变别名，不能保证权重不变。
