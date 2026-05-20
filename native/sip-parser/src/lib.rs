//! sipjs-native-parser — napi-rs binding over rvoip-sip-core.
//!
//! Two surfaces:
//!
//! 1. `parse(buf)` (Phase 1) — synchronous parse adapter used when only the
//!    parser is being replaced. The JS side keeps owning the UDP socket.
//!
//! 2. `open_udp(opts, on_message)` (Phase 2) — opens a UDP socket on the
//!    Rust side. A tokio runtime owns the recv loop; each datagram is parsed
//!    inline and emitted to a JS callback via a `ThreadsafeFunction`. JS
//!    sees pre-parsed messages with no per-packet FFI parse hop.
//!
//! Phase 2 also exposes `send`, `close`, `metrics`, and `local_address` on
//! the returned `NativeUdpHandle` so the JS `SignalingNetwork` façade can
//! satisfy the existing `UdpEndpoint` contract.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rvoip_sip_core::parser::message::{parse_message_with_mode, ParseMode};
use rvoip_sip_core::types::Message;

// ---------------------------------------------------------------------------
// Shared types — used by both Phase 1 (parse) and Phase 2 (open_udp)
// ---------------------------------------------------------------------------

/// Wire-form header pair preserved in original order and multiplicity.
#[napi(object)]
pub struct NativeHeader {
  pub name: String,
  pub value: String,
}

/// Flat parsed message envelope returned to JS.
#[napi(object)]
pub struct NativeParsedMessage {
  pub kind: String,
  pub version: String,
  pub method: Option<String>,
  pub uri: Option<String>,
  pub status: Option<u32>,
  pub reason: Option<String>,
  pub headers: Vec<NativeHeader>,
  pub body: Buffer,
}

