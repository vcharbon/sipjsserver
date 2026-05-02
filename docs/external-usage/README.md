# Using `@vcharbon/sipjs` as a library

This package is published with **subpath exports**. Pick the entrypoint
that matches what you want to do.

| Subpath | Use case | Doc |
|---|---|---|
| `@vcharbon/sipjs/test-harness` | Drive REGISTER + INVITE scenarios against your real third-party SIP system through an in-process registrar front-proxy | [test-harness.md](./test-harness.md) |
| `@vcharbon/sipjs/b2bua` | Embed the full B2BUA in your own Effect app with a custom `CallDecisionEngine` (HTTP backend, in-process logic, anything) | [b2bua-embedded.md](./b2bua-embedded.md) |
| `@vcharbon/sipjs/sip` | Low-level SIP primitives (parser, header helpers, message builder, types). Use when writing custom assertions or message synthesis on top of the test harness. | (see source — small surface) |
| `@vcharbon/sipjs/sip-front-proxy` | The standalone front proxy primitives (`ProxyCore`, registry layers, routing strategies). Used internally by `/test-harness`; also useful when running your own proxy instance. | (see source) |
| `@vcharbon/sipjs/observability` | Optional OTLP HTTP tracing layer (`otlpHttpTracingLayer`). Compose with `b2buaEmbeddedLayer` when you want spans exported. | (see source) |

## Install

`@vcharbon/sipjs` is **not on npm yet**. Install it directly from a
local git checkout. Pick whichever workflow matches your project.

### 0. Get the source and build it

You only do this once, then re-run `npm run build` whenever you pull
new changes.

```bash
# 1. Clone the repo somewhere outside your consumer project
git clone https://github.com/<you>/sipjsserver.git ~/code/vcharbon-sipjs
cd ~/code/vcharbon-sipjs

# 2. Install its own deps + dev deps (no jssip — it's dead code)
npm install

# 3. Build dist/ — the exports map in package.json points at dist/<subpath>/index.js
npm run build
```

After `npm run build`, `~/code/vcharbon-sipjs/dist/` contains the five
subpath bundles plus `.d.ts` files. The consumer's `import` /
`require` resolution flows through the `exports` field in
`~/code/vcharbon-sipjs/package.json`, so the path layout in `dist/` is
the contract — don't move files around inside it.

### Option A — `file:` dependency (simplest, snapshot at install time)

In your **consumer** project's `package.json`:

```jsonc
{
  "dependencies": {
    "@vcharbon/sipjs": "file:/home/you/code/vcharbon-sipjs",
    "effect": "^4.0.0-beta.42",
    "@effect/platform-node": "^4.0.0-beta.42"
  }
}
```

Then `npm install` in the consumer. npm copies the package contents
(everything listed under `"files"` in `vcharbon-sipjs/package.json` —
i.e. `dist/`, `README.md`, `LICENSE`) into your `node_modules`.

**Caveat:** the copy is taken at install time. If you re-run `npm run
build` in `~/code/vcharbon-sipjs`, the consumer's `node_modules` does
NOT pick up the new dist automatically. Re-run `npm install` (or
`npm install --force`) in the consumer to re-snapshot.

### Option B — `npm link` (live symlink, best for active iteration)

If you're editing both projects in parallel:

```bash
# In ~/code/vcharbon-sipjs (one-time, registers the package globally)
cd ~/code/vcharbon-sipjs
npm link

# In the consumer project
cd ~/code/my-sip-tests
npm link @vcharbon/sipjs
```

Now `node_modules/@vcharbon/sipjs` is a symlink into
`~/code/vcharbon-sipjs`. Re-running `npm run build` in the source repo
is enough — the consumer sees the new `dist/` immediately.

**Caveat:** `npm link` puts a symlink in `node_modules`; some
bundlers / Docker workflows trip on that. For CI use Option A or
Option C.

### Option C — `npm pack` tarball (closest to a real npm install)

```bash
# In ~/code/vcharbon-sipjs
npm run build
npm pack
# → produces vcharbon-sipjs-0.1.0.tgz
```

Then in the consumer:

```bash
npm install /home/you/code/vcharbon-sipjs/vcharbon-sipjs-0.1.0.tgz
```

This is the same artifact npm would publish, so any "it works locally
but breaks once published" surprises surface here. Recommended for
sanity-checking before you eventually do publish.

### Dependencies (v1)

`@vcharbon/sipjs` currently bundles every runtime dep — `effect`,
`@effect/platform-node`, `@effect/opentelemetry`, `@opentelemetry/*`,
`ioredis`, `@kubernetes/client-node` — as regular `dependencies`. They
all install automatically when you add the package, even though the
test-harness and in-memory embedded b2bua never load most of them.

> Why: the same package ships a Docker-deployed standalone B2BUA server
> that needs Redis + OTel + K8s at runtime, so they have to be in
> regular deps to survive `npm ci --omit=dev` in the prod image. A
> follow-up will demote them to optional peers once the standalone
> server's Docker build installs them explicitly.

## Effect

The package is **Effect-native**. Public APIs return `Effect`,
`Layer`, and Effect Service tags. Consumers are expected to compose
layers and run effects with `Effect.runPromise` /
`NodeRuntime.runMain` /  `@effect/vitest`'s `it.live` etc.

There is no Promise-facade for v1.

## v1 scope and what's deferred

In scope for v1:
- Register-proxy test harness (use case #1)
- Embedded full B2BUA with custom HTTP / in-process call decision (use case #2)
- In-memory defaults for cache, limiter, CDR, tracing
- Optional OTLP HTTP exporter

Out of scope (deferred):
- Customizing the b2bua's rule registry — rules are fixed at module load time
- A Promise-facade public API
- Splitting into multiple npm packages
- TCP / TLS transport (UDP only)
- Production-grade replication / HA wiring as a turn-key layer (compose `B2buaCoreLayer` + Redis layers manually if you need it)
