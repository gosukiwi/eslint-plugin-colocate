# Subagent model size

Prefer the **smallest model that can finish the task reliably**. Do not default to the coordinator's model.

## Resolve (each dispatch)

1. Load config: `Read` (or `test -f` / shell) `.flow/config` at that exact path before choosing a model. Do **not** treat a failed Glob/grep/search as "no config" — `.flow/` is gitignored and often invisible to search tools.
2. Choose a **tier** (small / medium / large) using Tiers + Heuristics.
3. Resolve that tier to a **model ID**:
   - If the file exists and defines `models.<tier>`, use that exact ID.
   - Else map the tier to a model the **host** exposes (Cursor Task `model`, Claude Code Haiku/Sonnet/Opus, etc.).
4. Never invent an ID absent from both the config and the host allowlist. If the host has no model parameter, leave the default. If a config ID is not on the host allowlist, stop and ask the user — do not silently rewrite it.

Config is optional (missing file → host mapping). Example `.flow/config`:

```yaml
models:
  small: composer-2.5-fast
  medium: grok-4.5-xhigh
  large: grok-4.5-xhigh
```

A present tier key wins over a "familiar" host default (e.g. do not swap in GPT because it feels like medium).

## Tiers

| Tier | Use for |
|------|---------|
| **Small / fast** | Narrow edits, boilerplate, single-file TDD, obvious renames, "make this test green" |
| **Medium** | Multi-file tasks within a clear plan, routine review, straightforward API wiring |
| **Large** | Ambiguous requirements, cross-cutting design, tricky failures, high-risk correctness |

## Heuristics

- **Implementer:** size to the *task*, not the whole feature. A two-line change → small.
- **Reviewer:** capability ≥ that task's implementer; prefer a *different* model ID when the host/config offers one at that bar. If the implementer already used the strongest available (or no different ID exists), same model is OK — still use a fresh review subagent. Never review with a weaker model.
- **Fix after REJECTED:** same size as the implementer unless the rejection needs deeper reasoning → bump one tier.
- When unsure between two tiers, pick the **smaller**; bump only after a failed attempt or a clearly hard task.

## Do not

- Hard-code vendor model IDs in plans or specs (put project IDs in `.flow/config`)
- Skip the path Read because Glob/search returned nothing
- Ignore `.flow/config` when it defines the chosen tier
- Silently rewrite a config ID to a similar host name
- Use a large model for mechanical RED/GREEN on an already-specified task
