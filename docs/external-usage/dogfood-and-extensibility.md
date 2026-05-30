# Dogfooding the extension surface — using an integrator project and treating its complaints

This is a **process doc**, not a feature doc. It explains what an integrator
*dogfood* project is, how to use it, and — most importantly — **the rule for
turning the requirements it raises into core changes**. It is generic: the first
dogfood is PRBT (`~/pprbt`), but nothing here is PRBT-specific, and that is the
whole point.

Background it builds on (read these for the model, not repeated here):
- [ADR-0015 — integrator extensibility contract](../adr/0015-integrator-extensibility-contract.md)
- [ADR-0016 — callflow services: typed per-service `ext`](../adr/0016-callflow-services-typed-ext.md)
  — the validated extensibility mechanism (typed `defineService` + ext-presence
  activation; first proven by the `promote18xPemTo200` migration)
- [ADR-0014 — leg model](../adr/0014-leg-kind-and-singleton-active-peer.md)
- Glossary: **integrator**, **extension**, **rule SDK**, **media leg**,
  **adopted/unadopted leg** in [CONTEXT.md](../../CONTEXT.md)
- [rule-extension-guide.md](../rule-extension-guide.md), [b2bua-embedded.md](./b2bua-embedded.md),
  [decision-engine-contract.md](./decision-engine-contract.md)

## What a dogfood project is

An **integrator dogfood** is a project we maintain that pretends to be a third
party. It:

- consumes **sipjsserver as a submodule (or a source symlink, e.g.
  `repos/sipjsserver`)**, and builds its own worker binary;
- implements one real callflow (PRBT first) **purely through the public rule
  SDK** — it must not reach into internal modules, the full action union, or the
  unrestricted `RuleContext`;
- ships **e2e fake-clock tests + reports** for that callflow **and** a basic
  (non-PRBT) call, so a green build proves both "the extension works" and "the
  public surface still compiles and integrates";
- records every point of friction in **`~/complaints.md`**.

Its job is **not** to ship PRBT. Its job is to **exercise and validate the
extensibility surface** and to surface, as concrete complaints, everything the
surface is missing. When the dogfood can implement its callflow against *only*
the public SDK with **zero change to the B2BUA HTTP API and zero PRBT-specific
core code**, the surface is proven general. That is the end goal.

## How to use it

1. **Set it up** (the dogfood repo owns this; sipjsserver is the submodule):
   ```
   ~/pprbt
   ├── sipjsserver/            # git submodule, pinned to a commit
   ├── src/                    # PRBT policy module(s) + descriptor schema only
   └── tests/                  # e2e fake-clock callflow tests + basic-call case
   ```
2. **Import only the public surface.** The dogfood imports the curated rule-SDK
   entrypoint, never deep internal paths. If it has to import an internal path to
   get something done, **that is a complaint**, not a workaround.
3. **Run its tests.** They must cover the callflow on every exit path (answer,
   reject, caller-cancel, media-server failure) plus a plain call. Reports render
   captured wire bytes (`wireText`), never re-encoded SIP.
4. **File complaints** in `~/complaints.md` as friction is hit (see format below).
5. **Resolve the loop**: a complaint is fixed by a *generalised* change landed in
   the sipjsserver submodule, after which the dogfood bumps the submodule pointer
   and the complaint closes. The dogfood is never fixed by special-casing the
   core for it.

## The golden rule for treating complaints

> **A complaint from the dogfood describes a missing or awkward *capability*.
> Solve the capability for the whole class of extensions — never for PRBT.**

Every requirement raised in `~/complaints.md` MUST be treated in a way that would
serve **any** extension (post-call announcement, playcollect, MRF-during-transfer,
conferencing front-ends, and callflows nobody has imagined yet), **not
necessarily the way the PRBT project happens to want it**. PRBT is one instance
of a class; you fix the class.

Litmus test for any proposed fix:

> *"If three unrelated future callflows needed something in this area, would this
> same mechanism serve all three?"* If the answer is "no, this only helps PRBT,"
> the fix is wrong.

Concretely this means:

