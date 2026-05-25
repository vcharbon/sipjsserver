# `@vcharbon/sipjs`

A SIP B2BUA + register-front-proxy + multi-agent SIP test framework
written in Effect-TS. Originally built as a standalone server; now
also published as a library for two use cases:

1. **Test your SIP system** — drive `alice.register()` /
   `bob.register()` scenarios through an in-process registrar
   front-proxy that forwards to your real PBX / SBC / b2bua. See
   [docs/external-usage/test-harness.md](docs/external-usage/test-harness.md).
2. **Embed the full B2BUA** in your own Effect app with a custom
   `CallDecisionEngine` (HTTP backend, in-process logic, anything).
   See [docs/external-usage/b2bua-embedded.md](docs/external-usage/b2bua-embedded.md).

The standalone server mode (`npm run dev`) still works and is the
production deployment; embedded mode is a slimmer in-memory variant
suitable for single-node use.

Full subpath map and install instructions:
[docs/external-usage/README.md](docs/external-usage/README.md).

## Compatibility

| Component | Version |
|-----------|---------|
| Node      | >=20.0.0 (matches `effect`'s baseline) |
| `effect`  | `4.0.0-beta.43` (pinned exactly — see below) |
| `@effect/platform-node` | `4.0.0-beta.43` |
| `@effect/opentelemetry` | `4.0.0-beta.42` |

**Why an exact pin (no `^`)?** The Effect 4 beta line ships occasional
API removals between betas. We pin to the exact version this repo is
built and tested against to keep consumer installs deterministic. If
the consumer's `node_modules/` resolves a *different* Effect (because a
sibling dependency hoisted one), runtime checks like
`typeof Layer.suspend === "function"` may unexpectedly return `false`.

**Quick consumer sanity check:**

```sh
node -e "import('effect').then((L) => console.log('Layer.suspend =', typeof L.Layer.suspend))"
```

Expected: `Layer.suspend = function`. If it prints `undefined`, the
consumer's app has resolved a different Effect than ours — usually a
lockfile drift or a transitive dep pulling an older `effect`. Fix at
the lockfile level (`npm dedupe` or pin the same exact version on the
consumer side); a future migration to `peerDependencies` + pnpm will
make this category of bug impossible.

> **Not on npm yet.** The package is consumed directly from a local
> git checkout. The simplest workflow is `git clone`, `npm install`,
> `npm run build` in this repo, then `"@vcharbon/sipjs":
> "file:/abs/path/to/sipjsserver"` in the consumer's `package.json`.
> Two more workflows (`npm link` for live editing, `npm pack` for a
> publish-equivalent tarball) are documented in
> [docs/external-usage/README.md](docs/external-usage/README.md#install).

> Note: this repo started as an exploration of Claude on a complex
> subject. The library surface (`/test-harness`, `/b2bua`, `/sip`,
> `/sip-front-proxy`, `/observability`) has been curated for external
> consumption; everything else is internal.

## Standalone server mode

npm run dev

```bash
npx serve /home/vince/sipjsserver/test-results/ -l 9888 &
```

## comile and deploy 

Dockerfile -- multi-stage build:

Stage 1: installs all deps, compiles TypeScript
Stage 2: production deps only (76 packages vs 128), copies compiled dist/, runs as non-root node user, health check via /status
Fix: --ignore-scripts needed because the prepare script (effect-language-service patch) requires a dev dependency
docker-compose.yml -- two services:

sip-b2bua on ports 5060/udp + 3002/tcp, read-only filesystem, init: true
redis (7-alpine), internal only, health-checked before app starts
SIP_LOCAL_IP is required with fail-fast error message
Usage:


SIP_LOCAL_IP=192.168.1.100 docker compose up -d


## good prompts


apply the sip anomaly expert to each of alice*.txt and bob*.txt file in test-report and generate a full ip anomaly report including all errors, the list of associated tests aggregated by error. Generate te report in new .md  file under docs/todos.
consider the following call, in the capture dont consider alice, bob, the B2BUA as a real B2BUA or endpoints, we mostly should consider if it is correct from RFC point of view for A to B call with other elements downstream and unstream that are hidden. 



To run just basic-call on both SUTs:


TEST_MODE=fake npx vitest run -t "basic call"
To run only the proxy+b2b variant:


TEST_MODE=fake npx vitest run -t "proxy\\+b2b" basic call"