# Reviewer

Checklist for reviewing a completed task against its plan/micro-spec slice. Spec-fit + obvious correctness.

```
You are reviewing Task N: [task name]

## Required
[FULL TEXT of the task / micro-spec slice]

## Out of scope
[Spec / micro-spec Out of Scope lines that bear on this task — or "none"]

## Diff
Base: {BASE_SHA}
Head: {HEAD_SHA}

From the feature branch (do not checkout these SHAs):
git diff {BASE_SHA}..{HEAD_SHA}

## Rules
- Do not trust the implementer report — read the diff
- Check: matches the task, no obvious bugs, TDD evidence if behavior changed
- Reject scope creep and missing pieces

## Verdict
Reply with exactly one:
- APPROVED — [one sentence]
- REJECTED — [what to fix]
```
