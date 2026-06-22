// lan-ws-client.js — Node-side WebSocket bridge for the LAN encrypted channel
// (M2', ADR-002).
//
// Why a Node bridge at all? The browser cannot open ws://<phone-ip>:9876
// directly: the PC's page is served over http://localhost:3000 (and on other
// setups https), and the phone's plain-WS endpoint triggers mixed-content /
// cross-origin blocks. So the browser opens ws://localhost:3000/api/lan/socket
// and this module opens the upstream ws://<phone>:9876/socket on its behalf.
//
// Critical design choice: this module is a DUMB BYTE PIPE. It holds no keys,
// parses no frames, understands none of the protocol. ECDH + AES-GCM happen
// end-to-end between browser WebCrypto and phone Tink. If we ever need to
// inspect traffic, we'd have to break that property deliberately.
//
// Lifecycle:
//   openBridge({host,port})  -> Promise<Bridge>  (resolves on upstream open)
//   bridge.attachBrowser(ws) -> wires a browser ws to the upstream
//   close()                  -> tears both ends down
//
// Each direction copies raw messages: browser→phone forwards ws.send bytes;
// phone→browser forwards the upstream 'message' payload back. Close on either
// side propagates to the other.

'use strict';

const WebSocket = require('ws');

const DEFAULT_HOST = '192.168.43.1';
const DEFAULT_PORT = 9876;
const CONNECT_TIMEOUT_MS = 3000;

/**
 * One bridge ties a single browser WS to a single phone WS.
 * Browser side is attached after the upstream connects, because the Express
 * WS route may accept the browser socket before we've dialled the phone.
 */
class Bridge {
  constructor(upstream) {
    this.upstream = upstream;
    this.browser = null;

    upstream.on('message', (data, isBinary) => {
      if (this.browser && this.browser.readyState === WebSocket.OPEN) {
        // Forward raw: text frames stay text, binary stay binary. ws exposes
        // isBinary on inbound; send() auto-picks type on outbound from Buffer vs string.
        this.browser.send(data, { binary: isBinary });
      }
    });
    upstream.on('close', (code, reason) => {
      this._closeBrowser(code, reason);
    });
    upstream.on('error', (err) => {
      // Surfaced to browser as a 1011 close; upstream 'close' follows.
      this._closeBrowser(1011, Buffer.from((err && err.message) || 'upstream error'));
    });
  }

  attachBrowser(ws) {
    this.browser = ws;

    ws.on('message', (data, isBinary) => {
      if (this.upstream.readyState === WebSocket.OPEN) {
        this.upstream.send(data, { binary: isBinary });
      }
    });
    ws.on('close', () => { this._closeUpstream(1000); });
    ws.on('error', () => { this._closeUpstream(1011); });
  }

  _closeBrowser(code, reason) {
    if (this.browser && this.browser.readyState === WebSocket.OPEN) {
      try { this.browser.close(code, reason); } catch (_) {}
    }
  }
  _closeUpstream(code) {
    if (this.upstream.readyState === WebSocket.OPEN) {
      try { this.upstream.close(code); } catch (_) {}
    }
  }
}

/**
 * Dial the phone's /socket. Resolves with a Bridge once the upstream is open,
 * rejects (with .code) on timeout / refused so the route can map to a hint.
 */
function openBridge({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const url = `ws://${host}:${port}/socket`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const upstream = new WebSocket(url, { handshakeTimeout: timeoutMs });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { upstream.terminate(); } catch (_) {}
      const e = new Error(`dial ${url} timed out`);
      e.code = 'TIMEOUT';
      reject(e);
    }, timeoutMs);

    upstream.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(new Bridge(upstream));
    });
    upstream.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const e = new Error(`dial ${url} failed: ${(err && err.message) || ''}`);
      e.code = mapWsError(err);
      reject(e);
    });
  });
}

function mapWsError(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('ECONNREFUSED')) return 'REFUSED';
  if (msg.includes('EHOSTUNREACH') || msg.includes('ENETUNREACH')) return 'NO_ROUTE';
  if (msg.includes('ETIMEDOUT')) return 'TIMEOUT';
  if (msg.includes('404') || msg.includes('unexpected response')) return 'NO_SOCKET_ROUTE';
  return 'NETWORK';
}

module.exports = { openBridge, Bridge, DEFAULT_HOST, DEFAULT_PORT };
