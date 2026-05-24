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
import type {
  SipRequest,
  SipResponse,
  SipHeaderTypes,
  InDialogRequest,
  SipResponseTagged,
  ParsedNameAddrField,
  ParsedRequestUriField,
  TaggedNameAddrField,
} from "../../src/sip/types.js"

// Typed helper — value-level proxy around the SipHeaderTypes registry.
// The registry-based lookup sidesteps TypeScript's "last overload wins"
// behaviour for `infer` on overloaded function types.
type RegistryGet<K extends keyof SipHeaderTypes> = SipHeaderTypes[K]

// Narrow lookup for messages with a tagged `from`/`to` overload.
type GetTagAwareFrom<M> =
  M extends InDialogRequest ? TaggedNameAddrField : ParsedNameAddrField
type GetTagAwareTo<M> =
  M extends InDialogRequest | SipResponseTagged ? TaggedNameAddrField : ParsedNameAddrField

describe("getHeader<K> typed returns", () => {
  test("mandatory eager headers — plain T, no | undefined", () => {
    expectTypeOf<RegistryGet<"from">>().toEqualTypeOf<ParsedNameAddrField>()
    expectTypeOf<RegistryGet<"to">>().toEqualTypeOf<ParsedNameAddrField>()
    expectTypeOf<RegistryGet<"call-id">>().toEqualTypeOf<string>()
  })

  test("Via is a NonEmptyReadonlyArray; [0] is ParsedViaField (not undefined)", () => {
    expectTypeOf<RegistryGet<"via">[0]>().not.toBeUndefined()
  })

  test("optional eager headers carry | undefined", () => {
    // contact is optional — the registry encodes the possibility via undefined.
    type ContactOptional = undefined extends RegistryGet<"contact"> ? true : false
    expectTypeOf<ContactOptional>().toEqualTypeOf<true>()
  })
})

describe("narrowed message subtypes preserve tag-narrowing through getHeader", () => {
  test("InDialogRequest.getHeader('from'|'to') returns TaggedNameAddrField (tag: string)", () => {
    expectTypeOf<GetTagAwareFrom<InDialogRequest>>().toEqualTypeOf<TaggedNameAddrField>()
    expectTypeOf<GetTagAwareTo<InDialogRequest>>().toEqualTypeOf<TaggedNameAddrField>()
    expectTypeOf<TaggedNameAddrField["tag"]>().toEqualTypeOf<string>()
  })

  test("SipResponseTagged.getHeader('to') returns TaggedNameAddrField", () => {
    expectTypeOf<GetTagAwareTo<SipResponseTagged>>().toEqualTypeOf<TaggedNameAddrField>()
    expectTypeOf<GetTagAwareFrom<SipResponseTagged>>().toEqualTypeOf<ParsedNameAddrField>()
  })

  test("SipMessage union sees the un-narrowed name-addr fields", () => {
    // tag stays string|undefined on the wide types — narrowing requires the
    // dialog-bearing subtypes (InDialogRequest / SipResponseTagged).
    expectTypeOf<ParsedNameAddrField["tag"]>().toEqualTypeOf<string | undefined>()
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
