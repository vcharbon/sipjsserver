/**
 * Rule-action ADTs (Slice A of the rule-framework refactor).
 *
 * These types give rules a typed, declarative vocabulary for expressing
 * URI / body / header transformations. Later slices migrate the
 * untyped `updateBody` / `updateHeaders` / `newRuri` fields off
 * `RuleAction.create-leg` to use the shapes in this file.
 *
 * See docs/todos/RULE-FRAMEWORK-ADT-REFACTOR.md for the full design.
 */

// ── Branded URI types ─────────────────────────────────────────────────────
//
// Two distinct SIP URI grammars, each trapping the other:
//
//   BareSipUri — an addr-spec with no angle brackets, no display name, no
//     header parameters. Used as a Request-URI slot on outbound requests.
//     Example: `sip:charlie@127.0.0.1:5667;transport=udp`
//
//   NameAddr  — `[display-name] LAQUOT addr-spec RAQUOT *( SEMI gen-param )`.
//     Used as the value of From / To / Refer-To / Diversion / Contact.
//     Example: `"Charlie" <sip:charlie@127.0.0.1:5667>;tag=abc123`
//
// Rationale: a `newRuri: string` slot that accepts either form silently
// ships `<sip:bob@...>` text into a Request-URI. Branding prevents that
// at compile time; conversions must go through the factories in
// `./factories.ts` (no bare `as` casts allowed).

export type BareSipUri = string & { readonly __brand: "bare-sip-uri" }

export type NameAddr = string & { readonly __brand: "name-addr" }

// ── Body update ───────────────────────────────────────────────────────────
//
// Replaces the tri-state `body?: Uint8Array | null` slot (where
// `undefined` meant "inherit", `null` meant "drop", and a value meant
// "replace"). The discriminated union removes the ambiguity.

export type BodyUpdate =
  | { readonly kind: "inherit" }                      // reuse the snapshot / source body
  | { readonly kind: "set"; readonly value: Uint8Array } // replace with explicit bytes
  | { readonly kind: "drop" }                          // force empty body, Content-Length: 0

// ── URI update ────────────────────────────────────────────────────────────
//
// Applies to the Request-URI of a generated outbound request (initially
// only `create-leg` INVITE, later all request-producing actions).

export type RuriOp =
  | { readonly kind: "inherit" }                          // reuse caller's original Request-URI
  | { readonly kind: "set"; readonly value: BareSipUri }  // override with a bare SIP URI

// ── Header name (well-known vs proprietary) ───────────────────────────────
//
// `HeaderName` is discriminated so that the `H` factory can give
// autocomplete + typo safety for RFC 3261 and common-extension headers,
// while `custom()` is an escape hatch for proprietary X-* / P-* names.
// `custom("From")` etc. throw at construction (see factories.ts) so a
// known-header name can never sneak in through the proprietary door.

export type KnownHeader =
  | "From" | "To" | "Call-ID" | "CSeq" | "Via" | "Contact"
  | "Content-Type" | "Content-Length" | "Max-Forwards" | "Expires"
  | "Route" | "Record-Route" | "Supported" | "Require"
  | "Refer-To" | "Refer-Sub" | "Referred-By" | "Replaces"
  | "Diversion" | "History-Info" | "P-Asserted-Identity" | "P-Preferred-Identity"
  | "Subject" | "User-Agent" | "Allow" | "Event" | "Subscription-State"
  | "RAck" | "RSeq"

export type HeaderName =
  | { readonly kind: "well-known"; readonly name: KnownHeader }
  | { readonly kind: "proprietary"; readonly name: string } // already lowercased

// ── Header updates ────────────────────────────────────────────────────────
//
// Declarative *final-state* per header rather than an op-list. A rule
// reads the source values via `readHeaders(...)`, computes the full list
// it wants on the outbound message, and emits a `replace(...)` — handling
// multi-valued headers (Diversion, Supported, Via) cleanly and keeping
// ordering explicit. `remove` erases all occurrences.

export type HeaderUpdate =
  | { readonly kind: "replace"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "remove" }

export type HeaderUpdates = ReadonlyMap<HeaderName, HeaderUpdate>
