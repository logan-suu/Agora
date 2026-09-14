# 11.2 打包 Spike 的复现材料

本目录交付原来仅存在于本机 `.data/spikes/task112-20260914/` 的四个脚本和两份日志，字节内容与原 manifest 的 SHA-256 完全相同。它们是历史实验材料，不是正式桌面启动器；不得直接作为 11.3 的生产实现。

| 文件 | 作用 |
| --- | --- |
| `prepare.cjs` | 读取 Next trace、复制资源/工具链、编译两架构 helper；历史工作目录固定为 `/private/tmp/agora-112-spike` |
| `close-dependencies.cjs` | 补齐 custom server 的五个入口依赖及包内相对链接 |
| `main.cjs` | 16 项真实验证断言、临时 Keychain、受管 Node/Git/helper、UI 与停服检查 |
| `desktop-spike.mjs` | 在独立 Node 中启动已有 Next/凭据服务；验证外壳拒绝所有产品写请求 |
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
4. 在新临时根生成两个历史构建脚本的工作副本：只替换它们各自的一处固定临时根，并将 `prepare.cjs` 的 `git rev-parse HEAD` 记录替换为实际归档提交。原始脚本不改写；两份执行副本保留在临时根供比较。`main.cjs` 和 `desktop-spike.mjs` 按原字节装入包，16 项断言不改变。
5. 修正历史 Electron bundle 名称，审计资源中的外部链接/禁入路径，完成 ad-hoc 签名及完整性检查；运行 `.app`，验证结果与历史检查名逐项一致，并确认临时 Keychain 已删除。

若已有四份上游压缩包，可显式指定只读下载缓存。目录必须包含 `electron.zip`、`node.tar.gz`、`git.tar.gz`、`pnpm.tgz`；仍逐份校验 hash，坏缓存直接失败，不静默替换。缓存只省略压缩包下载，后续仍从干净源码安装与构建：

```sh
node docs/reviews/task112-packaging-evidence/reproduction/reproduce.mjs --download-cache /absolute/path/to/downloads
```

输出目录会打印到终端，其中包含 `reproduction-result.json`、`stage-result.json`、依赖闭包、完整构建日志及 `probe-run-*/` 的结果与截图。失败时保留目录且返回非零，不伪造成功。**失败的原始 Keychain 命令诊断可能含本次临时口令；原始新日志仅供本机排障，发布前必须筛选，不能直接上传整棵输出目录。** 已归档的历史日志经过凭据检查。

启动/构建子进程使用允许项环境，供应商 API Key 不传入；本 Spike 不发送模型请求。运行期间只创建自己的临时 Keychain 和 Git 仓库。若环境阻止 Keychain 或桌面启动，使用有相应权限的正常终端执行；不得跳过断言、关闭 Gatekeeper 或修改既有凭据。

## 验收范围

复现的是 11.2 的最小应用包：独立 Node/Next 服务、真实 Git/helper/Keychain、认证/来源拒绝、React 渲染和空闲停服。它不覆盖正式 Packager、生产 fuses/CSP、重复启动竞争、Intel/最低系统/干净安装、公证或升级事务。正式产品验收继续按详细设计 §12.3 和 11.3–11.5 执行。
