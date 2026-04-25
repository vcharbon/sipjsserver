/**
 * Effect Schema for ServiceCase JSON files. Used to parse and validate
 * `tests/service-cases/*.json` at load time so missing/extra fields fail
 * loudly with structured errors instead of silently propagating undefined.
 */

import { Effect, Schema } from "effect"
import type { ServiceCase } from "./types.js"

const CheckSchema = Schema.Union([
  Schema.Struct({ eq: Schema.String }),
  Schema.Struct({ regex: Schema.String }),
])

const HeaderMapSchema = Schema.Record(Schema.String, Schema.String)
const HeaderCheckMapSchema = Schema.Record(Schema.String, CheckSchema)

const AliceSchema = Schema.Struct({
  name: Schema.String,
  content: Schema.Struct({
    fromUri: Schema.String,
    toUri: Schema.String,
    requestUri: Schema.String,
    headers: Schema.optional(HeaderMapSchema),
  }),
  checks: Schema.optional(
    Schema.Struct({
      inviteTo: Schema.optional(CheckSchema),
      inviteFrom: Schema.optional(CheckSchema),
      inviteRuri: Schema.optional(CheckSchema),
      responseHeaders: Schema.optional(HeaderCheckMapSchema),
    })
  ),
})

const LegSchema = Schema.Struct({
  name: Schema.String,
  checks: Schema.optional(
    Schema.Struct({
      inviteTo: Schema.optional(CheckSchema),
      inviteFrom: Schema.optional(CheckSchema),
      inviteRuri: Schema.optional(CheckSchema),
      inviteHeaders: Schema.optional(HeaderCheckMapSchema),
    })
  ),
})

export const ServiceCaseSchema = Schema.Struct({
  id: Schema.String,
  description: Schema.optional(Schema.String),
  alices: Schema.Array(AliceSchema),
  legs: Schema.Array(LegSchema),
  disableRules: Schema.optional(Schema.Array(Schema.String)),
  expectViolations: Schema.optional(Schema.Array(Schema.String)),
})

export const decodeServiceCase = (json: unknown): Effect.Effect<ServiceCase, Error> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(ServiceCaseSchema)(json),
    (issue) => new Error(`Invalid ServiceCase JSON: ${String(issue)}`)
  ) as Effect.Effect<ServiceCase, Error>