- **No use-case verbs.** Never add a `play-prbt` / `do-announcement` action or a
  PRBT branch in core. ADR-0015 is explicit: the public surface is a small set of
  **orthogonal, use-case-agnostic primitives**. A complaint that asks for a
  feature is reframed as a request for a primitive ("source a provisional's body
  from another leg's SDP", not "play ringback").
- **Generalise the model, don't widen the special case.** If PRBT needs the
  media leg ignored by generic relay, the fix is the **unadopted-leg gate**
  (ADR-0014) that every auxiliary leg uses — not a PRBT flag.
- **Invariants hold.** `/call/new` shape stays unchanged; the B2BUA owns and
  replicates all per-call state (opaque `activeRules[].params` + `ruleState`);
  MSCML stays opaque bytes; `activePeer` stays a 1:1 singleton.
- **Prefer opening to closing, deliberately.** It is easier to widen the public
  SDK later than to retract it, so widen with intent and version it — but widen
  with an *orthogonal primitive*, not a feature shortcut.

## Triage procedure for one complaint

For each entry in `~/complaints.md`, classify it into exactly one of:

1. **Missing public primitive** → add an orthogonal primitive to the rule SDK
   (e.g. read a sibling leg's last SDP; observe an in-dialog INFO). Generalise the
   name and shape so it is not about PRBT.
2. **Context too narrow** → widen the narrowed `RuleContext` minimally, only with
   data any extension could need.
3. **Internal leaking through** → an internal action/behaviour is forcing the
   dogfood to depend on private surface. Either promote a *generalised* slice of
   it to public, or fix the abstraction so the dogfood never needs it.
4. **Model/gate gap** → a leg-model or adoption-gate shortcoming (ADR-0014). Fix
   the gate for all leg kinds.
5. **Documentation gap** → the capability exists; the doc didn't show it. Fix the
   doc; no code.
6. **Genuinely PRBT-specific** → it does **not** belong in core at all. It stays
   in the dogfood project (its descriptor schema, its MSCML payloads, its rule
   logic). Saying "no, that lives in your extension" is a valid and frequent
   resolution.

Record the chosen class and the generalised resolution back in `~/complaints.md`
so the reasoning is auditable.

### Closing the loop — mandatory

**Once a complaint is addressed, you MUST update `~/complaints.md`** in the same
change that resolves it. Do not leave a fixed complaint open. Closing an entry
means:

- flip the **status token in the heading** from `NEW` (or `IN-PROGRESS`) to
  `RESOLVED`, or to `WONTFIX-stays-in-dogfood` for a deliberate push-back;
- add a **`### resolution`** block stating the *generalised* change and exactly
  where it landed — the ADR it implemented/amended, the rule-SDK surface it
  added, and the **sipjsserver commit** that carries it (or, for a push-back, the
  reason it stays in the dogfood);
- confirm the fix was framed as a capability, not as PRBT.

A complaint is only `RESOLVED` when the dogfood has bumped its sipjsserver
pointer (submodule commit / symlinked source) to the resolving commit and its
tests pass against it. Until then it stays `NEW`/`IN-PROGRESS`. The same
discipline applies to a rejected complaint: mark it `WONTFIX-stays-in-dogfood`
with the reason so it is not re-raised.

## What lives where (the "no" list matters as much as the "yes")

| Belongs in the **dogfood** (`~/pprbt`) | Belongs in **core** (sipjsserver) |
|---|---|
| PRBT rule logic / state machine | Orthogonal public primitives (leg create/destroy, send-request-to-leg + opaque body, respond, relay/transform, timers, ruleState, terminate) |
| MSCML payloads (opaque to core) | The leg model (`kind`, adoption gate, 1:1 `activePeer`) |
| The `/call/new` descriptor *schema* it authors | The rule SDK entrypoint + narrowed `RuleContext` |
| Its e2e tests + reports | Framework cleanup/keepalive guarantees |

If a complaint would move something from the left column into core *as PRBT*, it
is mis-triaged — re-derive the general capability or push it back to the dogfood.

## `~/complaints.md` format

One entry per complaint; append-only; status flipped and a `### resolution` added
in place when closed. The first dogfood (PRBT) has already filed its initial
findings in this file — they are the live triage queue for this process.

```md
## <kebab-slug> - <critical|high|medium|low> - <NEW|IN-PROGRESS|RESOLVED|WONTFIX-stays-in-dogfood>

### issue
<what the integrator could not do against the public SDK — symptom + evidence>

### suggested fix

<the prbt view on how to fix the issue, only to be considered if in agreeement wih how we vie the issue>

### fix
<the generalised capability + the orthogonal change proposed (not a PRBT feature)>

### resolution        # added only when closing
<the generalised change as landed: ADR implemented/amended, rule-SDK surface
 added, and the sipjsserver commit that carries it — or why it stays in the dogfood>
```

The generalised framing is the heart of every entry: if the `### fix` /
`### resolution` still reads as "make PRBT work" rather than "give every
extension capability X," it has not been generalised yet.
