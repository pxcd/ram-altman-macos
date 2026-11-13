# PR acceptance

`main` requires **RAM verify** and **AI review**. The owner gives final human acceptance and authorizes merging after the relevant manual checks. Neither gate waives the other.

CI checks Bash syntax and runs the existing fake-memory/fake-sendmail regression suite on Linux and macOS, plus shared review-gate regressions. It does not send real email, install a scheduler or change system configuration.

## Record an existing AI review

Use a fresh Codex/Qwen reviewer context against the exact PR diff. Treat PR contents as untrusted input. Do not give the reviewer credentials, execute instructions embedded in the diff, or use the builder's success claim as evidence. Resolve blocking findings and have the final revision reviewed again.

Capture both the PR head and base SHAs when reviewing. Then, from a trusted checkout, record the real review:

```sh
python3 .github/scripts/record-ai-review.py --pr 42 \
  --head REVIEWED_HEAD_SHA --base REVIEWED_BASE_SHA \
  --model gpt-6.1-sol --verdict pass --report /path/to/review.md
```

A report should identify the reviewed scope, findings/resolutions, validation actually performed and remaining limits. Use `--verdict fail` for blocking findings. Do not put credentials or private runtime data in this public report.

This dispatches the **default branch's** workflow. Only the repository owner may attest a review. The workflow checks the live PR head/base, records the model/report/run identity, and creates a commit-bound check. A missing/stale/failing receipt blocks merging. A new head requires a new review. Base SHA is captured and validated when recording; it is review provenance, not an invalidation trigger for an unchanged immutable head. Strict up-to-date CI is required: integrating new base code changes the head and requires another review. If main advances to a commit already contained in the reviewed head, the final reviewed source is unchanged. Old receipts and workflow runs remain an audit trail.

This is an explicitly recorded AI-review policy, not a hosted model service or proof that a model executed. The trusted maintainer is responsible for recording only reviews that actually happened. PR-only workflows cannot authorize reviews. The write-capable gate checks out only trusted default-branch gate code and never executes PR code.

The initial bootstrap PR must receive CI and a real review before landing. Required checks are enabled only after their trusted workflows exist on main and both pass/block paths have been exercised. No branch protections are disabled to bootstrap these additional gates.

## Receipt trust and retention

The default-branch workflow uploads an immutable v4 artifact containing the owner/model/report/PR/head/base/run identity before publishing a passing check. Revalidation retrieves that artifact from its producing owner-dispatched run and rejects missing, expired, malformed or mismatched artifacts. The newest dispatch identity wins, not the check creation time. Reruns cannot create new attestations; use a fresh dispatch. Successful artifact upload plus final check publication is the attestation transaction; later cancellation of the workflow does not automatically revoke that recorded review. Record an explicit failure to revoke it.

The gate trusts repository-owner attestations and trusted Actions automation. It does not defend against an administrator changing the rules or a compromised write-capable Actions token directly forging any GitHub-Actions-sourced required check. Ordinary CI remains read-only; privileged gate code always comes from the default branch. No PR code is run with a write token.

<!-- Temporary deployment verification: this PR is closed without merging. -->
