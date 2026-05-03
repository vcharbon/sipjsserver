# Decision-engine contract

> **Audience:** consumers wiring a `CallDecisionEngine` (HTTP-backed,
> in-process, or anything else). Read this before designing your
> templating / variable-substitution layer.

## TL;DR

- Every value reaching `CallDecisionEngine.newCall` /
  `callFailure` / `callRefer` is a **fully-resolved literal**.
  sipjsserver does NOT do `$(ip.AS)` / `$(port.AS)` / any other
  `$(...)` substitution. If your call-control payload uses
  placeholders, expand them on **your** side before handing the
  response to sipjsserver.
- `Contact` is **owned by the B2BUA on routed calls**. You cannot set
  it via `update_headers`. (Reject responses are an exception — see
  [Issue 9 / refer-and-sipfrag](./refer-and-sipfrag.md) and the JSDoc
  on `NewCallRejectResponse`.)
- The values you most plausibly want to template against — the
  AS-side host/port the B2BUA stamps on outbound Contact / Via — are
  exposed as a small read-only API on `StackIdentity`, the
  service tag re-exported from `@vcharbon/sipjs/b2bua`.

## What sipjsserver does NOT do

### No `$(...)` substitution anywhere

The decision-response shapes (`NewCallRouteResponse`,
`CallFailureFailoverResponse`, …) carry raw strings — `destination.host`,
`new_ruri`, every value of `update_headers`. sipjsserver consumes them
as-is and stamps them on the wire SIP messages. A partially-substituted
string like `sip:alice@$(ip.AS):5060` would corrupt the URI; we do not
try to salvage it.

If your existing call-control service emits a templated response,
either:
- Run substitution **inside your adapter** before the response reaches
  `Effect.succeed(...)` in the `CallDecisionEngine` Layer, or
- Run substitution **inside your call-control HTTP backend** before
  the JSON response leaves the wire.

The boundary is: by the time `CallDecisionEngine` returns,
**every string is a literal**.

### No `Contact` override on routed calls

`Contact` is one of the FORBIDDEN headers in the
[forbidden-headers validator](../../src/decision/validators/forbiddenHeaders.ts).
On routed calls (action `route` / `failover` / `allow`), the B2BUA
synthesizes Contact from `StackIdentity.advertisedHost` / `Port` plus
per-leg routing metadata. An adapter setting
`update_headers["Contact"]` is rejected with a `CallDecisionError`
(`kind: "semantic-violation"`).

Reject responses are different — see Issue 9. On a 302 / 4xx the
consumer may legitimately need to author Contact, so
`NewCallRejectResponse.update_headers["Contact"]` is allowed
unconditionally.

## What sipjsserver WILL offer (the read-side seam)

### `StackIdentity`

A small Effect-shaped service tag exposing the values consumers most
plausibly need to template against:

```ts
import { Effect } from "effect"
import { StackIdentity } from "@vcharbon/sipjs/b2bua"

const myCallDecision = /* … */
const config = Effect.gen(function* () {
  const identity = yield* StackIdentity
  const host = yield* identity.advertisedHost
  const port = yield* identity.advertisedPort
  return { host, port }
})
```

| Field | Meaning |
|-------|---------|
| `advertisedHost` | The IP/hostname the B2BUA stamps on outbound Contact and Via. Maps to `AppConfig.sipLocalIp` today. |
| `advertisedPort` | The port the B2BUA stamps on outbound Contact and Via. Maps to `AppConfig.sipLocalPort` today. |

Both fields are `Effect<string | number>` rather than plain values so
the API can grow (e.g. dynamic re-resolution when a future deployment
mode separates the bind IP from the advertised IP) without breaking
consumers.

### Recommended consumer pattern

```ts
import { Effect, Layer } from "effect"
import { CallDecisionEngine, StackIdentity } from "@vcharbon/sipjs/b2bua"
import type { NewCallRequest } from "@vcharbon/sipjs/b2bua"

// Read once at startup, stash in a closure.
const myCallDecisionLayer = Layer.effect(
  CallDecisionEngine,
  Effect.gen(function* () {
    const identity = yield* StackIdentity
    const advertisedHost = yield* identity.advertisedHost
    const advertisedPort = yield* identity.advertisedPort

    const substitute = (template: string) =>
      template
        .replace(/\$\(ip\.AS\)/g, advertisedHost)
        .replace(/\$\(port\.AS\)/g, String(advertisedPort))

    return {
      newCall: (req: NewCallRequest) => Effect.gen(function* () {
        // 1. Call your real backend with the raw req.
        // 2. Run YOUR templating over the response strings (e.g.
        //    `update_headers["Diversion"] = "<sip:$(ip.AS)>"`).
        // 3. Return literals to sipjsserver.
        const wire = yield* myBackend.routeNewCall(req)
        return {
          action: "route" as const,
          destination: wire.destination,
          new_ruri: substitute(wire.new_ruri),
          update_headers: Object.fromEntries(
            Object.entries(wire.update_headers ?? {}).map(([k, v]) => [
              k,
              v === null ? null : substitute(v),
            ]),
          ),
        }
      }),
      callFailure: /* … */,
      callRefer: /* … */,
    }
  }),
)
```

Everything sipjsserver receives back is literal; your placeholder layer
stays entirely on your side.

## Cross-references

- [refer-and-sipfrag.md](./refer-and-sipfrag.md) — REFER never returns
  4xx; transfer outcomes travel via NOTIFY sipfrag.
- `src/decision/validators/forbiddenHeaders.ts` — the canonical
  partition of header names (FORBIDDEN, PARTIAL, body-slot, OK).
- `src/b2bua/stack-identity.ts` — the StackIdentity service definition
  (and the pure helpers that build the actual Via / Contact values).
