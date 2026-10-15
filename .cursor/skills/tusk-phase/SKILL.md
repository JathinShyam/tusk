---
name: tusk-phase
description: Executes Tusk work in roadmap order with checklists and exit criteria. Use when implementing features, starting a session, asking what to do next, or updating docs/ROADMAP.md.
---

# Tusk phase execution

## Instructions

1. Open [`docs/ROADMAP.md`](../../../docs/ROADMAP.md). Identify the **lowest phase** with unchecked boxes (Phase 0 if the API package does not exist).
2. Open cited PRD/TRD sections. Do not implement later-phase features (no LISTEN in Phase 1, no search in Phase 2).
3. Copy the phase checklist into the session and work top to bottom. Prefer the smallest slice that unlocks a test.
4. After a slice: run relevant tests. Mark the roadmap box only if done.
5. At **exit criteria**: stop. Summarize remaining boxes. Ask before starting the next phase.

## Allowed exceptions

- Bugfixes in **already completed** phases.
- `pg_cron` missing: implement SQL functions + document waiver in ROADMAP (do not invent Redis queues).

## Output when asked “what next”

```
Current phase: N — <name>
First open items:
- [ ] ...
Exit criteria: ...
Out of scope this phase: ...
```

## Additional resources

- [ROADMAP.md](../../../docs/ROADMAP.md)
- [TRD.md](../../../docs/TRD.md)
- [AGENTS.md](../../../AGENTS.md)
