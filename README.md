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


npx vitest run -c vitest.config.fake.ts -t "basic call"
To run only the proxy+b2b variant:


npx vitest run -c vitest.config.fake.ts -t "proxy\\+b2b" basic call"