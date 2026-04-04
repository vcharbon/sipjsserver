# TODO list

## Redis management

- [] async flush to redis should guarantee ordering for a given call via lock per call context
- [] proper model of event
- [] mesure perf imact of flushing all to redis including call establishment
- [] 

## DX / architecture cleanups (from slice 3 retro)

- [ ] Single source of truth for layer composition — extract `AppLayers.ts` exporting `MainLayer`, `WorkerLayer`, `TestLayer` factory. Today main.ts, cluster/WorkerEntry.ts, and tests/e2e/framework/simulated-backend.ts each hand-wire the same dependency graph; ordering bugs (e.g. duplicate OverloadController instances) are silently allowed.
- [ ] `testAppConfig()` in tests/e2e/framework/simulated-backend.ts should spread a shared default config object instead of being a hand-maintained literal. Already burned us once: missing `cpsBucketSize` → `tokens=undefined` → all INVITEs rejected by Tier 3.
- [ ] Revisit StatusServer's optional-dependency story. The current `MetricsRegistry` "publish on init" pattern is implicit lifecycle coupling — find a more idiomatic Effect-shaped answer (Layer.merge of optional contributors?).
- [ ] Delete dead `static readonly Default = ...` exports across services (CallControlClient already cleaned up — audit the rest).
- [ ] Split MessageFactory.ts (~800 lines, 3+ concerns) into `sip/headers.ts`, `sip/builders.ts`, `sip/byte-classifiers.ts`.
- [ ] Document scoped test running in CLAUDE.md (`npm test -- <file> -t '<name>'`) — tight feedback loop is undocumented, slows debugging.
- [ ] Plan documents should specify the *layer* an enforcement decision lives in, not just that an exemption exists. The slice 2 emergency-CallLimiter ambiguity was a real cost.
- [ ] Investigate friendlier compiler errors when an Effect service is missing under `exactOptionalPropertyTypes: true` — current "missing properties from type 'Scope'" message is misleading.
