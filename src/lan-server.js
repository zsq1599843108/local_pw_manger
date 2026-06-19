// LAN-side helpers for the Wi-Fi-hotspot pairing route (ADR-002).
//
// Architecture: PC connects to phone's Wi-Fi hotspot, then this module
// proxies HTTP requests from the browser to the phone's Ktor server. We
// proxy server-side (rather than letting the browser fetch directly) because:
//   - phone serves plain HTTP; browser would block mixed-content from https
//   - same-origin avoids CORS pre-flight on every request
//   - we can centralise timeout / retry policy in one place
//
// M1' exposes only `probe()`. M2'+ adds pairAndExchange / openWebSocket.

'use strict';

const DEFAULT_HOST = '192.168.43.1';   // Android stock hotspot gateway
const DEFAULT_PORT = 9876;
const DEFAULT_TIMEOUT_MS = 1500;

/**
 * GET http://<host>:<port>/ping with a hard timeout. Returns the parsed body
 * on success; throws with a stable .code on failure so the route handler can
 * map to a UI hint.
 *
 * Why fetch (Node 18+) instead of a custom http.request: AbortController +
 * automatic JSON parsing is enough, and we keep zero deps for this layer.
 */
async function probe({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `http://${host}:${port}/ping`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    const e = new Error(`probe ${url} failed: ${err.name} ${err.message ?? err.cause?.code ?? ''}`);
    e.code = mapNetworkError(err);
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const e = new Error(`probe ${url} returned HTTP ${resp.status}`);
    e.code = 'BAD_STATUS';
    throw e;
  }

  const body = await resp.json().catch(_err => null);
  if (!body || body.app !== 'passman') {
    const e = new Error('Reachable but does not look like a PassMan phone server: ' + JSON.stringify(body));
    e.code = 'WRONG_APP';
    throw e;
  }
  return body;  // { app, ver, time, uptimeMs }
}

function mapNetworkError(err) {
  if (err.name === 'AbortError') return 'TIMEOUT';
  const cause = err.cause?.code ?? '';
  if (cause === 'ECONNREFUSED') return 'REFUSED';   // phone server not running
  if (cause === 'EHOSTUNREACH' || cause === 'ENETUNREACH') return 'NO_ROUTE';
  if (cause === 'ETIMEDOUT')    return 'TIMEOUT';
  return 'NETWORK';
}

/** Express handler for POST /api/lan/probe — accepts {host, port}. */
async function probeHandler(req, res) {
  const host = (req.body?.host ?? DEFAULT_HOST).toString();
  const port = Number(req.body?.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ ok: false, code: 'BAD_INPUT', error: 'port out of range' });
  }
  try {
    const body = await probe({ host, port });
    return res.status(200).json({ ok: true, ...body, host, port });
  } catch (err) {
    return res.status(200).json({
      ok: false, code: err.code ?? 'UNKNOWN', error: err.message,
      hint: hintFor(err.code, host),
    });
  }
}

function hintFor(code, host) {
  switch (code) {
    case 'TIMEOUT':
    case 'NO_ROUTE':
      return `Can't reach ${host}. Is the PC connected to the phone's Wi-Fi hotspot?`;
    case 'REFUSED':
      return `Reached ${host}, but no server on the port. Open PassMan on the phone and tap "Start server".`;
    case 'WRONG_APP':
      return `Something's responding but it's not the PassMan APK — wrong host?`;
    case 'BAD_STATUS':
      return `Server returned a non-200. Check phone-side logs (logcat -s PassManHotspot).`;
    default:
      return null;
  }
}

module.exports = { probe, probeHandler };
