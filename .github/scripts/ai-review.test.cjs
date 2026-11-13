const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { handle, validate, parseReceipt, receiptID, artifactName, decodeArchive } = require('./ai-review.cjs');
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), OLD = 'c'.repeat(40);
const report = 'Reviewed the exact final diff and regression checks. No blocking findings remain. Limits: no live device testing.';
const input = extra => ({ pr: '7', head: HEAD, base: BASE, model: 'Codex', verdict: 'pass', report, ...extra });
const check = extra => ({ id: 5, external_id: receiptID(7, HEAD, BASE, 10), app: { slug: 'github-actions' }, conclusion: 'success', html_url: 'https://github.com/owner/sample/checks/5', ...extra });
function archive(value, name = 'review.json') {
  return execFileSync('python3', ['-c', 'import io,sys,zipfile,json\nv=json.loads(sys.stdin.read());b=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:z.writestr(v["name"],json.dumps(v["data"]))\nsys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify({ name, data: value }) });
}
function setup() {
  const state = { checks: [], projections: [], receipts: [], failures: [], data: new Map(), artifacts: new Map(), run: { event: 'workflow_dispatch', path: '.github/workflows/ai-review.yml', head_branch: 'main', actor: { login: 'owner' } } };
  const pr = { number: 7, state: 'open', head: { sha: HEAD }, base: { sha: BASE, ref: 'main' } };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) }, checks: { create: async value => { state.checks.push(value); const created = { id: 500, app: { slug: 'github-actions' }, ...value }; if (value.name === 'AI review') state.projections = [created]; else state.receipts.push(created); return { data: created }; }, update: async value => { state.checks.push(value); }, listForRef: () => {} }, actions: {
    getWorkflowRun: async () => ({ data: state.run }), listWorkflowRunArtifacts: () => {}, downloadArtifact: async ({ artifact_id }) => ({ data: state.data.get(artifact_id) }),
  } }, paginate: async (fn, args) => fn === github.rest.checks.listForRef ? (args.check_name === 'AI review' ? state.projections : state.receipts) : (state.artifacts.get(args.run_id) || []) };
  const context = { repo: { owner: 'owner', repo: 'sample' }, actor: 'owner', ref: 'refs/heads/main', runId: 42, runAttempt: 1, serverUrl: 'https://github.com', eventName: 'pull_request_target', payload: { repository: { default_branch: 'main' }, pull_request: { number: 7 } } };
  const core = { setFailed: message => state.failures.push(message), setOutput: () => {} };
  const put = (run = 10, patch = {}) => {
    const value = { version: 1, repository: 'owner/sample', run_id: run, actor: 'owner', attempt: 1, ...validate(input()), ...patch };
    const bytes = archive(value); state.data.set(run, bytes);
    state.artifacts.set(run, [{ id: run, name: artifactName(7, HEAD), expired: false, size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }]);
  };
  return { state, pr, github, context, core, put };
}
test('missing receipt blocks and a matching immutable trusted receipt passes', async () => {
  const x = setup(); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
  x.state.receipts = [check()]; x.put(); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'success');
});
test('forged metadata pointing to an unrelated owner run cannot pass', async () => {
  const x = setup(); x.state.receipts = [check()]; x.put(10, { pr: 99 }); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
});
test('stale head, foreign PR/app and malformed pointer cannot satisfy the gate', async () => {
  for (const bad of [check({ external_id: receiptID(7, OLD, BASE, 10) }), check({ external_id: receiptID(8, HEAD, BASE, 10) }), check({ app: { slug: 'other' } }), check({ external_id: 'fabricated' })]) {
    const x = setup(); x.state.receipts = [bad]; x.put(); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
  }
});
test('base movement leaves an already reviewed immutable head valid', async () => {
  const x = setup(); x.pr.base.sha = OLD; x.state.receipts = [check()]; x.put(); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'success');
});
test('receipts must originate from owner-dispatched default-branch gate runs', async () => {
  for (const bad of [{ event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_branch: 'feature' }, { actor: { login: 'contributor' } }]) {
    const x = setup(); Object.assign(x.state.run, bad); x.state.receipts = [check()]; x.put(); await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
  }
});
test('newest dispatch failure wins even if an older passing check was recreated later', async () => {
  const x = setup(); x.put(10); x.put(20, { verdict: 'fail' });
  x.state.receipts = [check({ id: 999 }), check({ id: 1, external_id: receiptID(7, HEAD, BASE, 20) })];
  await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
});
test('missing/expired/bad latest artifact never resurrects an older pass', async () => {
  for (const bad of ['missing', 'expired', 'digest', 'schema']) {
    const x = setup(); x.put(10); x.put(20, bad === 'schema' ? { repository: 'foreign/repo' } : {});
    if (bad === 'missing') x.state.artifacts.delete(20);
    if (bad === 'expired') x.state.artifacts.get(20)[0].expired = true;
    if (bad === 'digest') x.state.artifacts.get(20)[0].digest = 'sha256:bad';
    x.state.receipts = [check(), check({ id: 6, external_id: receiptID(7, HEAD, BASE, 20) })];
    await handle(x); assert.equal(x.state.checks.at(-1).conclusion, 'failure');
  }
});
test('publishing requires prior immutable upload and fresh reviewed head/base', async () => {
  const x = setup(); x.context.eventName = 'workflow_dispatch'; x.context.payload.inputs = input();
  await assert.rejects(handle({ ...x, phase: 'publish' }), /artifact/); assert.equal(x.state.checks.length, 0);
  x.put(42); await handle({ ...x, phase: 'publish' }); assert.equal(x.state.checks.at(-1).conclusion, 'success');
  for (const patch of [{ head: OLD }, { base: OLD }]) {
    x.context.payload.inputs = input(patch); await assert.rejects(handle({ ...x, phase: 'publish' }), /changed since review/);
  }
});
test('contributor, rerun, feature dispatch, closed PR and wrong target are rejected', async () => {
  for (const kind of ['actor', 'rerun', 'ref', 'state', 'target']) {
    const x = setup(); x.context.eventName = 'workflow_dispatch'; x.context.payload.inputs = input();
    if (kind === 'actor') x.context.actor = 'attacker'; if (kind === 'rerun') x.context.runAttempt = 2;
    if (kind === 'ref') x.context.ref = 'refs/heads/feature'; if (kind === 'state') x.pr.state = 'closed';
    if (kind === 'target') x.pr.base.ref = 'other';
    await assert.rejects(handle({ ...x, phase: 'publish' })); assert.equal(x.state.checks.length, 0);
  }
});
test('input and ZIP validation fail closed, while report contents are inert', async () => {
  for (const patch of [{ pr: '01' }, { pr: '0' }, { head: 'short' }, { verdict: 'approved' }, { model: 'bad\nidentity' }, { report: 'short' }, { report: 'x'.repeat(20001) }]) assert.throws(() => validate(input(patch)));
  assert.throws(() => decodeArchive(Buffer.alloc(100001)), /Oversized/);
  assert.throws(() => decodeArchive(archive({}, '../review.json')));
  assert.throws(() => decodeArchive(archive({ report: 'x'.repeat(30001) })));
  const x = setup(); const text = report + '\n${{ secrets.NEVER_READ }}; process.exit(99)';
  x.context.eventName = 'workflow_dispatch'; x.context.payload.inputs = input({ report: text }); x.put(42, { report: text });
  await handle({ ...x, phase: 'publish' }); assert.match(x.state.checks.find(c => c.name === 'AI review receipt').output.summary, /process.exit\(99\)/);
});
test('an explicit failed review remains a blocking check', async () => {
  const x = setup(); x.context.eventName = 'workflow_dispatch'; x.context.payload.inputs = input({ verdict: 'fail' }); x.put(42, { verdict: 'fail' });
  await handle({ ...x, phase: 'publish' }); assert.equal(x.state.checks.at(-1).conclusion, 'failure'); assert.equal(x.state.failures.length, 1);
});

