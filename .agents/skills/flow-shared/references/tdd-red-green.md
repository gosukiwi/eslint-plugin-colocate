# TDD RED-GREEN

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

## Cycle

1. **RED** — one minimal test for one behavior
2. **Verify RED** — run it; fails for the right reason (missing behavior, not a typo)
3. **GREEN** — minimal code to pass
4. **Verify GREEN** — suite green
5. **REFACTOR** — clean up; stay green

## What to test

**TDD applies:** logic, API contracts, data mutations, UI behavior (validation, show/hide, errors).

**Skip new tests** (document a quick manual check instead): pure presentation (CSS, spacing, copy), static markup with unchanged behavior.

## Evidence

Report fail-before and pass-after output. If an automated test is impractical, say why and use the closest substitute (script, repro command) — still broken-then-fixed.
