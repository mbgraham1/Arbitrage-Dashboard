---
name: Post-fire warning banners
description: UI banners claiming a trade fired must be derived from the execution RESULT, not fire intent
---
Rule: any "AUTO fired…" or post-trade banner must be computed in the mutation's success handler, gated on `success && executed && !isDryRun`, using the fresh preflight/realized numbers from the response — never set before `.mutate()` from stale scan values.
**Why:** completion review rejected a banner set at fire time: preflight rejections place no orders, so the banner lied. Rejected/errored outcomes must also clear any prior snapshot.
**How to apply:** thin-edge banners use the shared `thinFireFromExecResult` helper (cat-arb store); trade sizes decided server-side (e.g. tri auto-loop) must be returned in the response.
