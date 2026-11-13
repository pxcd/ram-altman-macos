'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const CHECK = 'AI review';
const RECEIPT_CHECK = 'AI review receipt';
class ReceiptError extends Error {}
const SHA = /^[a-f0-9]{40}$/;
function receiptID(pr, head, base, run) { return `ai-review-v1:${pr}:${head}:${base}:${run}`; }
function artifactName(pr, head) { return `ai-review-v1-pr-${pr}-head-${head}`; }
function parseReceipt(value) {
  const m = /^ai-review-v1:([1-9][0-9]*):([a-f0-9]{40}):([a-f0-9]{40}):([1-9][0-9]*)$/.exec(value || '');
  return m && { pr: Number(m[1]), head: m[2], base: m[3], run: Number(m[4]) };
}
function validate(input) {
  if (!/^[1-9][0-9]*$/.test(String(input.pr || '')) || !Number.isSafeInteger(Number(input.pr))) throw new Error('Invalid PR number');
  if (!SHA.test(input.head || '') || !SHA.test(input.base || '')) throw new Error('Full reviewed head and base SHA are required');
  if (!['pass', 'fail'].includes(input.verdict)) throw new Error('Verdict must be pass or fail');
  if (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@ +#-]{0,159}$/.test(input.model)) throw new Error('Reviewer model identity is required');
  if (typeof input.report !== 'string' || input.report.trim().length < 40 || Buffer.byteLength(input.report) > 20000) throw new Error('Supply a substantive review report (40 characters to 20KB)');
  return { pr: Number(input.pr), head: input.head, base: input.base, model: input.model, verdict: input.verdict, report: input.report.trim() };
}
function decodeArchive(bytes) {
  if (bytes.length > 100000) throw new Error('Oversized receipt archive');
  const program = `import sys,io,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\na=z.infolist()\nassert len(a)==1 and a[0].filename=='review.json' and a[0].file_size<=30000\nsys.stdout.buffer.write(z.read(a[0]))`;
  return JSON.parse(execFileSync('python3', ['-c', program], { input: bytes, maxBuffer: 40000 }).toString());
}
function trustedRun(run, owner, branch) {
  return run.event === 'workflow_dispatch' && run.path === '.github/workflows/ai-review.yml' &&
    run.head_branch === branch && run.actor?.login?.toLowerCase() === owner.toLowerCase();
}
async function readReceipt(github, owner, repo, pointer) {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { owner, repo, run_id: pointer.run, per_page: 100 });
  const matches = artifacts.filter(a => a.name === artifactName(pointer.pr, pointer.head));
  if (matches.length !== 1 || matches[0].expired || matches[0].size_in_bytes > 100000) throw new ReceiptError('Review artifact is missing, expired or oversized');
  const artifact = matches[0];
  const response = await github.rest.actions.downloadArtifact({ owner, repo, artifact_id: artifact.id, archive_format: 'zip' });
  const bytes = Buffer.from(response.data);
  if (artifact.digest && artifact.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`) throw new ReceiptError('Artifact digest mismatch');
  let review;
  try {
    const data = decodeArchive(bytes);
    review = validate(data);
    if (data.version !== 1 || data.repository !== `${owner}/${repo}` || data.run_id !== pointer.run ||
        data.actor?.toLowerCase() !== owner.toLowerCase() || data.attempt !== 1 ||
        review.pr !== pointer.pr || review.head !== pointer.head || review.base !== pointer.base) throw new Error('Artifact does not attest this receipt');
  } catch { throw new ReceiptError('Malformed or mismatched review artifact'); }
  return review;
}
async function currentPR(github, context, number) {
  const { owner, repo } = context.repo;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (pr.base.ref !== context.payload.repository.default_branch || pr.state !== 'open') throw new Error('Review gate requires an open PR targeting the default branch');
  if (!SHA.test(pr.head.sha) || !SHA.test(pr.base.sha)) throw new Error('Invalid PR commits');
  return pr;
}
async function projection(github, owner, repo, head, number) {
  const checks = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: head, check_name: CHECK, per_page: 100, filter: 'all' });
  const prior = checks.filter(c => c.app?.slug === 'github-actions' && c.external_id === `ai-review-gate:${number}`).sort((a, b) => b.id - a.id)[0];
  const data = { owner, repo, name: CHECK, status: 'in_progress', output: { title: 'Validating recorded AI review', summary: 'Review acceptance is pending validation of an immutable owner attestation.' } };
  if (prior) { await github.rest.checks.update({ ...data, check_run_id: prior.id }); return prior.id; }
  const { data: created } = await github.rest.checks.create({ ...data, head_sha: head, external_id: `ai-review-gate:${number}` });
  return created.id;
}
async function handle({ github, context, core, phase = 'gate' }) {
  const { owner, repo } = context.repo;
  const branch = context.payload.repository.default_branch;
  const record = context.eventName === 'workflow_dispatch';
  let input;
  if (record) {
    if (context.actor.toLowerCase() !== owner.toLowerCase()) throw new Error('Only the repository owner can record an AI review');
    if (context.ref !== `refs/heads/${branch}`) throw new Error('Record reviews using the trusted default-branch workflow');
    if (Number(context.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT) !== 1) throw new Error('Reruns are not new review attestations; dispatch a new review');
    input = validate(context.payload.inputs || {});
  }
  const number = record ? input.pr : context.payload.pull_request?.number;
  if (!Number.isSafeInteger(number)) throw new Error('PR number is missing');
  const pr = await currentPR(github, context, number);
  const head = pr.head.sha;
  const base = pr.base.sha;
  const runURL = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  if (record) {
    if (input.head !== head || input.base !== base) throw new Error('PR head or base changed since review; perform a new review');
    const pointer = { pr: number, head, base, run: Number(context.runId) };
    if (phase === 'prepare') {
      await projection(github, owner, repo, head, number);
      const receipt = { version: 1, repository: `${owner}/${repo}`, run_id: pointer.run, actor: context.actor, attempt: 1, ...input };
      writeFileSync('review.json', JSON.stringify(receipt));
      core.setOutput('artifact_name', artifactName(number, head));
      return;
    }
    if (phase !== 'publish') throw new Error('Record phase must be prepare or publish');
    const review = await readReceipt(github, owner, repo, pointer);
    if (JSON.stringify(review) !== JSON.stringify(input)) throw new Error('Uploaded artifact does not match the requested review');
    await github.rest.checks.create({ owner, repo, name: RECEIPT_CHECK, head_sha: head,
      status: 'completed', conclusion: review.verdict === 'pass' ? 'success' : 'failure',
      external_id: receiptID(number, head, base, context.runId), details_url: runURL,
      output: { title: `Recorded ${review.verdict.toUpperCase()} — ${review.model}`, summary:
        `Reviewer model: ${review.model}\n\nRecorded by: ${context.actor}\n\nPR: #${number}\n\nReviewed head: ${head}\n\nReview base (provenance): ${base}\n\n${review.report}\n\nExplicit maintainer attestation of an existing AI review; no model is run by this workflow.` } });
    await handle({ github, core, context: { ...context, repo: { owner, repo }, eventName: 'pull_request_target', payload: { ...context.payload, pull_request: { number } } } });
    return;
  }
  const checkID = await projection(github, owner, repo, head, number);
  const checks = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: head, check_name: RECEIPT_CHECK, per_page: 100, filter: 'all' });
  const candidates = checks.flatMap(check => {
    const pointer = parseReceipt(check.external_id);
    return pointer && pointer.pr === number && pointer.head === head && check.app?.slug === 'github-actions' ? [{ check, pointer }] : [];
  }).sort((a, b) => b.pointer.run - a.pointer.run);
  let review;
  let receipt;
  let reason = 'No recorded review exists for this head commit';
  for (const candidate of candidates) {
    const { data: run } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: candidate.pointer.run });
    if (!trustedRun(run, owner, branch)) continue;
    // The newest owner dispatch wins. Missing/bad artifacts never resurrect an older pass.
    try { review = await readReceipt(github, owner, repo, candidate.pointer); receipt = candidate.check; }
    catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      reason = 'Latest recorded review has no valid immutable artifact';
    }
    break;
  }
  const passed = review?.verdict === 'pass';
  await github.rest.checks.update({ owner, repo, check_run_id: checkID, name: CHECK,
    status: 'completed', conclusion: passed ? 'success' : 'failure',
    details_url: runURL,
    output: { title: passed ? 'Matching AI review recorded' : 'AI review required for this revision', summary: passed
      ? `Immutable review artifact matches PR #${number} and head ${head}.\n\nReceipt: ${receipt.html_url}`
      : `${reason}.\n\nHave Codex or Qwen review this revision, resolve blocking findings, then use scripts/record-ai-review.py. New head commits require a new review.` } });
  if (!passed) core.setFailed('A passing AI review for the exact head commit is required');
}
module.exports = { handle, validate, parseReceipt, receiptID, artifactName, decodeArchive, readReceipt };
