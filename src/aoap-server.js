// Server-side AOAP (Android Open Accessory) handshake.
//
// ⚠️ DEPRECATED 2026-06-19 (Windows): the MTP kernel driver returns "invalid
// state" on vendor control transfers even from libusb. Only Zadig + WinUSB
// replacement unblocks it, at the cost of MTP file transfer. See ADR-002 for
// the pivot to Wi-Fi hotspot transport. This module is kept for Linux/macOS
// (both work without driver hacks) until M1' is GA.
//
// Why this exists: Chrome WebUSB on Windows can't open() a phone in MTP mode
// — Windows MTP driver claims the device, WinUSB layer (which Chrome uses)
// gets ERR_ACCESS_DENIED. Node's `usb` package (libusb) opens the same device
// successfully, can issue vendor control transfers, and once the phone
// re-enumerates as accessory (PID 0x2D00) it presents the WCID descriptors
// Windows needs to auto-load WinUSB. THEN Chrome can take over for bulk I/O.
//
// Flow:
//   POST /api/aoap/handshake  →  this module picks the phone, runs the 5-step
//                                 control-transfer sequence, returns ok/err.
//   Browser then hits navigator.usb.requestDevice (filtered to 0x18D1:0x2D00),
//   the user picks the now-accessory-mode device, WebUSB does the bulk loop.
//
// IMPORTANT: this module is best-effort. If libusb fails too (unsigned WinUSB,
// other driver claim) the response includes hint=zadig so the page can show
// the troubleshooting doc.

'use strict';

const ACCESSORY_VID = 0x18D1;
const ACCESSORY_PIDS = new Set([0x2D00, 0x2D01, 0x2D02, 0x2D03, 0x2D04, 0x2D05]);

const REQ_GET_PROTOCOL = 51;
const REQ_SEND_STRING  = 52;
const REQ_START        = 53;

// String slots match the AOAP spec exactly. Identity values must match
// android/app/src/main/res/xml/accessory_filter.xml on the APK side, otherwise
// Android won't offer the user the "Open PassMan?" dialog.
const IDENTITY = [
  /* manufacturer */ 'PassMan',
  /* model        */ 'PassMan-Pair',
  /* description  */ 'PassMan local password manager pairing channel',
  /* version      */ '1.0',
  /* uri          */ 'https://localhost:3000',
  /* serial       */ 'passman-pc-0001',
];

let _usb = null;
function loadUsb() {
  if (_usb) return _usb;
  try {
    _usb = require('usb');
  } catch (err) {
    const e = new Error('usb package not loadable: ' + err.message);
    e.code = 'USB_PACKAGE_MISSING';
    throw e;
  }
  return _usb;
}

/**
 * Pick the connected non-accessory phone. We accept any device that's not in
 * the {hub, hid, mass storage, audio, vendor-only} pool we know isn't a phone.
 * Heuristic: USB device class 0x00 (per-interface) or 0xEF (misc) AND has a
 * manufacturerName non-null (filters out hubs which generally lack strings).
 *
 * If a device already in accessory mode is present we return it untouched —
 * caller decides whether to re-handshake or skip.
 */
async function pickPhone() {
  const { usb } = loadUsb();
  await usb.loadDevices();
  const devices = await usb.getDevices();

  // First check for an already-accessory device — fast path on second connect.
  const accessory = devices.find(d =>
    d.vendorId === ACCESSORY_VID && ACCESSORY_PIDS.has(d.productId));
  if (accessory) {
    return { device: accessory, alreadyAccessory: true };
  }

  // Otherwise look for a likely Android phone. We avoid hubs/HID by requiring
  // a manufacturer string, and exclude well-known non-phones by VID.
  const NON_PHONE_VIDS = new Set([
    0x05E3, 0x2109, 0x8087,            // hubs (Genesys, VIA, Intel)
    0x1462,                            // MSI mobo RGB
    0x25A7, 0x1532, 0x03F0,            // wireless dongles / headset
  ]);
  const phones = devices.filter(d =>
    !NON_PHONE_VIDS.has(d.vendorId) &&
    d.manufacturerName != null &&
    // Android phones are class 0 (defined per-interface) or 0xEF (misc).
    (d.deviceClass === 0 || d.deviceClass === 0xEF));

  if (phones.length === 0) {
    const e = new Error('No Android phone detected. Plug in via USB.');
    e.code = 'NO_PHONE';
    throw e;
  }
  if (phones.length > 1) {
    const e = new Error('Multiple candidate phones found: ' +
      phones.map(p => `${p.manufacturerName}/${p.productName}`).join(', ') +
      '. Unplug all but one.');
    e.code = 'AMBIGUOUS';
    throw e;
  }
  return { device: phones[0], alreadyAccessory: false };
}

/**
 * Run the 5-step AOAP handshake on the picked device. Throws on any step
 * failure with .code set to a stable string for the UI to map to a hint.
 */
