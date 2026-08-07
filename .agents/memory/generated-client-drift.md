---
name: Generated API client drift
description: OpenAPI-generated clients (orval) get hand-edited by task agents; codegen wipes those edits
---
The spec chain is lib/api-spec/openapi.yaml → codegen → lib/api-zod + lib/api-client-react. Task agents sometimes hand-edit the GENERATED files without updating openapi.yaml, so the committed generated code is ahead of the spec.

**Why:** Running codegen after such a merge silently reverted their fields (request bodies, response fields, POST-as-query hooks) and broke both artifacts even though `pnpm tsc --build` passed (composite build can be stale).

**How to apply:** Before/after running codegen, diff the generated files; port any drifted fields INTO openapi.yaml (and orval.config.ts `operations: { <op>: { query: { useQuery: true } } }` for POST endpoints used as polling queries). Always verify with per-artifact `pnpm --filter <pkg> exec tsc --noEmit`, not just the workspace build.
