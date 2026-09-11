import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EvalResult } from '../../core/contracts';
import { summarize, type Trial } from './accounting';
import type { GroupRegistry } from './manifest';

export function buildReport(registry: GroupRegistry) {
  const group = registry.read();
  const protocol = (registry.manifest.frozen as { protocol?: { publicTestVisibility: string } })
    .protocol;
  let operatorInterrupted: string[] = [];
  try {
    const note = JSON.parse(
      readFileSync(join(dirname(registry.path), 'operator-pause.json'), 'utf8'),
    );
    if (note.operatorInterruptedTrials !== undefined) {
      if (
        !Array.isArray(note.operatorInterruptedTrials) ||
        note.operatorInterruptedTrials.some((id: unknown) => typeof id !== 'string')
      )
        throw new Error('invalid operator interruption annotation');
      operatorInterrupted = note.operatorInterruptedTrials;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const trials = registry.manifest.trials as Trial[];
  const rows = group.attempts
    .filter((a) => a.status !== 'pending')
    .map((a) => {
      const trial = trials.find((t) => t.id === a.id);
      if (!trial) throw new Error('missing trial');
      let result: EvalResult | undefined = a.result as EvalResult | undefined;
      if (!result && a.runRoot)
        try {
          result = JSON.parse(readFileSync(join(a.runRoot, 'result.json'), 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      let evidence: Record<string, unknown> = {};
      if (a.runRoot && trial.variant !== 'single')
        try {
          evidence = JSON.parse(readFileSync(join(a.runRoot, 'multi-evidence.json'), 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      return {
        ...trial,
        operatorInterrupted: operatorInterrupted.includes(trial.id),
        final: a.status === 'final' && result?.lifecycle === 'final',
        passed: a.status === 'final' && result?.overallStatus === 'pass',
        durationMs:
          result?.efficiency.durationMs ??
          Math.max(0, Date.now() - Date.parse(a.startedAt as string)),
        outcome:
          result?.checks.find((c) => c.id === 'outcome.assertion:independent-outcome')?.status ??
          'unknown',
        result,
        evidence,
      };
    });
  const groups = [...new Set(trials.map((t) => `${t.suite}/${t.task}/${t.variant}`))].map((key) => {
    const selected = rows.filter((r) => `${r.suite}/${r.task}/${r.variant}` === key);
    const stats = summarize(selected);
    return {
      key,
      ...stats,
      operatorInterrupted: selected.filter((r) => r.operatorInterrupted).length,
      outcomePassed: selected.filter((r) => r.outcome === 'pass').length,
      gateReached: selected.filter((r) => r.evidence.gateReached === true).length,
      parallelReached: selected.filter(
        (r) => typeof r.evidence.leasePeak === 'number' && r.evidence.leasePeak > 1,
      ).length,
      forkReached: selected.filter(
        (r) => typeof r.evidence.forks === 'number' && r.evidence.forks > 0,
      ).length,
      contextChanged: selected.filter(
        (r) =>
          Array.isArray(r.evidence.projections) && r.evidence.projections.some((p) => p.changed),
      ).length,
    };
  });
  const paired = rows
    .filter((r) => r.passed && ['single', 'multi'].includes(r.variant))
    .flatMap((base) => {
      const targets =
        base.suite === 'public'
          ? base.variant === 'single'
            ? ['multi']
            : ['mixed']
          : ['parallel', 'sparse'];
      return targets.flatMap((variant) => {
        const other = rows.find(
          (r) =>
            r.task === base.task && r.attempt === base.attempt && r.variant === variant && r.passed,
        );
        return other && other.durationMs > 0
          ? [
              {
                task: base.task,
                attempt: base.attempt,
                baseline: base.variant,
                variant,
                differenceMs: other.durationMs - base.durationMs,
                speedRatio: base.durationMs / other.durationMs,
              },
            ]
          : [];
      });
    });
  return {
    fingerprint: group.fingerprint,
    accountingMetric:
      (registry.manifest.frozen as { config?: { accountingMetric?: string } }).config
        ?.accountingMetric ?? 'estimated-api-cost-usd',
    protocol: protocol ?? { publicTestVisibility: 'withheld-v1' },
    operatorInterrupted: rows.filter((r) => r.operatorInterrupted).length,
    planned: trials.length,
    started: rows.length,
    final: rows.filter((r) => r.final).length,
    unstarted: group.attempts.filter((a) => a.status === 'pending').map((a) => a.id),
    groups,
    paired,
    rows,
  };
}
export function reportMarkdown(report: ReturnType<typeof buildReport>) {
  return `# Task 10.5 最终 Benchmark 运行报告\n\n计划 ${report.planned} 次；已启动 ${report.started} 次；final ${report.final} 次；未启动 ${report.unstarted.length} 次。操作暂停影响 ${report.operatorInterrupted} 次（保留在已启动分母，单独解释）。清单指纹：\`${report.fingerprint}\`。\n\n这是固定 Aider Polyglot JavaScript 四题子集与两个新内部 holdout 的小样本探索，不是完整排行榜分数。Outcome 为独立判定；流程通过还要求真实产品终审/资源回收等适用检查。失败和中断保留在分母，未知指标不填零。\n\n| 集合/任务/变体 | 流程及结果通过/启动 | 独立 Outcome 通过 | 成功均值 ms | 成功样本方差 | 失败均值 ms | gate/并行/Fork/context 触达 |\n| --- | --- | --- | --- | --- | --- | --- |\n${report.groups.map((g) => `| ${g.key} | ${g.passed}/${g.started} | ${g.outcomePassed} | ${g.successTime.mean ?? 'unknown'} | ${g.successTime.variance ?? 'unknown'} | ${g.failureTime.mean ?? 'unknown'} | ${g.gateReached}/${g.parallelReached}/${g.forkReached}/${g.contextChanged} |`).join('\n')}\n\n仅同题、同重复序号且双方整体通过的样本形成配对，当前 ${report.paired.length} 对。计量口径：${report.accountingMetric}（Go为订阅额度折算，不是实际新增账单；不得与官方直连费用混算；缺缓存拆分的请求按全部输入未缓存的上界计量，逐请求costBasis明确标注）。详细逐次费用、token、时延、失败原因、资源/机制证据与配对结果见同目录 JSON。完成 gate 的所有 worker 若已 done，Fork=0 符合 D17，不能当成暂停 worker 真 Fork 的覆盖。\n\n每格最多三次，无统计显著性或普遍优越性结论；在线模型别名可能变化，报告只能解释固定时间窗口与配置。${report.protocol.publicTestVisibility === 'withheld-v1' ? '旧v1公开测试不可见；已因接口契约缺口停止，该组不与新协议混算。' : '公开上游测试作为可读契约，参考解及内部holdout验证始终隔离。'} Agent 使用 type=module 与自写Node测试；独立Jest判定只使用私有原始测试/config及候选源文件。没有原 Aider prompt/Agent/重试协议，故不与其官方总榜直接横比。\n`;
}
