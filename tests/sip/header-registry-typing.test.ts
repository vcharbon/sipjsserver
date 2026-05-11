/**
 * Compile-time type assertions for `getHeader<K>(name)`. Runs under
 * vitest only for gating; the actual checks are evaluated at typecheck
 * time. If a typed return value drifts (e.g. someone widens `'from'`
 * back to `| undefined`) this file stops compiling.
 *
 * All assertions use the type-only `expectTypeOf<T>()` form so we never
 * touch runtime values — there are no real messages here.
 */

import { describe, test, expectTypeOf } from "vitest"
import type { Result } from "effect"
import type {
  SipMessage,
  SipRequest,
  SipResponse,
  InDialogRequest,
  SipResponseTagged,
  ParsedNameAddrField,
  ParsedCSeqField,
  ParsedContactField,
  ParsedViaField,
  ParsedRequestUriField,
  TaggedNameAddrField,
  NonEmptyReadonlyArray,
} from "../../src/sip/types.js"
import type {
  ParsedNameAddr,
  ParsedRack,
  ParsedReferTo,
} from "../../src/sip/parsers/custom/structured-headers.js"
import type { SipParseError } from "../../src/sip/parsers/errors.js"

// Typed helpers — extract the call-result type for getHeader<key> on M.
type Get<M extends { getHeader: (name: never) => unknown }, K extends string> =
  ReturnType<Extract<M["getHeader"], (name: K) => unknown>>

describe("getHeader<K> typed returns", () => {
  test("mandatory eager headers — plain T, no | undefined", () => {
    expectTypeOf<Get<SipMessage, "from">>().toEqualTypeOf<ParsedNameAddrField>()
    expectTypeOf<Get<SipMessage, "to">>().toEqualTypeOf<ParsedNameAddrField>()
    expectTypeOf<Get<SipMessage, "call-id">>().toEqualTypeOf<string>()
    expectTypeOf<Get<SipMessage, "cseq">>().toEqualTypeOf<ParsedCSeqField>()
  })

  test("Via is a NonEmptyReadonlyArray; [0] is ParsedViaField (not undefined)", () => {
    expectTypeOf<Get<SipMessage, "via">>().toEqualTypeOf<NonEmptyReadonlyArray<ParsedViaField>>()
    // Critical: under noUncheckedIndexedAccess the tuple shape preserves [0] being T.
    expectTypeOf<Get<SipMessage, "via">[0]>().toEqualTypeOf<ParsedViaField>()
  })

  test("optional eager headers carry | undefined", () => {
    expectTypeOf<Get<SipMessage, "contact">>().toEqualTypeOf<ParsedContactField | undefined>()
  })

  test("lazy headers stay Result-typed", () => {
    expectTypeOf<Get<SipMessage, "p-asserted-identity">>()
      .toEqualTypeOf<Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>>()
    expectTypeOf<Get<SipMessage, "diversion">>()
      .toEqualTypeOf<Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>>()
    expectTypeOf<Get<SipMessage, "history-info">>()
      .toEqualTypeOf<Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>>()
    expectTypeOf<Get<SipMessage, "geolocation-routing">>()
      .toEqualTypeOf<Result.Result<boolean | undefined, SipParseError>>()
    expectTypeOf<Get<SipMessage, "rack">>()
      .toEqualTypeOf<Result.Result<ParsedRack | undefined, SipParseError>>()
    expectTypeOf<Get<SipMessage, "refer-to">>()
      .toEqualTypeOf<Result.Result<ParsedReferTo | undefined, SipParseError>>()
  })

  test("unknown header name falls through to ReadonlyArray<string>", () => {
    expectTypeOf<ReturnType<SipMessage["getHeader"]>>().toMatchTypeOf<
      ParsedNameAddrField | ParsedContactField | undefined | ReadonlyArray<string> |
      NonEmptyReadonlyArray<ParsedViaField> | ParsedCSeqField | string |
      Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError> |
      Result.Result<boolean | undefined, SipParseError> |
      Result.Result<ParsedRack | undefined, SipParseError> |
      Result.Result<ParsedReferTo | undefined, SipParseError>
    >()
  })
})

describe("narrowed message subtypes preserve tag-narrowing through getHeader", () => {
  test("InDialogRequest.getHeader('from'|'to') returns TaggedNameAddrField (tag: string)", () => {
    expectTypeOf<Get<InDialogRequest, "from">>().toEqualTypeOf<TaggedNameAddrField>()
    expectTypeOf<Get<InDialogRequest, "to">>().toEqualTypeOf<TaggedNameAddrField>()
    // Sanity: the narrowed access exposes a non-undefined tag.
    expectTypeOf<Get<InDialogRequest, "from">["tag"]>().toEqualTypeOf<string>()
    expectTypeOf<Get<InDialogRequest, "to">["tag"]>().toEqualTypeOf<string>()
  })

  test("non-narrowed keys on InDialogRequest stay at base types", () => {
    expectTypeOf<Get<InDialogRequest, "call-id">>().toEqualTypeOf<string>()
    expectTypeOf<Get<InDialogRequest, "via">>().toEqualTypeOf<NonEmptyReadonlyArray<ParsedViaField>>()
  })

  test("SipResponseTagged.getHeader('to') returns TaggedNameAddrField", () => {
    expectTypeOf<Get<SipResponseTagged, "to">>().toEqualTypeOf<TaggedNameAddrField>()
    expectTypeOf<Get<SipResponseTagged, "to">["tag"]>().toEqualTypeOf<string>()
    // From is not narrowed on response-tagged.
    expectTypeOf<Get<SipResponseTagged, "from">>().toEqualTypeOf<ParsedNameAddrField>()
  })
})

describe("top-level requestUri is on SipRequest only", () => {
  test("SipRequest carries the parsed requestUri at top level", () => {
    expectTypeOf<SipRequest["requestUri"]>().toEqualTypeOf<ParsedRequestUriField>()
    expectTypeOf<SipRequest["requestUri"]["host"]>().toEqualTypeOf<string>()
    expectTypeOf<SipRequest["requestUri"]["port"]>().toEqualTypeOf<number | undefined>()
  })
  test("SipResponse has no requestUri property", () => {
    expectTypeOf<SipResponse>().not.toHaveProperty("requestUri")
  })
})
