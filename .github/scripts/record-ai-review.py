#!/usr/bin/env python3
"""Record an existing AI review; this tool never runs or fabricates a review."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--head', required=True, help='Exact head SHA that was reviewed')
    parser.add_argument('--base', required=True, help='Exact base SHA that was reviewed')
    parser.add_argument('--model', required=True)
    parser.add_argument('--verdict', choices=['pass', 'fail'], required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--repo', help='owner/repo; defaults to the current Git repository')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.pr < 1 or not all(re.fullmatch('[a-f0-9]{40}', sha) for sha in [args.head, args.base]):
        parser.error('A positive PR number and full reviewed head/base SHAs are required')
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._:/@ +#-]{0,159}', args.model):
        parser.error('Invalid model identity')
    report = args.report.read_text().strip()
    if len(report) < 40 or len(report.encode()) > 20000:
        parser.error('Review report must contain 40 characters to 20KB')
    repo = args.repo or subprocess.check_output(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], text=True).strip()
    if not re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        parser.error('Invalid owner/repo')
    metadata = json.loads(subprocess.check_output(['gh', 'api', 'repos/' + repo], text=True))
    pr = json.loads(subprocess.check_output(['gh', 'api', f'repos/{repo}/pulls/{args.pr}'], text=True))
    if pr['state'] != 'open' or pr['base']['ref'] != metadata['default_branch']:
        parser.error('An open PR targeting the default branch is required')
    if pr['head']['sha'] != args.head or pr['base']['sha'] != args.base:
        parser.error('PR commits changed since review; review the new revision')
    payload = {'ref': metadata['default_branch'], 'inputs': {
        'pr': str(args.pr), 'head': args.head, 'base': args.base, 'model': args.model,
        'verdict': args.verdict, 'report': report}}
    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return
    subprocess.run(['gh', 'api', '--method', 'POST', f'repos/{repo}/actions/workflows/ai-review.yml/dispatches', '--input', '-'], input=json.dumps(payload), text=True, check=True)
    print(f'Review recording dispatched for {repo} PR #{args.pr} at {args.head}. Check the AI review workflow result; dispatch alone is not acceptance.')


if __name__ == '__main__':
    main()
