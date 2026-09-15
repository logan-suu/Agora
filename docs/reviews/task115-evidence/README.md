# 11.5 验收证据

- `results.json`：最初出口实测及后续交付状态指针。
- `commit-gates/`：首次提交门禁失败与原样诊断，保持历史事实。
- `reasoning-fix/`：Go 空思考字段兼容修复的红绿、实网与最终回归结果。
- `cleanup/`、`commit-cleanup/`：两轮下载及大型临时产物的删除回执。

大型构建清单与原始日志以 `.json.gz` / `.log.gz` 无损保存，减少PR文本噪声。`compressed-artifacts.json`记录原始/压缩路径、字节数与双哈希；关联回执和候选记录中的`sha256`仍指解压后的原始字节，`archiveSha256`指gzip文件。可用`gzip -cd <文件>`读取；解压后计算SHA-256应与`sha256`一致。原清单压缩前已通过gitleaks扫描，压缩时逐字节验证解压结果，未改写测试内容或结果。

PR #83审查后，三处Downloads来源路径的账户名替换为`<redacted>`；具体文件及脱敏前后SHA-256见`pr-review.json`。`cleanup/receipt.json`对应`3-result.json`的`sha256`保留原始来源字节身份，`archiveSha256`校验当前脱敏副本，`redaction`注明变换；不能再用原始hash校验脱敏后的文件。DMG内容hash、安装/清理结果和压缩原始日志未改，Git历史未重写；这不是全仓库匿名化。