test('lookup failure leaves the required projection pending, never an older green result', async () => {
  const x = setup(); x.state.projections = [{ id: 3, app: { slug: 'github-actions' }, external_id: 'ai-review-gate:7', conclusion: 'success' }];
  x.state.receipts = [check()]; x.github.rest.actions.getWorkflowRun = async () => { throw new Error('API unavailable'); };
  await assert.rejects(handle(x), /API unavailable/);
  assert.equal(x.state.checks.at(-1).check_run_id, 3); assert.equal(x.state.checks.at(-1).status, 'in_progress');
});

test('real-style Context repo getter and environment attempt survive publication projection', async () => {
  const x = setup(); const repo = x.context.repo; delete x.context.repo;
  Object.setPrototypeOf(x.context, { get repo() { return repo; } });
  delete x.context.runAttempt; const old = process.env.GITHUB_RUN_ATTEMPT; process.env.GITHUB_RUN_ATTEMPT = '1';
  x.context.eventName = 'workflow_dispatch'; x.context.payload.inputs = input(); x.put(42);
  try { await handle({ ...x, phase: 'publish' }); assert.equal(x.state.checks.at(-1).conclusion, 'success'); }
  finally { if (old === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = old; }
});

test('artifact-list and download outages leave the projection pending', async () => {
  for (const stage of ['list', 'download']) {
    const x = setup(); x.state.receipts = [check()]; x.put();
    if (stage === 'download') x.github.rest.actions.downloadArtifact = async () => { throw new Error('HTTP 503'); };
    else { const paginate = x.github.paginate; x.github.paginate = async (fn, args) => { if (fn === x.github.rest.actions.listWorkflowRunArtifacts) throw new Error('HTTP 503'); return paginate(fn, args); }; }
    await assert.rejects(handle(x), /HTTP 503/);
    assert.equal(x.state.checks.at(-1).status, 'in_progress');
  }
});
