# CallState Orphan Sweep

Option A (scope-based cleanup in withCall) and Option C (lastTouchedAt) were not implemented — the sweep safety net is sufficient for now.

Verification: `npm run typecheck && npm run test` pass.
