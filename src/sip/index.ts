/**
 * @vcharbon/sipjs/sip — public surface.
 *
 * Low-level SIP primitives: parser, message helpers, types, signaling
 * network. For consumers writing custom assertions or non-trivial
 * message synthesis on top of `@vcharbon/sipjs/test-harness`.
 *
 * The default parser (`customParser`) is a pure-TypeScript RFC 3261
 * parser; `jssip` is NOT wired in (it remains a dead dep slated for
 * removal). The serializer round-trips through the same shape.
 */

// Parser
export { SipParser, SipParseError } from "./Parser.js"
export { createCustomParser, customParser } from "./parsers/custom/index.js"
export type { SipParserImpl, SipParserLimits } from "./parsers/interface.js"
export { DEFAULT_SIP_PARSER_LIMITS } from "./parsers/interface.js"

// Serializer
export { serialize, sipSummary, messageSummary } from "./Serializer.js"

// Core message types
export type {
  SipHeader,
  SipHeaderTypes,
  SipMessage,
  SipRequest,
  SipResponse,
  SipResponseTagged,
  NonEmptyReadonlyArray,
  ParsedNameAddrField,
  ParsedViaField,
  ParsedContactField,
  ParsedCSeqField,
  ParsedRequestUriField,
  TaggedNameAddrField,
  InDialogRequest,
  MethodRequest,
  InDialogMethodRequest,
  B2BUAMessage,
  RemoteInfo,
  CallRecord,
} from "./types.js"

// Header registry — runtime extension entry point
export { SipHeaderRegistry, defaultRegistry } from "./header-registry.js"
export type { HeaderDescriptor } from "./header-registry.js"

// Header / URI helpers
export {
  getHeader,
  getHeaders,
  setHeader,
  removeHeader,
  extractTag,
  stripTag,
  extractNameAddrUri,
  extractContactUri,
  parseSipUri,
  extractHostPort,
  parseUriParams,
  parseViaParams,
  newBranch,
  newTag,
  newCallId,
  currentRng,
} from "./MessageHelpers.js"
export type { ParsedSipUri } from "./MessageHelpers.js"

// Structured-header parsers
export {
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseRack,
  parseReplaces,
  parseReferTo,
  parseSipUriString,
  splitTopLevelCommas,
} from "./parsers/custom/structured-headers.js"
export type {
  ParsedNameAddr,
  ParsedVia,
  ParsedContact,
  ParsedCSeq,
  ParsedRack,
  ParsedReplaces,
  ParsedReferTo,
  ParsedUri,
} from "./parsers/custom/structured-headers.js"

// Field hydration (parsed-field cache for SipMessage)
export {
  extractCommonFields,
  hydrateRequest,
  hydrateResponse,
  extractRequestFields,
  extractResponseFields,
} from "./parsers/extract-fields.js"

// Signaling network (UDP fabric service used by both b2bua and test-harness)
export { SignalingNetwork } from "./SignalingNetwork.js"
export type {
  UdpEndpoint,
  NetworkTraceEntry,
} from "./SignalingNetwork.js"
