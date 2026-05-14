/**
 * Unit tests for the pure helpers in TargetAdmission.
 *
 * The applyRoute / ActionExecutor wiring is covered separately with
 * end-to-end-style tests that hit the full decision pipeline.
 */

import { describe, expect, it } from "vitest"
import {
  classifyAdmission,
  isAllowedSuffix,
  isIpLiteral,
} from "../../src/b2bua/TargetAdmission.js"

describe("isIpLiteral", () => {
  it("accepts IPv4 literals", () => {
    expect(isIpLiteral("10.0.0.1")).toBe(true)
    expect(isIpLiteral("127.0.0.1")).toBe(true)
    expect(isIpLiteral("172.20.255.250")).toBe(true)
  })

  it("accepts IPv6 literals (bare and bracketed)", () => {
    expect(isIpLiteral("::1")).toBe(true)
    expect(isIpLiteral("[::1]")).toBe(true)
    expect(isIpLiteral("fe80::1")).toBe(true)
    expect(isIpLiteral("[2001:db8::1]")).toBe(true)
  })

  it("rejects hostnames", () => {
    expect(isIpLiteral("kindlab")).toBe(false)
    expect(isIpLiteral("worker-0.b2bua.svc.cluster.local")).toBe(false)
    expect(isIpLiteral("example.com")).toBe(false)
  })

  it("rejects malformed strings", () => {
    expect(isIpLiteral("")).toBe(false)
    expect(isIpLiteral("not.an.ip")).toBe(false)
    expect(isIpLiteral("999.999.999.999")).toBe(false)
    expect(isIpLiteral("[broken")).toBe(false)
  })
})

describe("isAllowedSuffix", () => {
  it("matches case-insensitively", () => {
    expect(isAllowedSuffix("worker.svc.cluster.local", [".svc.cluster.local"])).toBe(true)
    expect(isAllowedSuffix("WORKER.SVC.CLUSTER.LOCAL", [".svc.cluster.local"])).toBe(true)
  })

  it("requires the suffix to actually match the tail", () => {
    expect(isAllowedSuffix("example.com", [".svc.cluster.local"])).toBe(false)
    expect(isAllowedSuffix("svc.cluster.local.evil.com", [".svc.cluster.local"])).toBe(false)
  })

  it("treats `*` as wildcard regardless of host", () => {
    expect(isAllowedSuffix("kindlab", ["*"])).toBe(true)
    expect(isAllowedSuffix("anything.example", ["*"])).toBe(true)
    expect(isAllowedSuffix("", ["*"])).toBe(true)
  })

  it("supports multiple suffixes", () => {
    const list = [".svc.cluster.local", ".example.test"]
    expect(isAllowedSuffix("a.svc.cluster.local", list)).toBe(true)
    expect(isAllowedSuffix("b.example.test", list)).toBe(true)
    expect(isAllowedSuffix("c.elsewhere", list)).toBe(false)
  })

  it("empty list rejects everything", () => {
    expect(isAllowedSuffix("anything", [])).toBe(false)
  })
})

describe("classifyAdmission", () => {
  it("returns ip-literal for IP hosts (regardless of suffix list)", () => {
    expect(classifyAdmission("10.0.0.1", [])).toBe("ip-literal")
    expect(classifyAdmission("[::1]", [".svc.cluster.local"])).toBe("ip-literal")
  })

  it("returns allow-listed when the suffix matches", () => {
    expect(
      classifyAdmission("worker.svc.cluster.local", [".svc.cluster.local"]),
    ).toBe("allow-listed")
  })

  it("returns reject for non-IP, non-matching hostnames", () => {
    expect(classifyAdmission("kindlab", [".svc.cluster.local"])).toBe("reject")
    expect(classifyAdmission("example.com", [".svc.cluster.local"])).toBe("reject")
  })

  it("`*` wildcard short-circuits to allow-listed for non-IP", () => {
    expect(classifyAdmission("kindlab", ["*"])).toBe("allow-listed")
  })
})
