# 12.3 本机执行部署路线与契约取舍

**[2026-09-15 后续确认]** Leader已确认原生有界清理及残余风险；本报告“未生效/待确认/强保证保持”为此前研究时点。当前以详细设计§12.2.6及蓝图D18为准，历史来源/探针不改写。

日期：2026-09-15。本轮承接Leader“请继续”，完成公开来源研究与方案细化。**下文推荐是待确认设计，不是已批准选型、实测结果或生产入口授权。** 当前生效保护仍按详细设计§12.2执行，coalition继续暂缓。

## 1. 结论

没有找到可直接替换的库，同时满足当前普通用户/ad-hoc/macOS15+、无VM部署条件，并提供已验证的任意后代完整收敛保证。继续增加PID扫描方法不会补上这个证明缺口。

建议首版优先保留原生运行体验，评审一个明确收窄生命周期承诺的方案：**访问隔离和用户源码保护继续强制；命令停止采用有界清理；对遗留/不确定资源明确隔离；对无法识别的后代不作“已经全部退出”的承诺。** 这涉及实际风险接受，不是对旧文档的措辞修正，未经Leader确认不生效。若必须保持旧完整收敛保证，则不能将该方案作为其实现；应另选并验证OS级边界，或继续关闭命令入口。

## 2. 深入现成实现后新增的事实

### Nix：身份域比父链更稳定，但需要整套特权启动协议

固定版本`6f0275142d206cfa291e8176451dc60e7e8cff93`：

