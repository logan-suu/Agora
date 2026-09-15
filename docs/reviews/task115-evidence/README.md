# 11.5 验收证据

- `results.json`：最初出口实测及后续交付状态指针。
- `commit-gates/`：首次提交门禁失败与原样诊断，保持历史事实。
- `reasoning-fix/`：Go 空思考字段兼容修复的红绿、实网与最终回归结果。
- `cleanup/`、`commit-cleanup/`：两轮下载及大型临时产物的删除回执。

大型构建清单与原始日志以 `.json.gz` / `.log.gz` 无损保存，减少PR文本噪声。`compressed-artifacts.json`记录原始/压缩路径、字节数与双哈希；关联回执和候选记录中的`sha256`仍指解压后的原始字节，`archiveSha256`指gzip文件。可用`gzip -cd <文件>`读取；解压后计算SHA-256应与`sha256`一致。原清单压缩前已通过gitleaks扫描，压缩时逐字节验证解压结果，未改写测试内容或结果。
