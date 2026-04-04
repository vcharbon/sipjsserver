/**
 * Default SDP bodies for test scenarios.
 */

/** Minimal SDP offer for an audio call. */
export function sdpOffer(ip: string = "127.0.0.1", port: number = 10000): Uint8Array {
  const sdp = [
    "v=0",
    `o=test 1 1 IN IP4 ${ip}`,
    "s=-",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP 0 8 101`,
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-16",
    "a=sendrecv",
  ].join("\r\n") + "\r\n"
  return new TextEncoder().encode(sdp)
}

/** Minimal SDP answer for an audio call. */
export function sdpAnswer(ip: string = "127.0.0.1", port: number = 20000): Uint8Array {
  const sdp = [
    "v=0",
    `o=test 2 2 IN IP4 ${ip}`,
    "s=-",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP 0 8`,
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:8 PCMA/8000",
    "a=sendrecv",
  ].join("\r\n") + "\r\n"
  return new TextEncoder().encode(sdp)
}
