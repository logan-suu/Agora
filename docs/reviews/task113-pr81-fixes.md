# PR #81 评审修复

2026-09-14，Leader在收到评审结果后要求“进行修复”，授权同一PR修复、回归和评论收尾。复核起点为`c71df33`；任务11.3仍为in_progress，不自动合并或发布。

## 来源与修复

详细设计§12.3.3原文：

> 服务重启必须销毁旧 Web session/认证注入配置再建立新的 origin/capability，不重用旧端口作为服务身份。

> ready、停止回执、子进程退出是三个独立事实；收到 stopped 后不得再次向已关闭 IPC 发送 stop，也不能在子进程未退出时报告所有资源已回收。

| 评论 | 确认的触发与修复 | 新回归 |
| --- | --- | --- |
| 4010713455：状态目录权限 | 原实现接受已存在的0777目录；现在在创建owner之前拒绝group/other权限，不修改原目录权限 | 0777/0750/0701拒绝，目录无新增文件且权限保持；0700正常路径仍通过 |
| 4010713446：重启无效 | 原正式包调用restart后PID不变；菜单/IPC/host统一stop→exit→start，共享一次restart Promise；quit优先，旧服务未退出不得替换 | 真实服务运行中重启、并发请求复用、旧PID退出、新PID及新session、旧session拒绝请求 |
| 4010713448：凭据等待阻塞停服 | 停止信号唤醒readiness，清除65秒timer；标draining并拒绝新的凭据操作，保留owner直到已发出的操作settle | readiness不依赖timeout结束；已发出的read未完成时owner仍在；read晚到后不得create新key |
| 4010713428：信号退出清理挂死 | 两个验证器共用仅用于测试的cleanupChild；exitCode或signalCode任一非null即已退出；强制清理有界且撤销监听器 | 真实SIGTERM终止后立即完成；无响应测试子进程SIGKILL后确认实际退出 |
| 4010713468：fixture启动停止竞态 | 分开跟踪构建与启动，stop等构建确定归属后即调用service.stop，再等startup闭合；晚到ready禁止、stop回执去重 | start/stop/stop并发只产生一个stopped；服务已构造但prepare未结束时也能停服 |

## 红绿证据与边界

- 权限与两项停服测试先运行失败（3项失败），修复后通过。
- 信号清理测试首次因缺少helper失败；fixture先复现停止后probe_failed/ready及无退出，再修复。第二个fixture测试证明“等待整个startup再stop”会形成等待环，先失败后改为分离construction/startup，随后通过。
- 旧正式包在新增真实重启验证的并发操作身份断言失败，未把旧包结果当作修复通过证据。
- 新桌面专项为9文件24项，全部通过；故障测试的Next/Keychain模块替身仅用于确定性边界，不冒充G5。正式G5继续使用包内Node/Next、真实Electron和专用临时Keychain。
- 未接受机器人提出的构建命令默认参数修改：文档已明确`pnpm build:desktop <verified-download-directory> [--revision <git-commit>]`，pnpm转发调用者参数，不应写死开发机缓存目录。
- 固定提交模式的Git executable/symlink处理意见暂未改动：当前构建输入Git项全部100644，没有现存产物损坏证据；保留该评论待进一步范围确认，不宣称已解决，也不将其登记为已批准延期。
- 无新增产品依赖，无端口或D18阶段范围变化。详设§12.3.8已同步修复行为，完整工具链/升级/Intel及最低系统安装仍归11.4/11.5。

## 门禁与交付

最终命令、构建提交和评论收尾证据追加在此处及[11.3历史](../task-history/11.3.md)。历史构建数据保持，不用本次结果覆盖旧失败或旧验证范围。

### 提交前检查

- typecheck与lint通过（470文件）；桌面专项9文件24项通过。工作树包真实服务23项、主进程12项通过，两个临时Keychain均已清理；构建根为`agora113-build-om6EYW`，这里只作为提交前证据。
- 首次完整回归：Node7项通过；Vitest179文件通过、1文件失败，1307项通过、1项失败，171.08秒。失败是既有Phase9 Docker文件边界测试：期待`escapes`，却收到`secure file helper unavailable or failed`。按并发helper执行失败、构建产物异常、边界逻辑回归三个假设排查；未改任何代码、断言、timeout或helper，单独运行原文件3项全过（3.90秒）。首次失败根因仍inconclusive，保留该记录，不以单测复跑替代全量门禁。

- 最终完整复跑通过：Node7项、Vitest180文件1308项全过，132.00秒；保持opencode-go/deepseek-v4-flash，未skip、回退或改变断言/期限。首次helper错误未重现，原因仍inconclusive，不声称已修复该无关路径。typecheck/lint/diff检查及敏感文件/已配置secret扫描通过。进入功能修复提交，随后从固定提交重新构建并复验G5。
