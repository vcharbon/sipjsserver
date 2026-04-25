/**
 * ServiceCase — the data-driven layer orthogonal to scenario flow shape.
 *
 * A scenario describes "what happens" (INVITE → 180 → 200 → ACK → BYE).
 * A ServiceCase describes "with what content" (alice number 555-1212 dials
 * +1-800-555-0100, B2BUA stamps PAI as +1-415-555-9999, B-leg reaches
 * sip:carrier@gw.example.com, …).
 *
 * Per Q4: each ServiceCase has multiple alices (inbound callers) and
 * multiple legs (bob1, bob2, …). Per Q5: checks are literal eq or regex.
 */

/** A check vocabulary: literal string equality OR regex match. */
export type Check = { readonly eq: string } | { readonly regex: string }

/** Inbound caller ("alice"-side) — the content side of an A-leg. */
export interface ServiceCaseAlice {
  /** Logical name in the scenario (e.g. "alice", "alice2"). */
  readonly name: string
  /** Content used to populate the outgoing INVITE. */
  readonly content: {
    readonly fromUri: string
    readonly toUri: string
    readonly requestUri: string
    /** Headers stamped by alice on the initial INVITE. */
    readonly headers?: Readonly<Record<string, string>>
  }
  /** Checks asserted against messages alice sees back from the DUT. */
  readonly checks?: {
    readonly inviteTo?: Check
    readonly inviteFrom?: Check
    readonly inviteRuri?: Check
    readonly responseHeaders?: Readonly<Record<string, Check>>
  }
}

/** Outbound leg ("bob"-side) — the content side of a B-leg. */
export interface ServiceCaseLeg {
  /** Logical name in the scenario (e.g. "bob1", "bob2"). */
  readonly name: string
  /** Checks asserted on the INVITE bob sees from the DUT. */
  readonly checks?: {
    readonly inviteTo?: Check
    readonly inviteFrom?: Check
    readonly inviteRuri?: Check
    readonly inviteHeaders?: Readonly<Record<string, Check>>
  }
}

/** Top-level ServiceCase entry. */
export interface ServiceCase {
  /** Stable identifier (matches the JSON filename without extension). */
  readonly id: string
  /** Optional human-readable description. */
  readonly description?: string
  /** Inbound callers — at least one. */
  readonly alices: ReadonlyArray<ServiceCaseAlice>
  /** Outbound legs — at least one. */
  readonly legs: ReadonlyArray<ServiceCaseLeg>
  /** Names of rules to disable globally for the scenario × this case. */
  readonly disableRules?: ReadonlyArray<string>
  /** Names of rules expected to fire (inverted assertion — fail if NOT fired). */
  readonly expectViolations?: ReadonlyArray<string>
}

/** Apply a check to a candidate string. Returns null on pass, else error string. */
export function applyCheck(check: Check, value: string, label: string): string | null {
  if ("eq" in check) {
    if (value !== check.eq) {
      return `${label}: expected "${check.eq}" but got "${value}"`
    }
    return null
  }
  // regex
  let re: RegExp
  try {
    re = new RegExp(check.regex)
  } catch (err) {
    return `${label}: invalid regex "${check.regex}" (${(err as Error).message})`
  }
  if (!re.test(value)) {
    return `${label}: value "${value}" did not match /${check.regex}/`
  }
  return null
}
