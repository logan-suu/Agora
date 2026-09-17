# 12.3 根检查、初始化与新建文件事务

日期：2026-09-16。沿用已批准的Task12.3固定临时目录与回归授权。本记录是中间实现单元，尚未开放普通用户项目入口。

## 实现与边界

- 只读根检查helper从无链接目录fd链读取真实APFS卷UUID，校验本地文件系统和身份；不创建暂存目录或授权。UUID查询的XNU实现还检查卷根，因此仅为此受信helper增加mount-relative-literal("/")的metadata权限，未加入项目命令策略。拒绝已知CloudStorage/Mobile Documents和dataless对象，不声称覆盖所有同步软件。
- 初始化先在外部受管journal写prepared，再由独立Seatbelt helper排他创建.agora-operations(0700)。同名既有项拒绝接管。创建前/后、完成确认后检查根及暂存身份；失效保留created事实，不删除目录掩盖副作用。缺结果回执不重复执行。
- 新建文件读取absent基线并绑定现存父目录身份，关闭候选写fd后以RENAME_EXCL及NOFOLLOW/RESOLVE_BENEATH发布。并发既有文件/链接报冲突，独立local-creation-primitive-v1回执只用created字段；替换保留原schema与exchanged字段。默认0644，不隐式创建父目录。
- 这些仍是内部原语。root初始化的授权回调须来自后续正式selection/proposal/registry控制事务；纯检查、prepared或返回目录身份都不是worker活能力。尚未完成根初始化与registry持久授权、版本化文件/命令端口、正式companion和产品G5接合。

## 红绿证据

1. 根检查初测EPERM，按Seatbelt策略、API前置条件和结构布局三假设定位；本机SDK/man与Apple XNU源码证明卷属性需mountroot权限。只读metadata修正后通过；真实探针确认源码内容/外部内容读取、源码写入和fork均拒绝。证据：task123-root-evidence。
2. 新建文件先因接口未实现而6项红；实现后6项及原17项替换测试通过。扩展符号链接/既有目标/坏回执后11项通过；原17项原断言保持。证据：task123-creation-evidence。
3. 初始化缺模块红；首轮7项真实测试通过。扩展完成阶段竞态时3项新测试把已创建目录错误断言为不存在，按created实际副作用修正场景表，未放宽结果或身份断言。负向probe编译发现改名main后缺终止函数标记，添加C11_Noreturn，保留-Werror。最终11项通过，包含拒绝外部读写和fork。证据：task123-root-init-evidence。
4. typecheck初次发现新增spawn环境未设置项目ProcessEnv要求的NODE_ENV，补固定production值后通过；lint534文件及native构建通过。完整回归随后运行，不沿用历史G4。

所有真实测试在/private/tmp/agora-task123-validation-*固定虚构fixture中完成；每项保存helper与源码hash、结果和必要journal，核对进程/句柄/挂载/目录身份后删除测试副本并记录空间变化。仅在当前macOS26.5真实运行；编译最低15.0参数不等于macOS15实机验收。

依据：Apple [XNU vfs_attrlist.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_attrlist.c)中卷属性替换为mountroot并调用mac_mount_check_getattr；本机SDK sys/attr.h及getattrlist手册。外部来源用于解释机制，不代替实际边界测试。


## 受管Node诊断（不改本轮冻结源码）

复用11.4 catalog固定的Node24.20.0 darwin-arm64 URL与SHA-256，下载核验后在独立固定fixture中由现有暂停启动/绑定/监督器执行。Node读取获准source、私有output写入成功；写source和读模拟凭据根均EPERM/EACCES，payload exit0，launchDurable/durable=true，bindingFailure=null，登记bootstrap/Node均退出。该固定脚本不创建后代，不能由此声称任意项目后代完整收敛或正式cleanup checked；registry/grant仍为明确虚构的内部接缝，不能替代正式端口G5。初始化ready288.0ms、bootstrap身份查询1.75ms、执行514.8ms、收尾6.45ms。

5903个目录/文件/链接条目保存manifest/hash；命令journal、载荷、策略、来源和OS留证后确认无句柄/OS或Docker挂载，删除专用下载/解压/helpers/controller/fixture。可用空间观察+263716864字节，不作独占回收量保证。证据目录：`task123-managed-node-evidence`。初次pnpm exec esbuild未暴露转移依赖二进制，使用已安装且实际Vitest采用的固定esbuild路径，不安装新依赖。


## 完整回归

535份源码冻结后原始`pnpm test`退出0：7项脚本测试、207个Vitest文件/1576项测试全部通过、0skip，用时749.70秒。LRU232.369秒、真实Harness19.171秒均为指定Go deepseek-v4-flash；固定群聊同提供方/模型见原日志。冻结源码hash复核全数保持，本轮新建/根检查/初始化及之前状态规则都进入完整回归。没有改变模型、提供方、测试期限、原保护断言或执行正式Benchmark。本检查点G4通过，整体12.3端口接合与产品G5仍未完成。
