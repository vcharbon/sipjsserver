const { Encoder, Unpackr } = require("msgpackr");

// Construct a maximally-populated Call fixture covering every nested shape.
function makeFixtureCall() {
  const sipHeader = (name, value) => ({ name, value });
  const stackDialog = {
    callId: "c-1",
    localTag: "l1",
    remoteTag: "r1",
    localUri: "sip:l@host",
    remoteUri: "sip:r@host",
    remoteTarget: "sip:rt@host",
    localCSeq: 1,
    routeSet: ["sip:rr1@host"],
  };
  const pendingRequest = {
    method: "INVITE",
    outboundCSeq: 2,
    inboundCSeq: 1,
    sourceVias: ["SIP/2.0/UDP 1.2.3.4;branch=z9hG4bK"],
    sourceCallId: "c-1",
    sourceFrom: "sip:a",
    sourceTo: "sip:b",
    direction: "from-a",
  };
  const inviteTxnHandle = {
    kind: "invite",
    branch: "z9hG4bK1",
    originalInvite: null,
    destination: { host: "host", port: 5060 },
  };
  const b2buaDialogExt = {
    remoteCSeq: 1,
    inboundPendingRequests: [pendingRequest],
    ackBranch: "z9hG4bK-ack",
    pendingInviteTxn: inviteTxnHandle,
    cachedSdp: Buffer.from([1, 2, 3]),
  };
  const dialog = { sip: stackDialog, ext: b2buaDialogExt };
  const remoteInfo = { address: "1.2.3.4", port: 5060 };
  const leg = {
    legId: "a",
    callId: "c-1",
    fromTag: "ft",
    source: remoteInfo,
    state: "confirmed",
    disposition: "bridged",
    dialogs: [dialog],
    noAnswerTimeoutSec: 30,
    byeDisposition: "bye_sent",
    localUri: "sip:l@host",
    remoteUri: "sip:r@host",
    inviteRequestUri: "sip:i@host",
    pendingInviteTxn: inviteTxnHandle,
  };
  const timerEntry = { id: "t1", type: "terminating_timeout", fireAt: 1, legId: "a" };
  const limiterEntry = { limiterId: "L", limit: 10, originWindow: 1, incrementSucceeded: true };
  const cdrEvent = { type: "invite_received", timestamp: 1, legId: "a", statusCode: 200, reason: "OK" };
  const tagMap = { aTag: "at", bLegId: "b-1", bTag: "bt" };
  const aLegInvite = {
    uri: "sip:dest@host",
    headers: [sipHeader("From", "x"), sipHeader("To", "y")],
    body: Buffer.from([0]),
  };
  const topology = { pri: "0", bak: "1", gen: 5 };
  const activeRule = { id: "rule1", params: {}, active: true };
  const ruleState = { ruleId: "rule1", state: {} };
  const transfer = {
    phase: "refer-authorizing",
    referrerLegId: "b-1",
    referToUri: "sip:c",
    effectiveReferToUri: "sip:c2",
    callbackContext: "ctx",
    cLegId: "c-1",
    referCSeq: 3,
    startedAtMs: 1,
    lastCLegNotifiedStatus: 180,
    cInitialSdp: Buffer.from([0]),
  };
  const earlyPromote = {
    promotedSdp: Buffer.from([0]),
    windowOpen: true,
    resyncReinviteCSeq: 5,
  };

  return {
    callRef: "ref",
    aLeg: leg,
    bLegs: [leg, leg],
    activePeer: { legA: "a", legB: "b-1" },
    callbackContext: "ctx",
    billingContext: "bill",
    aLegInvite,
    limiterEntries: [limiterEntry],
    timers: [timerEntry],
    cdrEvents: [cdrEvent],
    state: "active",
    createdAt: 1,
    aLegPendingVias: ["SIP/2.0/UDP 1.2.3.4;branch=z9hG4bK"],
    aLegPendingCSeq: 1,
    tagMap: [tagMap],
    traceId: "t",
    rootSpanId: "s",
    sampled: true,
    workerIndex: 0,
    _topology: topology,
    emergency: true,
    features: { failoverAllowed: true },
    policyUpdateHeaders: { "X-Foo": "bar" },
    policyUpdateBody: Buffer.from([0]),
    activeRules: [activeRule],
    ruleState: [ruleState],
    transfer,
    earlyPromote,
    messageCount: 14,
  };
}

const structures = [];
const enc = new Encoder({ useRecords: true, structures, copyBuffers: true, encodeUndefinedAsNil: false });
const fixture = makeFixtureCall();
const buf = enc.pack(fixture);
console.log("encoded fixture: " + buf.length + " bytes");
console.log("learned " + structures.length + " structures:");
for (let i = 0; i < structures.length; i++) {
  console.log("  #" + i + ":", JSON.stringify(structures[i]));
}

// Verify cross-instance decode (simulates Worker B receiving Worker A's buf)
const dec = new Unpackr({ useRecords: true, structures: structures.slice(), copyBuffers: true });
const decoded = dec.unpack(buf);
console.log("");
console.log("cross-instance decode callRef:", decoded.callRef);
console.log("cross-instance decode messageCount:", decoded.messageCount);
console.log("cross-instance decode transfer.phase:", decoded.transfer?.phase);

// Also encode a smaller Call (without all optionals) and see what happens
const partial = {
  callRef: "p",
  aLeg: { legId: "a", callId: "c", fromTag: "f", source: { address: "1", port: 1 }, state: "trying", disposition: "pending", dialogs: [] },
  bLegs: [],
  activePeer: null,
  aLegInvite: { uri: "sip:x", headers: [], body: Buffer.alloc(0) },
  limiterEntries: [],
  timers: [],
  cdrEvents: [],
  state: "active",
  createdAt: 1,
  tagMap: [],
};
const buf2 = enc.pack(partial);
console.log("");
console.log("partial-shape Call: " + buf2.length + " bytes");
console.log("structures after partial encode: " + structures.length);