// Internal Send-safe mirror of NativeParsedMessage. ThreadsafeFunction
// values must cross the tokio→libuv boundary, where `Buffer` (which holds a
// non-Send V8 ref) can't survive. We carry plain `Vec<u8>` here and convert
// to `Buffer` inside the TSFN callback (which runs on the libuv thread).
struct ParsedEnvelope {
  kind: &'static str,
  version: String,
  method: Option<String>,
  uri: Option<String>,
  status: Option<u32>,
  reason: Option<String>,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Phase 1 surface — synchronous parse
// ---------------------------------------------------------------------------

#[napi]
pub fn parse(buf: Buffer) -> Result<NativeParsedMessage> {
  let bytes: &[u8] = &buf;
  parse_envelope(bytes).map(envelope_to_napi)
}

/// Parse `bytes` into a Send-safe envelope. Used by both the sync `parse`
/// export and the Phase 2 recv loop.
fn parse_envelope(bytes: &[u8]) -> Result<ParsedEnvelope> {
  // Lexical gate — rvoip strict parse must succeed.
  let msg = parse_message_with_mode(bytes, ParseMode::Strict)
    .map_err(|e| Error::new(Status::GenericFailure, format!("{}", e)))?;

  let (kind, is_request, body_bytes) = match msg {
    Message::Request(req) => ("request", true, req.body.to_vec()),
    Message::Response(resp) => ("response", false, resp.body.to_vec()),
  };

  let start = extract_wire_start_line(bytes, is_request)
    .map_err(|e| Error::new(Status::GenericFailure, format!("wire start-line: {}", e)))?;
  let headers = extract_wire_headers(bytes)
    .map_err(|e| Error::new(Status::GenericFailure, format!("wire header scan: {}", e)))?;

  Ok(ParsedEnvelope {
    kind,
    version: start.version,
    method: start.method,
    uri: start.uri,
    status: start.status,
    reason: start.reason,
    headers,
    body: body_bytes,
  })
}

fn envelope_to_napi(env: ParsedEnvelope) -> NativeParsedMessage {
  NativeParsedMessage {
    kind: env.kind.to_string(),
    version: env.version,
    method: env.method,
    uri: env.uri,
    status: env.status,
    reason: env.reason,
    headers: env
      .headers
      .into_iter()
      .map(|(name, value)| NativeHeader { name, value })
      .collect(),
    body: Buffer::from(env.body),
  }
}

struct WireStartLine {
  version: String,
  method: Option<String>,
  uri: Option<String>,
  status: Option<u32>,
  reason: Option<String>,
}

fn extract_wire_start_line(
  buf: &[u8],
  is_request: bool,
) -> std::result::Result<WireStartLine, String> {
  let end = match find_crlf(buf, 0) {
    Some(p) => p,
    None => return Err("missing CRLF after start line".into()),
  };
  let line = &buf[..end];

  if is_request {
    let first_sp = match line.iter().position(|&c| c == b' ') {
      Some(p) => p,
      None => return Err("request-line missing first SP".into()),
    };
    let last_sp = match line.iter().rposition(|&c| c == b' ') {
      Some(p) => p,
      None => return Err("request-line missing trailing SP".into()),
    };
    if last_sp <= first_sp {
      return Err("request-line malformed token layout".into());
    }
    Ok(WireStartLine {
      version: String::from_utf8_lossy(&line[last_sp + 1..]).into_owned(),
      method: Some(String::from_utf8_lossy(&line[..first_sp]).into_owned()),
      uri: Some(String::from_utf8_lossy(&line[first_sp + 1..last_sp]).into_owned()),
      status: None,
      reason: None,
    })
  } else {
    let first_sp = match line.iter().position(|&c| c == b' ') {
      Some(p) => p,
      None => return Err("status-line missing first SP".into()),
    };
    let second_sp = match line[first_sp + 1..].iter().position(|&c| c == b' ') {
      Some(p) => first_sp + 1 + p,
      None => return Err("status-line missing second SP".into()),
    };
    let status_str = std::str::from_utf8(&line[first_sp + 1..second_sp])
      .map_err(|_| "status-code not UTF-8")?;
    let status: u32 = status_str.parse().map_err(|_| "status-code not numeric")?;
    Ok(WireStartLine {
      version: String::from_utf8_lossy(&line[..first_sp]).into_owned(),
      method: None,
      uri: None,
      status: Some(status),
      reason: Some(String::from_utf8_lossy(&line[second_sp + 1..]).into_owned()),
    })
  }
}

fn extract_wire_headers(buf: &[u8]) -> std::result::Result<Vec<(String, String)>, String> {
  let start_end = match find_crlf(buf, 0) {
    Some(p) => p,
    None => return Err("missing CRLF after start line".into()),
  };
  let mut i = start_end + 2;

  let mut out: Vec<(String, String)> = Vec::new();
  let mut last_value: Option<Vec<u8>> = None;
  let mut last_name: Option<String> = None;

  while i < buf.len() {
    if i + 1 < buf.len() && buf[i] == b'\r' && buf[i + 1] == b'\n' {
      break;
    }
    if buf[i] == b' ' || buf[i] == b'\t' {
      let line_end = match find_crlf(buf, i) {
        Some(p) => p,
        None => return Err("unterminated continuation line".into()),
      };
      if let Some(prev) = last_value.as_mut() {
        prev.push(b' ');
        let mut j = i;
        while j < line_end && (buf[j] == b' ' || buf[j] == b'\t') {
          j += 1;
        }
        prev.extend_from_slice(&buf[j..line_end]);
      }
      i = line_end + 2;
      continue;
    }

    if let (Some(name), Some(value)) = (last_name.take(), last_value.take()) {
      out.push((name, String::from_utf8_lossy(&value).into_owned()));
    }

    let line_end = match find_crlf(buf, i) {
      Some(p) => p,
      None => return Err("unterminated header line".into()),
    };
    let colon_idx = match buf[i..line_end].iter().position(|&c| c == b':') {
      Some(p) => i + p,
      None => return Err(format!("header line missing colon at offset {}", i)),
    };
    let name_bytes = trim_ows(&buf[i..colon_idx]);
    let name = String::from_utf8_lossy(name_bytes).into_owned();
    let value_bytes = trim_ows(&buf[colon_idx + 1..line_end]);

    last_name = Some(name);
    last_value = Some(value_bytes.to_vec());
    i = line_end + 2;
  }

  if let (Some(name), Some(value)) = (last_name.take(), last_value.take()) {
    out.push((name, String::from_utf8_lossy(&value).into_owned()));
  }

  Ok(out)
}

fn find_crlf(buf: &[u8], start: usize) -> Option<usize> {
  let mut i = start;
  while i + 1 < buf.len() {
    if buf[i] == b'\r' && buf[i + 1] == b'\n' {
      return Some(i);
    }
    i += 1;
  }
  None
}

fn trim_ows(slice: &[u8]) -> &[u8] {
  let mut start = 0;
  while start < slice.len() && (slice[start] == b' ' || slice[start] == b'\t') {
    start += 1;
  }
  let mut end = slice.len();
  while end > start && (slice[end - 1] == b' ' || slice[end - 1] == b'\t') {
    end -= 1;
  }
  &slice[start..end]
}

// ---------------------------------------------------------------------------
// Phase 2 surface — native UDP socket ownership
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct NativeUdpOpenOpts {
  pub ip: String,
  pub port: u32,
  /// Currently advisory — used for metrics & future brake. The actual JS-side
  /// queue cap lives on the JS façade.
  pub queue_max: u32,
}

#[napi(object)]
pub struct NativeUdpLocalAddress {
  pub ip: String,
  pub port: u32,
}

#[napi(object)]
pub struct NativeUdpMetrics {
  /// Total packets pushed to the JS callback since open.
  pub packets_received: u32,
  /// Total `send` calls that resulted in a UDP send.
  pub packets_sent: u32,
  /// Packets that rvoip-strict-parse rejected pre-emit.
  pub parse_drops: u32,
  /// Tier-1 brake: dropped INVITEs (Phase 2B; always 0 in Phase 2A).
  pub drops_tier1_brake: u32,
  /// Tier-1 brake: stateless 503 responses sent back (Phase 2B; always 0 in Phase 2A).
  pub tier1_reject_sent: u32,
}

/// JS-facing recv payload. One per accepted datagram.
#[napi(object)]
pub struct NativeRecvPacket {
  pub raw: Buffer,
  pub remote_address: String,
  pub remote_port: u32,
  pub arrival_ms: f64,
  pub parsed: NativeParsedMessage,
}

// Send-safe packet representation for the tsfn channel. Public only so it
// can appear in `open_udp`'s signature; the TS side sees the
// `NativeRecvPacket` shape produced by the `ToNapiValue` impl below.
pub struct RecvEmit {
  raw: Vec<u8>,
  remote_address: String,
  remote_port: u16,
  arrival_ms: f64,
  parsed: ParsedEnvelope,
}

struct UdpMetricsInner {
  packets_received: AtomicU64,
  packets_sent: AtomicU64,
  parse_drops: AtomicU64,
  drops_tier1_brake: AtomicU64,
  tier1_reject_sent: AtomicU64,
}

impl UdpMetricsInner {
  fn new() -> Self {
    Self {
      packets_received: AtomicU64::new(0),
      packets_sent: AtomicU64::new(0),
      parse_drops: AtomicU64::new(0),
      drops_tier1_brake: AtomicU64::new(0),
      tier1_reject_sent: AtomicU64::new(0),
    }
  }

