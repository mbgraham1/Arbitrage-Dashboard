---
name: OB path-based execution
description: The OB executor and pre-flight are asset-path generic (3- and 4-leg); conventions for extending and testing them
---

- `preflightObPath(path, …)` is the canonical pre-flight: one leg per hop, `volumes[i]` = holdings chain. `preflightObCycle` is a thin triangle wrapper — new callers should use the path API.
- The live executor loops the cross-hop logic; every hop's residual unwind sells BOTH sides back to USD via each asset's own USD pair, sized from ACTUAL fills. Leg count is `chain.length + 1`; caps at 4 legs by explicit decision (bounded inventory risk).
- **Why:** 4-leg routes must fire with the same safety machinery as triangles; a copy-pasted second cross block would drift.
- **How to apply:** when touching executor legs, edit the loop once — never special-case a hop. Route tests mock the order-book module: keep the factory-level `preflightObPath` adapter that delegates to the `preflightObCycle` stubs (`vi.clearAllMocks` preserves factory impls; `vi.resetAllMocks` would not).