async function handshake(device) {
  // 1. open
  try {
    if (!device.opened) await device.open();
  } catch (err) {
    const e = new Error('Cannot open USB device: ' + err.message +
      ' (Windows: device likely owned by MTP driver — see troubleshooting-windows.md).');
    e.code = 'OPEN_FAIL';
    throw e;
  }

  // 1b. Best-effort kernel driver detach. On Linux/macOS this peels MTP/PTP off
  // interfaces 0..N so libusb can issue vendor requests. On Windows it usually
  // returns success but is a no-op (Windows driver model doesn't allow user-mode
  // detach without a custom INF). We swallow per-interface failures because the
  // first interface that succeeds (if any) is enough — control transfers go to
  // the *device* level, not to a specific interface.
  if (typeof device.detachKernelDriver === 'function') {
    for (let i = 0; i < 4; i++) {
      try { device.detachKernelDriver(i); } catch { /* expected on most ifaces */ }
    }
  }

  // 2. GET_PROTOCOL — vendor IN, device, req=51, 2-byte response.
  let version;
  try {
    const r = await device.controlTransferIn({
      requestType: 'vendor', recipient: 'device',
      request: REQ_GET_PROTOCOL, value: 0, index: 0,
    }, 2);
    if (r.status !== 'ok' || !r.data || r.data.byteLength < 2) {
      throw new Error(`status=${r.status}, bytes=${r.data?.byteLength ?? 0}`);
    }
    version = r.data.getUint16(0, true);
  } catch (err) {
    await closeQuietly(device);
    const e = new Error('GET_PROTOCOL failed: ' + err.message +
      '. The phone may not support AOAP, or its kernel driver is blocking ' +
      'vendor control transfers (typical of MTP-mode on stock Windows). ' +
      'Try setting USB mode to "charging only" on the phone, or run Zadig ' +
      'to install WinUSB for this VID/PID.');
    e.code = 'GET_PROTOCOL_FAIL';
    throw e;
  }
  if (version < 1) {
    await closeQuietly(device);
    const e = new Error(`AOAP version ${version} unsupported (need >= 1)`);
    e.code = 'UNSUPPORTED_PROTOCOL';
    throw e;
  }

  // 3. SEND_STRING ×6 — vendor OUT, device, req=52, index=string-id, payload=utf8\0.
  for (let id = 0; id < IDENTITY.length; id++) {
    const bytes = Buffer.from(IDENTITY[id] + '\0', 'utf8');
    try {
      const r = await device.controlTransferOut({
        requestType: 'vendor', recipient: 'device',
        request: REQ_SEND_STRING, value: 0, index: id,
      }, bytes);
      if (r.status !== 'ok') {
        throw new Error(`status=${r.status} bytes=${r.bytesWritten ?? 0}`);
      }
    } catch (err) {
      await closeQuietly(device);
      const e = new Error(`SEND_STRING(${id}) failed: ${err.message}`);
      e.code = 'SEND_STRING_FAIL';
      throw e;
    }
  }

  // 4. START_ACCESSORY — vendor OUT, no payload, req=53.
  try {
    const r = await device.controlTransferOut({
      requestType: 'vendor', recipient: 'device',
      request: REQ_START, value: 0, index: 0,
    });
    if (r.status !== 'ok') throw new Error(`status=${r.status}`);
  } catch (err) {
    await closeQuietly(device);
    const e = new Error('START_ACCESSORY failed: ' + err.message);
    e.code = 'START_FAIL';
    throw e;
  }

  // 5. Close so the phone can re-enumerate cleanly. After ~500ms-2s it should
  //    re-appear as 0x18D1:0x2D00 (or 0x2D01) and Windows will auto-bind WinUSB.
  await closeQuietly(device);

  return { protocolVersion: version };
}

async function closeQuietly(device) {
  try { if (device.opened) await device.close(); } catch { /* swallow */ }
}

/**
 * Express handler for POST /api/aoap/handshake.
 * Returns:
 *   200 { ok: true,  protocolVersion, alreadyAccessory? }
 *   200 { ok: false, code, error, hint }   — handshake failed but request shape was fine
 *   503 { ok: false, code: 'USB_PACKAGE_MISSING', error }  — `usb` not installed
 */
async function handshakeHandler(_req, res) {
  let pick;
  try {
    pick = await pickPhone();
  } catch (err) {
    if (err.code === 'USB_PACKAGE_MISSING') {
      return res.status(503).json({ ok: false, code: err.code, error: err.message });
    }
    return res.status(200).json({
      ok: false, code: err.code ?? 'PICK_FAIL', error: err.message,
      hint: err.code === 'NO_PHONE' ? 'plug-phone' : 'unplug-extras',
    });
  }

  if (pick.alreadyAccessory) {
    return res.status(200).json({
      ok: true, alreadyAccessory: true,
      vendorId: pick.device.vendorId, productId: pick.device.productId,
      message: 'Phone already in accessory mode — browser can take over.',
    });
  }

  try {
    const r = await handshake(pick.device);
    return res.status(200).json({
      ok: true, protocolVersion: r.protocolVersion,
      message: 'Handshake done. Phone is re-enumerating as accessory; ' +
               'browser should now grab 0x18D1:0x2D00.',
    });
  } catch (err) {
    return res.status(200).json({
      ok: false, code: err.code ?? 'HANDSHAKE_FAIL', error: err.message,
      hint: hintFor(err.code),
    });
  }
}

function hintFor(code) {
  switch (code) {
    case 'OPEN_FAIL':
    case 'GET_PROTOCOL_FAIL':
      return 'windows-driver';      // page links to troubleshooting-windows.md
    case 'UNSUPPORTED_PROTOCOL':
      return 'incompatible-phone';
    default:
      return null;
  }
}

module.exports = { handshakeHandler, handshake, pickPhone };