  fn snapshot(&self) -> NativeUdpMetrics {
    NativeUdpMetrics {
      packets_received: self.packets_received.load(Ordering::Relaxed).min(u32::MAX as u64) as u32,
      packets_sent: self.packets_sent.load(Ordering::Relaxed).min(u32::MAX as u64) as u32,
      parse_drops: self.parse_drops.load(Ordering::Relaxed).min(u32::MAX as u64) as u32,
      drops_tier1_brake: self
        .drops_tier1_brake
        .load(Ordering::Relaxed)
        .min(u32::MAX as u64) as u32,
      tier1_reject_sent: self
        .tier1_reject_sent
        .load(Ordering::Relaxed)
        .min(u32::MAX as u64) as u32,
    }
  }
}

struct UdpInner {
  socket: Arc<tokio::net::UdpSocket>,
  local_addr: SocketAddr,
  metrics: Arc<UdpMetricsInner>,
  closed: Arc<AtomicBool>,
  runtime: tokio::runtime::Runtime,
}

#[napi]
pub struct NativeUdpHandle {
  inner: Option<Arc<UdpInner>>,
}

#[napi]
impl NativeUdpHandle {
  /// Synchronous best-effort send. The UDP socket itself is non-blocking,
  /// so this returns immediately once the kernel accepts the packet (or
  /// errors). Symmetric with the JS `dgram.send` semantics the existing
  /// `UdpEndpoint.send` exposes.
  #[napi]
  pub fn send(&self, buf: Buffer, port: u32, address: String) -> Result<()> {
    let inner = self
      .inner
      .as_ref()
      .ok_or_else(|| Error::new(Status::GenericFailure, "handle closed"))?;
    let dest: SocketAddr = format!("{}:{}", address, port).parse().map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("invalid send address {}:{} — {}", address, port, e),
      )
    })?;
    let socket = inner.socket.clone();
    let bytes = buf.to_vec();
    // Block on the tokio runtime so the JS caller observes the same
    // "send completed (or errored)" semantics as dgram's callback API.
    inner.runtime.block_on(async move {
      socket
        .send_to(&bytes, dest)
        .await
        .map_err(|e| Error::new(Status::GenericFailure, format!("send_to: {}", e)))
    })?;
    inner.metrics.packets_sent.fetch_add(1, Ordering::Relaxed);
    Ok(())
  }

  #[napi]
  pub fn close(&mut self) -> Result<()> {
    if let Some(inner) = self.inner.take() {
      inner.closed.store(true, Ordering::Relaxed);
      // Dropping the Arc<UdpInner> when refcount hits zero will drop the
      // runtime, which signals the recv task to stop via its `closed`
      // check and shuts down worker threads. The socket Arc is held by
      // the recv task; once it exits the socket FD is released.
    }
    Ok(())
  }

  #[napi]
  pub fn metrics(&self) -> NativeUdpMetrics {
    match &self.inner {
      Some(inner) => inner.metrics.snapshot(),
      None => UdpMetricsInner::new().snapshot(),
    }
  }

  #[napi]
  pub fn local_address(&self) -> Result<NativeUdpLocalAddress> {
    let inner = self
      .inner
      .as_ref()
      .ok_or_else(|| Error::new(Status::GenericFailure, "handle closed"))?;
    Ok(NativeUdpLocalAddress {
      ip: inner.local_addr.ip().to_string(),
      port: u32::from(inner.local_addr.port()),
    })
  }
}

