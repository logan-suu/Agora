import hashlib, json, os, pathlib, subprocess, time

base = pathlib.Path('test-outputs/langgraph-receipts').resolve()
records = []
source = base / 'src/receipts.test.ts'
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

def run(case, mode, fault='', error=None, changed_input=False):
    root = base / 'results' / case
    env = dict(os.environ, LG_RECEIPT_ROOT=str(root), LG_RECEIPT_MODE=mode, LG_RECEIPT_FAULT=fault)
    env.pop('LG_RECEIPT_EXPECT_ERROR', None)
    env.pop('LG_RECEIPT_INPUT', None)
    if error: env['LG_RECEIPT_EXPECT_ERROR'] = error
    if changed_input: env['LG_RECEIPT_INPUT'] = 'fixed-input-v2'
    log = base / f'{case}-{mode}.log'
    started = time.time()
    with log.open('w') as out:
        process = subprocess.run(['pnpm','exec','vitest','run','--config',str(base/'vitest.config.mjs')], env=env, stdout=out, stderr=subprocess.STDOUT)
    record = dict(case=case, mode=mode, exitCode=process.returncode, seconds=round(time.time()-started,3), logSha256=hashlib.sha256(log.read_bytes()).hexdigest())
    if fault:
        assert process.returncode != 0, record
        record['fault'] = json.loads((root/'fault.json').read_text())
        assert record['fault']['window'] == fault
        try: os.kill(record['fault']['pid'],0)
        except ProcessLookupError: record['faultProcessExited'] = True
        else: raise RuntimeError('fault worker still alive')
    else:
        assert process.returncode == 0, (record, log.read_text()[-4000:])
        output = root / f'{mode}.json'
        if output.exists(): record['result'] = json.loads(output.read_text())
    records.append(record)
    (base/'results.json').write_text(json.dumps(dict(sourceSha256=source_hash, records=records),indent=2)+'\n')
    print(case,mode,process.returncode,flush=True)
    return record.get('result')

for window in ['before-dispatch','dispatch-committed','started','effect-without-receipt','business-committed','pending-writes']:
    run(window,'start',fault=window)
    observed = run(window,'inspect')
    assert observed['stateUnchanged']
    if window in ['started','effect-without-receipt']:
        resumed = run(window,'resume',error='NEEDS_ATTENTION_UNPROVEN_EFFECT')
        assert resumed['stateUnchanged'] and resumed['effect'] == observed['effect']
        assert resumed['status'] == 'needs_attention'
    else:
        resumed = run(window,'resume')
        assert resumed['effect']['count'] == 1 and resumed['next'] == []
        duplicate = run(window,'duplicate')
        assert duplicate['effect']['count'] == 1 and duplicate['stateUnchanged']
        if window in ['business-committed','pending-writes']:
            assert resumed['stateUnchanged'] and observed['effect'] == resumed['effect']
    if window == 'pending-writes': assert 'result' in observed['pendingWrites'], observed

run('normal-final','start')
assert run('normal-final','inspect')['stateUnchanged']
assert run('normal-final','duplicate')['stateUnchanged']
assert run('normal-final','different-input',error='INPUT_CONFLICT',changed_input=True)['stateUnchanged']
for mutation,error in [('missing','GRAPH_BUSINESS_CONFLICT'),('input','RECEIPT_CONFLICT'),('effect','EFFECT_CONFLICT')]:
    case = 'corrupt-'+mutation
    run(case,'start')
    run(case,case)
    observed=run(case,'inspect',error=error)
    resumed=run(case,'resume',error=error)
    assert resumed['stateUnchanged'] and observed['effect']==resumed['effect']
assert hashlib.sha256(source.read_bytes()).hexdigest()==source_hash
print('COMPLETE',len(records),'independent runner processes',flush=True)
