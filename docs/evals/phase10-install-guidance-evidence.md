# macOS 首次安装引导与依赖诊断修复

日期：2026-09-12。Leader要求补齐空白Mac安装引导与缺失依赖提示；这是既有10.4/README的后续修复，10.7出口测试尚未开始。

## 问题与改动

原Quick Start只列前置软件，缺少从没有开发环境开始的安装步骤。原诊断在Node版本错误时提前结束，其他依赖失败只列命令名，pnpm版本错误可能被其他失败遮挡；Docker CLI缺失与引擎不可达共用模糊提示。

新增英文[首次安装指南](../install-macos.md)，README提供入口与工具检查命令。指南链接官方Apple/Node/pnpm/npm/Docker说明，覆盖工具安装、固定版本、权限/PATH、Docker首启、下载源码、安装包/构建、首次模型配置和后续启动。

`apps/web/scripts/local-diagnostics.mjs`复用既有受信`runTool`：汇总系统问题，Docker先探测CLI再探测引擎，只输出静态修复提示与指南路径，不转发原始命令错误。`setup/doctor/start`沿用同一诊断接缝；缺少Next/TypeScript依赖提示先安装锁定包，构建产物缺失或不安全仍拒绝并给出构建步骤。Node直接启动doctor可绕过未安装pnpm的入口困难；Node本身缺失仍需按指南安装。

未安装或启动系统软件、未变更模型配置/钥匙串身份、未改变隔离或生命周期语义、未增加依赖。文档同步蓝图D8、详细设计§3、架构§9、开发计划10.4及任务notes。

## 验证

| 检查 | 结果与边界 |
| --- | --- |
| TDD | 先新增5项诊断测试，缺实现时失败；实现后5/5通过。以注明原因的命令结果替身覆盖多个依赖同时缺失、Node/pnpm错误版本、Docker CLI与engine区分、正常只读探测、非macOS拒绝；替身不作为G5证据 |
| 静态检查 | `pnpm typecheck`与`pnpm lint`通过 |
| 完整回归 | `pnpm test`：167文件、1257项通过，0skip，126.81秒；保留已配置`DEEPSEEK_API_KEY`并运行既有真实模型、Docker、临时钥匙串与跨阶段测试；未启用本轮费用计量器，不声明新增费用数字 |
| 正式入口成功 | 实际执行`node apps/web/scripts/local.mjs doctor`及`pnpm run doctor`，退出0；使用已配置开发Mac，非空白机器安装 |
| 缺工具实测 | 仅为诊断子进程设不可用PATH，绝对路径Node执行真实启动器，实际pnpm/Git/Docker探测失败；逐项给出修复动作，退出1；未卸载宿主工具 |
| 引擎不可达实测 | 保留真实Docker CLI，仅在子进程指向临时不存在的socket和独立Docker配置目录；CLI成功、engine失败，输出引擎专用指引，退出1；未停止宿主Docker |
| 未安装包实测 | 将生产启动脚本及两个依赖脚本复制到临时checkout，不复制node_modules；真实系统工具正常，提示`pnpm install --frozen-lockfile`与setup，退出1，随后删除临时目录 |
| 文档链接 | README和安装指南43条本地链接及章节锚点存在；外部安装指引核对官方来源，未执行其中系统安装命令 |
| G7 | Gitleaks扫描本次所有修改及新增文本文件，零发现；未提交秘密或环境文件 |

没有全新Mac或全新macOS用户环境的完整安装实测；没有将开发机已有工具和钥匙串复用包装为首次安装验收。新指南降低操作门槛，Docker与其他必需依赖仍由用户安装。本轮不重新录制、不重跑冻结Benchmark，也不宣称Phase10出口通过。

## 本地日志身份

日志目录为gitignored的`.data/verification/install-guidance/`；以下SHA-256绑定本次结果，不含用户凭据。

| 日志 | SHA-256 |
| --- | --- |
| regression.log | `2c787ae1589e323451d54680a7d1da60647a732ca2a3cf702e239c33fd5bdc06` |
| doctor-ready.log | `52bd60b43dc6531d18bdd0e370c07f4f915daabd02ff636a969f280eea832868` |
| doctor-missing-tools.log | `979a4c781b220c5dff67a9ff56df1213ec49dcb5d43c760b9e4807abc2c7aa38` |
| doctor-engine-unreachable.log | `66ac40114a8d7f22750d82073bc6f6b2ae69c799feeb50a560c8b50f0023e8c7` |
| doctor-missing-packages.log | `656dff0dce822e96dea8a532e472005d9fdb6870d3cc34830c1eff017433d4eb` |