/// Open a UDP socket on the Rust side and start the recv→parse→emit loop.
/// `on_message` is called once per accepted-and-parsed datagram on the
/// libuv main thread. Packets that fail rvoip's strict parse are counted
/// in `parse_drops` and silently dropped (no callback for them).
#[napi(ts_args_type = "opts: NativeUdpOpenOpts, onMessage: (packet: NativeRecvPacket) => void")]
pub fn open_udp(
  opts: NativeUdpOpenOpts,
  on_message: ThreadsafeFunction<RecvEmit, ErrorStrategy::Fatal>,
) -> Result<NativeUdpHandle> {
  let bind_addr: SocketAddr = format!("{}:{}", opts.ip, opts.port)
    .parse()
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("invalid bind address {}:{} — {}", opts.ip, opts.port, e),
      )
    })?;

  // Use a multi-thread runtime sized 1 worker — the recv loop is the only
  // task. Sized this small so the FFI overhead doesn't carry a thread-
  // pool tax.
  let runtime = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(1)
    .thread_name("sipjs-udp")
    .enable_all()
    .build()
    .map_err(|e| Error::new(Status::GenericFailure, format!("tokio build: {}", e)))?;

  let socket = runtime
    .block_on(async move { tokio::net::UdpSocket::bind(bind_addr).await })
    .map_err(|e| {
      Error::new(
        Status::GenericFailure,
        format!("UDP bind {}:{}: {}", opts.ip, opts.port, e),
      )
    })?;
  let local_addr = socket
    .local_addr()
    .map_err(|e| Error::new(Status::GenericFailure, format!("local_addr: {}", e)))?;
  let socket = Arc::new(socket);

  let metrics = Arc::new(UdpMetricsInner::new());
  let closed = Arc::new(AtomicBool::new(false));

  // Spawn the recv task. It runs until `closed` flips true (set by
  // NativeUdpHandle::close) or the runtime is dropped.
  {
    let socket = socket.clone();
    let metrics = metrics.clone();
    let closed = closed.clone();
    let on_message = on_message;
    runtime.spawn(async move {
      let mut buf = vec![0u8; 65_535]; // max UDP datagram
      loop {
        if closed.load(Ordering::Relaxed) {
          break;
        }
        match socket.recv_from(&mut buf).await {
          Ok((n, src)) => {
            let bytes = &buf[..n];
            match parse_envelope(bytes) {
              Ok(env) => {
                metrics.packets_received.fetch_add(1, Ordering::Relaxed);
                let emit = RecvEmit {
                  raw: bytes.to_vec(),
                  remote_address: src.ip().to_string(),
                  remote_port: src.port(),
                  arrival_ms: now_ms(),
                  parsed: env,
                };
                // NonBlocking: if the JS callback's queue is saturated,
                // packets are dropped at the boundary rather than back-
                // pressuring the recv loop. This mirrors the bounded JS
                // Queue's tail-drop semantics.
                let _ = on_message.call(emit, ThreadsafeFunctionCallMode::NonBlocking);
              }
              Err(_) => {
                metrics.parse_drops.fetch_add(1, Ordering::Relaxed);
              }
            }
          }
          Err(_) => {
            // Socket-level error — typically only at shutdown when the
            // socket FD is closed under us. Re-check `closed` and exit
            // the loop.
            if closed.load(Ordering::Relaxed) {
              break;
            }
          }
        }
      }
    });
  }

  Ok(NativeUdpHandle {
    inner: Some(Arc::new(UdpInner {
      socket,
      local_addr,
      metrics,
      closed,
      runtime,
    })),
  })
}

fn now_ms() -> f64 {
  match SystemTime::now().duration_since(UNIX_EPOCH) {
    Ok(d) => d.as_secs_f64() * 1000.0,
    Err(_) => 0.0,
  }
}

// ---------------------------------------------------------------------------
// ThreadsafeFunction value conversion — runs on the libuv main thread to
// build the JS-facing NativeRecvPacket from the Send-safe RecvEmit.
// ---------------------------------------------------------------------------

impl ToNapiValue for RecvEmit {
  unsafe fn to_napi_value(env: napi::sys::napi_env, val: Self) -> Result<napi::sys::napi_value> {
    let env_wrapper = Env::from_raw(env);
    let mut obj = env_wrapper.create_object()?;
    obj.set("raw", Buffer::from(val.raw))?;
    obj.set("remoteAddress", val.remote_address)?;
    obj.set("remotePort", u32::from(val.remote_port))?;
    obj.set("arrivalMs", val.arrival_ms)?;
    obj.set("parsed", envelope_to_napi(val.parsed))?;
    Ok(<Object as ToNapiValue>::to_napi_value(env, obj)?)
  }
}