- [user-lock.cc](https://github.com/NixOS/nix/blob/6f0275142d206cfa291e8176451dc60e7e8cff93/src/libstore/unix/user-lock.cc)：在专用用户池中以文件锁独占UID，拒绝把运行Nix的用户作为build user；Darwin路径的启用条件包括root。
- [unix-derivation-builder.cc](https://github.com/NixOS/nix/blob/6f0275142d206cfa291e8176451dc60e7e8cff93/src/libstore/unix/build/unix-derivation-builder.cc)：执行前设置补充组/GID/UID；停止时兼顾主进程组和构建UID，源码明确处理子进程尚未setuid的竞态；正常builder结束后仍清理残留，避免遗留进程在文件所有权移交后继续修改。
- [Darwin安装脚本](https://github.com/NixOS/nix/blob/6f0275142d206cfa291e8176451dc60e7e8cff93/scripts/install-darwin-multi-user.sh)：通过管理员操作创建隐藏构建用户、设置home/shell/group。隔离仍需[Seatbelt规则](https://github.com/NixOS/nix/blob/6f0275142d206cfa291e8176451dc60e7e8cff93/src/libstore/darwin/build/sandbox-defaults.sb)，UID不能代替文件/网络策略。

**Agora设计推论**：若采用此路线，每个独立停止域要占用独立UID lease；只能由受信服务执行降权/启动/停止，客户端不能指定任意UID、路径或任意root命令。输入应经受保护快照交给低权限用户，不能为方便而批量放宽用户项目ACL。崩溃恢复、UID复用、文件归属、后台服务、升级卸载均需新契约。Nix单个killUser函数不是“全部线程已退出且资源安全复用”的现成回执，仍需Agora实测并审查OS语义。

Apple的[SMAppService.register](https://developer.apple.com/documentation/servicemanagement/smappservice/register%28%29)可管理现代后台服务，但LaunchDaemon要经管理员批准才启动；注册机制本身不提供作业后代的完整停止证明。当前没有创建账户、安装daemon或操作任何UID进程。

### Tart / Virtualization：VM边界有价值，停止CLI退出码仍不能照搬

固定版本`9bb2af243480ca4a2c210082e630ae425bd48b31`，旧`cirruslabs/tart`地址现指向`openai/tart`：

- [Stop.swift](https://github.com/openai/tart/blob/9bb2af243480ca4a2c210082e630ae425bd48b31/Sources/tart/Commands/Stop.swift)：先通过锁查询VM宿主PID，发SIGINT并有界等待；期限后发SIGKILL。所查强制分支在发信号成功后返回，没有追加停止确认；不能用`tart stop`退出0直接签发Agora回收回执。这只是该CLI路径观察，不是否定VM隔离能力。
- [VM.swift](https://github.com/openai/tart/blob/9bb2af243480ca4a2c210082e630ae425bd48b31/Sources/tart/VM.swift)：内部调用并等待VZVirtualMachine.stop，随后停止网络。Apple的[stop完成回调](https://developer.apple.com/documentation/virtualization/vzvirtualmachine/stop%28completionhandler%3A%29)区分成功停止与错误；强制停止不给guest正常收尾机会，不能据此把未flush产物当有效结果。
- [目录共享文档](https://tart.run/quick-start/)支持只读共享；对Agora应只读共享固定输入、隔离写入输出，不可把用户项目直接可写挂载后就宣称VM保护了源码。只有VM停止及宿主共享/网络端点关闭后，才能考虑回收相关资源，异常和恢复仍须验证。
- [Package.swift](https://github.com/openai/tart/blob/9bb2af243480ca4a2c210082e630ae425bd48b31/Package.swift)标注macOS13构建基线，不等于所需功能均在最低系统验收通过；[开发entitlements](https://github.com/openai/tart/blob/9bb2af243480ca4a2c210082e630ae425bd48b31/Resources/tart-dev.entitlements)与生产配置不同，不假设完整生产网络能力在Agora当前签名下可用。
- 当前固定提交的[许可证](https://github.com/openai/tart/blob/9bb2af243480ca4a2c210082e630ae425bd48b31/LICENSE)为FSL-1.1-ALv2，不能沿用2023博客的Fair Source说明作为当前分发依据。本轮只登记许可证和来源；没有选择打包/分发Tart或作出具体授权结论。

**Agora设计推论**：macOS guest较Linux guest更接近本机工具语义，但增加镜像获取、存储/内存、guest工具链、共享文件语义和预览转发；Linux guest还改变平台目标。按worker建VM成本更大，多个worker共享VM则强停会影响整组。不能把VM当一个不影响D17并行/接管粒度的内部替换。本轮没有创建、下载或启动VM。

## 3. 路线比较与选择标准

以下成本为架构判断，不是测得的耗时、费用或性能数据。

| 路线 | 保留原生macOS工具语义 | 新增部署要求 | 完整收敛现状 | 建议 |
| --- | --- | --- | --- | --- |
| 现有Seatbelt + 有界清理 | 是 | 现有范围；仍须OS/工具链G5 | 对任意脱组后代无完整证明 | 首版优先评审，必须明确收窄承诺，不能以扫描无残留冒充强保证 |
| Nix式专用UID池 | 是，但低权限账户的环境/文件访问不同 | 管理员服务、专用用户、窄权限协议与升级卸载 | 身份域更明确；Agora未验证停止/复用闭合 | 不建议只为首版清理而加入root信任面 |
| macOS VM | guest macOS，不是宿主同目录原生执行 | 镜像/guest工具链/虚拟化签名与资源管理；具体许可另核验 | 有明确VM停止API；完整宿主资源回收仍待验证 | 若完整生命周期边界不可让步，优先做独立架构选型；不是当前任务的隐式回退 |
| Linux VM / Apple container | 否 | Linux环境/镜像及文件、网络桥接 | 可组合VM与cgroup；当前未实测 | 不宜作为当前本机macOS承诺的透明替代 |
| macOS27 descendants ES | 是 | 提高最低系统、申请ES entitlement及签名接入 | 当前机器无接口；事件完整性/恢复未验 | 后续候选，不阻塞首版等待未来条件 |
| coalition私有SPI | 是 | 私有接口兼容与行为验证 | 历史探针不足 | 按现有决定继续暂缓 |

## 4. 原生首版草案：可以审阅的具体变化

### 4.1 保持的强制保护

- Seatbelt约束脚本及后代；源码、Git元数据、Agora状态/凭据不可写或不可访问的边界不放松。禁止裸跑、LocalTemp和Docker回退。
- 脚本只对每次执行新建的专用输出/home/tmp/cache范围写入；生成代码以候选diff经受信文件事务应用，不能直接写用户源码。
- 仍核验根/版本/授权，测试固定输入；真实错误不吞掉，不让模型或项目脚本伪造清理证据。
- 所有停止只针对本次已登记身份；不按同名程序/用户全杀，也不触碰用户服务。

### 4.2 建议改变的生命周期承诺（未生效）

建议将§12.2.6中的“命令停止已证明全部后代退出”与“控制器完成有界清理”区分为两个结果：

1. 主进程结果、输出收集状态、有界清理结果、未确认资源分别记录。输出期限到了可以停止等待，但标记截断，不伪造EOF或进程退出。
2. 超时/取消时关闭新准入，对已登记进程组及可发现后代先正常终止、再强制终止、核验出生身份。期限和结果持久化；具体数值在实现计划中定稿，不无限轮询。
3. 发现残留、身份不明、停止失败、登记或策略失效时，维持needsAttention。其输出范围、端口、UID/进程身份记录不得删除或重用；不能以路径改名或更新registry撤销已打开fd。被影响的资源不能签发安全接管/可信产物回执。
4. 未观察到残留且检查完整时，只能声明“有界清理检查完成”，**不保证任意恶意或快速脱组后代已经全部退出**。若允许释放执行额度或继续工作，必须接受漏检进程仍占CPU/内存、可能继续写其原授权私有输出的风险。该点是旧契约实质变化，不能借“沙箱仍在”省略。
5. 未确认停用的输出永不作为新命令可写目录或可信产物输入。独立工作使用全新资源身份，但这不能自动解决残留进程的宿主资源占用；清理失败不能静默归档为成功。哪些失败阻断同项目/全实例、容量如何保守记账，须与12.3/13.2恢复协议一并定稿。
6. 已证明无关联写能力的独立源码范围与未停用输出分别呈现；不能用源码只读反推命令已停止。正常工具结果能否形成可信验证、接管范围及已关闭能力证明，需按具体工具/能力覆盖检查，不作通用自动豁免。

这比简单“采用竞品相同kill算法”多了资源隔离与可见失败，但仍然降低了任意后代完整退出的承诺，不能宣传为等价实现。源码路径/硬链接/预览端口/代理授权必须先实测，源文件隔离未证明时也不能进入该模式。

### 4.3 获批后的分步实施与验收草案

1. 先同步蓝图D18、详细设计§12.2.6/§12.2.7与L14、架构、选型、计划、索引和涉及的红线。清理结果及资源状态只增加内部companion契约，既有冻结方法不变；不在源码开隐式开关绕过现有保护。
2. 一个小单元验证执行私有输出与源码隔离：固定Seatbelt后代、链接/别名攻击、旧fd及跨命令目录访问；模拟凭据/用户哨兵保持不变。失败停止依赖实现。
3. 第二单元实现有界停止、出生身份核验、输出截断、资源隔离记录和显式失败。使用真实临时目录/真实子进程，保留已知逃逸反例；不得把反例断言直接翻成“全部退出”。
4. 验证恢复和容量：控制器崩溃、坏日志、PID复用、同ID重放、残留预览端口、后台持续写/快速fork、收敛未完成。未通过不能接registry/MCP/桌面入口。
5. 所有适用L01–L18和G1–G7仍执行；新的实测分清“访问隔离通过”“停止检查完成”“仍无完整后代证明”。原191文件/1362测试只归属此前代码，不替代新门禁。

本轮仅形成草案，没有修改正式收敛承诺或测试断言，也未开始上述实现。

## 5. 证据与当前状态

固定源码来源与hash见[部署来源清单](task123-command-evidence/deployment-source-manifest.json)，Apple官方DocC元数据见[API来源](task123-command-evidence/apple-deployment-api-review.json)；更广对照及15套历史诊断见[前轮报告](task123-agent-supervision-comparison.md)。Tart路径发现中的Makefile 404保留，成功源码hash另行记录，不把读取失败当功能结论。

研究未运行外部代码、付费模型或Benchmark，无新fixture/安装/镜像/服务/用户账户；无需清理新增运行产物。现有全部证据hash保留，任务12.3保持in_progress，生产launcher门禁仍未通过。下一步应对上述具体契约或另一明确OS级路线作架构选择，不继续以重复PID探针消耗时间。
