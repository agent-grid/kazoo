# Narration Fidelity — Improvement Log

**Metric:** Narration Fidelity (0–1), mean over agent turns. An LLM judge compares the
spoken narration for each turn to the executor's ground-truth event log (`tool_use` blocks,
assistant text, resulting diff).

**Rubric (per turn, weighted mean):**
- **Coverage** — material actions mentioned, nothing significant done silently.
- **Honesty** — no claimed actions that didn't happen.
- **Semantic correctness** — plain-language mapping is right (grep = "searching the code", not "the web").
- **Altitude** — summarizes intent, doesn't read raw commands; doesn't over/under-narrate.

This file is the demo artifact: it shows each loop iteration moving the score.

## Summary

| Iter | Time | Mean fidelity | # scenarios | Change made |
|------|------|---------------|-------------|-------------|
| 0 (baseline) | _TBD_ | _TBD_ | _TBD_ | Initial narrator prompt |
|  |  |  |  |  |

---

## Iteration 0 — Baseline

- **Mean fidelity:** _TBD_
- **Scenarios:** _TBD_
- **Narrator config:** initial prompt (relay preambles + salience filter)

### Failure patterns observed
- _e.g._ narrator claimed it "ran the tests" when no test tool was invoked (Honesty)
- _e.g._ silent file deletion not narrated (Coverage)

### Example (before)
> **Event log:** `tool_use: Bash("grep -r validateEmail src/")`
> **Narration:** "I'm searching the web for how to validate emails."  ❌ Semantic

---

## Iteration 1 — <change>

- **Change made:** _e.g._ added few-shot examples mapping each tool class to plain language; explicit "never claim an action not in the event log" rule
- **Mean fidelity:** _TBD_ (Δ from baseline: _TBD_)
- **Scenarios:** _TBD_

### Example (after)
> **Event log:** `tool_use: Bash("grep -r validateEmail src/")`
> **Narration:** "I'm searching the codebase for where email validation already happens."  ✅

### Notes
-
