# D19 LangGraph方案定稿与正式任务登记审阅

日期：2026-09-17。Leader要求“先完成2和3，完成后一起到这个PR中再合并”：冻结方案§28–29并同步正式来源/任务，更新[PR #87](https://github.com/logan-suu/Agora/pull/87)，合并由人类执行。本记录不标记任何新增实现任务完成。

## 定稿及审阅修正

- 蓝图§21新增D19：LangGraph编排完整Harness，Agora保留业务规则/投影/安全点/lease/Leader裁决。TaskState业务回执、官方JSONL及SQLite分权；重启只读，用户显式Continue，旧动作不能授权新进程。
- 完整§28契约移入详细设计§13作为唯一落码来源；独立方案v1.0保留解释与证据并引用正式schema。统一kind，移除早期stage/effectRefs概念字段；AgentInvocation增加runAuthorizationId，当前runner能力不能序列化，checkpointNamespace首版固定空字符串。
- 补齐user_start/user_continue/gate_resolution的授权来源、跨进程prepared接管和无资源证明的needs_attention分类；明确ASCII字段名、128字节新标识与引用边界。32份/512KiB预留必须在14.2证明最坏收尾；128个batch上限仍受实际容量准入限制，不提前声称阈值实测通过。
- 解决验收循环：原“LG01先完整实测所有生产S04–S08才能写任何实现”不可执行。14.1复验框架和基础ABI，正式schema/执行/控制/UI/打包分别由14.2–14.6验收，14.7累计全S/C/V；未降低真实依赖要求。14.3在未接D4/D16桥接前遇gate停止保全，14.5负责完整终审与恢复。
- 旧原生任务只读与D18 Docker退役不冲突：只读范围是Phase13原生引擎任务，不恢复旧Docker产品任务兼容。13.2宿主主动恢复、Phase14任务图恢复和20.2/20.3多会话整队恢复分别验收，不靠旧PID消失或图checkpoint推断资源安全。
- 官方文档复核仅支持框架语义：[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)、[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)。节点重入、pending writes和版本差异仍以固定发行包实验为准，不据移动网页引入新API，也不将框架持久性等同于业务事务。

## 来源与编号

同步顺序为蓝图D19→详设§13及§1/3/4/5/6/8入口→架构§11/选型§5.2/10.2/12→计划§18.13/18.14与索引→AGENTS。框架调研加日期适用注，任务维护规范更新阶段总数；DEF-016仅追加新任务归属，未关闭。

新增Phase14「LangGraph持久编排迁移」共7任务，对应原LG01–LG07，均pending且显式依赖13.4。原94项未开工任务一对一顺延至Phase15–31，原依赖边保留；新Phase15每项额外依赖14.7。Phase0–13条目、69项done与历史身份不重编号，current_phase保持12；总178任务、32阶段。历史PR #77旧ID列保持原意，当前列串联新映射；文档章节号不随任务号改变。

现阶段完成的是设计定稿/登记，不是14.1的实现基线与机制验收。正式test_file明确为未来入口，不创建空测试，不调用agora-do-task越过13.4。所有S01–S08/C01–C12/V01–V32主责见[开发计划§18.13](../开发计划安排.md#langgraph-phase14)。

## 验证与证据范围

机器核验及最终检查结果见[登记验证](langgraph-registration-20260917.json)。检查178任务依赖无环、出口全依赖/前阶段约束、94项映射与原依赖保存、旧状态/历史保护、正式计划与索引对应、契约链接/围栏、固定来源hash、常见凭据模式和新增材料用途。

D9产品六份代码/测试hash保持前轮最终版本；57项定向及7脚本/227文件1768项真实回归、typecheck/lint/原生构建记录见[既有验证](d9-replay-fix-20260917/validation.json)。本次新增变更为规格/索引和既有实验归档，未修改产品代码、实验源码或产品依赖，不把旧测试记为本轮重跑。重新执行索引脚本测试、typecheck和lint；没有重复计费模型实验或Benchmark。CodeRabbit的0issues仅覆盖此前6份D9代码/测试及当时AGENTS配置，不覆盖新增D19设计。

保留四组独立实验的唯一源码、固定依赖、结果、失败与hash，用于审阅和复现；它们不是产品运行时或新阶段已验收声明。第一/二轮两个依赖文件字节相同，第二轮改引用首轮规范副本；原hash清单按发生时点保留，复现时从共享副本复制，不修改实验源码/断言。失败log仅规范化一个结尾空行，失败内容不变，原字节可还原，前后hash见验证JSON。最小DMG、fixture与测试下载此前已清理；本次不下载依赖或构建安装副本。

清理记录包含重复依赖配置及本轮专用转换脚本/中间索引/日志；保留必要失败、来源/版本/hash和结果，详见登记验证cleanup。不会删除用户项目、正常依赖、共享缓存、安装应用或产品状态。PR正文按包含D9修复、D19设计和实验边界的最终范围重写；本轮无自动合并或发布。
