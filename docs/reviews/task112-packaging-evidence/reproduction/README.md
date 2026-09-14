# 11.2 打包 Spike 的复现材料

本目录交付原来仅存在于本机 `.data/spikes/task112-20260914/` 的四个脚本和两份日志。原始 main.cjs/desktop-spike.mjs 保存在 historical/，其余原始文件仍在本目录，六份原始字节/hash保持。当前 main.cjs/desktop-spike.mjs 已修复启动中断清理，并新增 stop-child.cjs；它们仍是实验入口，不是 11.3 的生产实现。

| 文件 | 作用 |
| --- | --- |
| `prepare.cjs` | 读取 Next trace、复制资源/工具链、编译两架构 helper；历史工作目录固定为 `/private/tmp/agora-112-spike` |
| `close-dependencies.cjs` | 补齐 custom server 的五个入口依赖及包内相对链接 |
| `main.cjs` / `stop-child.cjs` | 保留16项真实断言；停止期限后回收自己创建的隔离进程组，并将强制退出明确记为失败 |
| `desktop-spike.mjs` | 协调启动与停止，停止请求后不再创建HTTP服务/报告ready，只关闭已初始化资源；验证外壳拒绝所有产品写请求 |
| `historical/main.cjs` / `historical/desktop-spike.mjs` | 原始运行验证脚本，保留历史hash；当前复现不执行此旧版本 |
| `test/startup-stop.test.cjs` | 真实子进程生命周期单元回归；可控Next/Keychain fixture用于挂住启动，不替代真实应用包G5 |
| `build.log` | 首次干净源码生产构建日志 |
| `attempt3-sample.txt` | 第三次失败尝试的完整 macOS 采样；只作故障诊断，不计入通过证据 |
| `reproduce.mjs` | 从本仓库材料及固定源码提交重建，不读取旧 `.data`、旧 `.app` 或开发者 `node_modules` |

## 先验证证据

在仓库根执行：

```sh
node docs/reviews/task112-packaging-evidence/reproduction/reproduce.mjs --verify-only
```

它检查 manifest 中每一份材料都位于本证据目录且 hash 匹配；缺文件、越界路径、旧 `localFile` 条目或 hash 不符立即失败。此模式不下载、不编译、不启动服务，也不需要 macOS。

## 从干净源码重新构建和运行

构建机要求：Apple Silicon Mac、Node 24、Git、Xcode Command Line Tools（clang/SDK/codesign/PlistBuddy）、网络和可用的 macOS 桌面/Keychain。需要数 GB 临时磁盘空间；这属于开发者复现实验，不能视为最终用户免预装安装验收。原实验主机为 macOS 26.5；本入口不宣称已验证 Intel 或最低产品系统。

```sh
node docs/reviews/task112-packaging-evidence/reproduction/reproduce.mjs
```

流程：

1. 校验仓库内证据；用 `mkdtemp` 创建全新的私有临时根，保留输出供审查，不覆盖旧实验或用户项目。
2. 获取固定 Electron/Node/Git/pnpm 上游压缩包，按 [downloads.json](../downloads.json) 校验 hash 后解包。精确下载地址在入口脚本中；未下载或执行 Packager，版本元数据沿用 [stage.json](../stage.json)。
3. 从 manifest 的固定提交 `58ef611e91ed27e7d05aebbcd9024190f50d99f3` 执行 `git archive`；使用下载的 Node/pnpm 执行 `pnpm install --frozen-lockfile`、两个原生 helper 构建和 Next 生产构建。没有复制当前工作树、`.env`、`.data`、旧构建或已安装依赖目录。
4. 在新临时根生成两个历史构建脚本的工作副本：只替换它们各自的一处固定临时根，并将 `prepare.cjs` 的 `git rev-parse HEAD` 记录替换为实际归档提交。原始脚本不改写；两份执行副本保留在临时根供比较。当前`main.cjs`、`stop-child.cjs`和`desktop-spike.mjs`装入包，保留原16项断言；启动/停止保护以当前版本为准，历史字节另存historical/。
5. 修正历史 Electron bundle 名称，审计资源中的外部链接/禁入路径，完成 ad-hoc 签名及完整性检查；运行 `.app`，验证结果与历史检查名逐项一致，并确认临时 Keychain 已删除。

若已有四份上游压缩包，可显式指定只读下载缓存。目录必须包含 `electron.zip`、`node.tar.gz`、`git.tar.gz`、`pnpm.tgz`；仍逐份校验 hash，坏缓存直接失败，不静默替换。缓存只省略压缩包下载，后续仍从干净源码安装与构建：

```sh
node docs/reviews/task112-packaging-evidence/reproduction/reproduce.mjs --download-cache /absolute/path/to/downloads
```

输出目录会打印到终端，其中包含 `reproduction-result.json`、`stage-result.json`、依赖闭包、完整构建日志及 `probe-run-*/` 的结果与截图。失败时保留目录且返回非零，不伪造成功。**失败的原始 Keychain 命令诊断可能含本次临时口令；原始新日志仅供本机排障，发布前必须筛选，不能直接上传整棵输出目录。** 已归档的历史日志经过凭据检查。

启动/构建子进程使用允许项环境，供应商 API Key 不传入；本 Spike 不发送模型请求。运行期间只创建自己的临时 Keychain 和 Git 仓库。若环境阻止 Keychain 或桌面启动，使用有相应权限的正常终端执行；不得跳过断言、关闭 Gatekeeper 或修改既有凭据。

## 验收范围

复现的是 11.2 的最小应用包：独立 Node/Next 服务、真实 Git/helper/Keychain、认证/来源拒绝、React 渲染和空闲停服。它不覆盖正式 Packager、生产 fuses/CSP、重复启动竞争、Intel/最低系统/干净安装、公证或升级事务。正式产品验收继续按详细设计 §12.3 和 11.3–11.5 执行。


## 启动中断与证据范围回归

```sh
node --test docs/reviews/task112-packaging-evidence/reproduction/test/startup-stop.test.cjs
```

测试分别在prepare和credentials阶段阻塞真实Node子进程，先发送停止再放行，确认不出现迟到ready、重复stopped或未初始化HTTP关闭异常；另验证无响应的独立进程组在期限后被终止且PID不存在。Next/Keychain fixture只用于这些确定性单元测试，另行重建运行真实Next/Keychain应用包完成G5。强制退出仅限本Spike的非模型子进程，永不视为正常停服或产品安全点。

每次reproduction-result在构建前冻结输入manifest的SHA-256和全部file/hash，evidenceFilesVerified只计这份输入快照；运行后生成的结果及后来追加的材料不能追溯计入。原16项输入结果保存在[historical-reproduction-result.json](../historical-reproduction-result.json)，原来后补的3项及原因见[historical-reproduction-scope.json](../historical-reproduction-scope.json)。`--verify-only`检查当前完整清单，其数量可大于历史运行输入快照，不将旧16伪改为19。
