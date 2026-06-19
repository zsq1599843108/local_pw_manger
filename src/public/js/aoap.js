// AOAP (Android Open Accessory Protocol v2) — PC side handshake over WebUSB.
//
// ⚠️ DEPRECATED 2026-06-19 — Windows only: the MTP kernel driver blocks vendor
// control transfers (req=51 GET_PROTOCOL fails with "Access denied" in Chrome
// and "invalid state" in libusb). Only Zadig + WinUSB driver replacement
// unblocks it, but that breaks MTP file transfer for the same phone — a
// trade-off the project rejected. See ADR-002 for the pivot to Wi-Fi hotspot.
//
// Linux / macOS users can still drive this module — both platforms' libusb
// has no kernel-driver block on vendor requests. Until M1' (Wi-Fi) is mature
// this remains the fast path on those platforms.
//
// Flow (see docs/aoap-design.md §4):
//   1. requestDevice()   — user picks an Android phone (any vendor)
//   2. getProtocol()     — control IN req=51, expect uint16 version >= 1
//   3. sendString()      — control OUT req=52 × 6 (manufacturer / model / etc.)
//   4. startAccessory()  — control OUT req=53, phone re-enumerates as 0x18D1:0x2D00
//   5. waitForAccessoryDevice() — find re-enumerated device, claim bulk endpoints
//
// After handshake, caller gets {device, endpointIn, endpointOut} and can do
// transferIn/transferOut for the bulk channel. Frame layer is M2's job.

const ACCESSORY_VID = 0x18D1;
const ACCESSORY_PID_ACCESSORY = 0x2D00;       // accessory only
const ACCESSORY_PID_ACCESSORY_ADB = 0x2D01;   // accessory + adb (we accept either)

// AOAP control request codes (host -> device, type=VENDOR | RECIPIENT_DEVICE)
const REQ_GET_PROTOCOL = 51;
const REQ_SEND_STRING  = 52;
const REQ_START        = 53;

// SEND_STRING string IDs per AOAP spec
const STR_MANUFACTURER  = 0;
const STR_MODEL         = 1;
const STR_DESCRIPTION   = 2;
const STR_VERSION       = 3;
const STR_URI           = 4;
const STR_SERIAL_NUMBER = 5;

// Identity strings sent to the phone. Must match accessory_filter.xml on the APK side.
export const ACCESSORY_IDENTITY = {
  manufacturer: 'PassMan',
  model:        'PassMan-Pair',
  description:  'PassMan local password manager pairing channel',
  version:      '1.0',
  uri:          'https://localhost:3000',
  serial:       'passman-pc-0001',
};

/**
 * Ask the user to pick an Android phone. We use a permissive filter (empty)
 * because phones ship with vendor-specific VIDs before the accessory switch.
 * Returns the opened USBDevice.
 */
export async function requestDevice() {
  if (!navigator.usb) {
    throw new Error('WebUSB unavailable — use Chrome or Edge.');
  }
  const device = await navigator.usb.requestDevice({ filters: [] });
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  return device;
}

/**
 * Read AOAP protocol version from the device. Returns the version (>=1) or
 * throws if the device does not support AOAP.
 */
export async function getProtocol(device) {
  const result = await device.controlTransferIn({
    requestType: 'vendor',
    recipient:   'device',
    request:     REQ_GET_PROTOCOL,
    value:       0,
    index:       0,
  }, 2);
  if (result.status !== 'ok' || !result.data || result.data.byteLength < 2) {
    throw new Error(`GET_PROTOCOL failed: status=${result.status}`);
  }
  // Response is little-endian uint16
  const version = result.data.getUint16(0, true);
  if (version < 1) throw new Error(`AOAP version ${version} unsupported`);
  return version;
}

/**
 * Send one identity string slot (req=52). String IDs 0..5 follow the AOAP spec.
 */
export async function sendString(device, stringId, str) {
  const bytes = new TextEncoder().encode(str + '\0');
  const result = await device.controlTransferOut({
    requestType: 'vendor',
    recipient:   'device',
    request:     REQ_SEND_STRING,
    value:       0,
    index:       stringId,
  }, bytes);
  if (result.status !== 'ok') {
    throw new Error(`SEND_STRING(${stringId}) failed: ${result.status}`);
  }
}

/**
 * Tell the device to switch into accessory mode (req=53). After this call
 * the device re-enumerates with VID=0x18D1, PID=0x2D00 (or 0x2D01).
 */
export async function startAccessory(device) {
  const result = await device.controlTransferOut({
    requestType: 'vendor',
    recipient:   'device',
    request:     REQ_START,
    value:       0,
    index:       0,
  });
  if (result.status !== 'ok') {
    throw new Error(`START_ACCESSORY failed: ${result.status}`);
  }
}

/**
 * Send the standard 6 identity strings.
 */
export async function sendIdentity(device, identity = ACCESSORY_IDENTITY) {
  await sendString(device, STR_MANUFACTURER,  identity.manufacturer);
  await sendString(device, STR_MODEL,         identity.model);
  await sendString(device, STR_DESCRIPTION,   identity.description);
  await sendString(device, STR_VERSION,       identity.version);
  await sendString(device, STR_URI,           identity.uri);
  await sendString(device, STR_SERIAL_NUMBER, identity.serial);
}

/**
 * After START_ACCESSORY the original device disappears and a new one shows up
 * with VID 0x18D1. Poll navigator.usb.getDevices() for up to `timeoutMs`.
 */
export async function waitForAccessoryDevice(timeoutMs = 5000, pollMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const devices = await navigator.usb.getDevices();
    const hit = devices.find(d =>
      d.vendorId === ACCESSORY_VID &&
      (d.productId === ACCESSORY_PID_ACCESSORY ||
       d.productId === ACCESSORY_PID_ACCESSORY_ADB));
    if (hit) return hit;
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for accessory re-enumeration. ' +
    'On the phone, tap "Open PassMan?" when the dialog appears.');
}

/**
 * Find the bulk IN and bulk OUT endpoints in the accessory's first interface.
 * Returns {interfaceNumber, endpointIn, endpointOut} (endpoint numbers, not objects).
 */
export function findBulkEndpoints(device) {
  const cfg = device.configuration;
  if (!cfg) throw new Error('Device has no active configuration.');
  for (const iface of cfg.interfaces) {
    const alt = iface.alternate;
    let inEp = null, outEp = null;
    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in')  inEp  = ep.endpointNumber;
      if (ep.direction === 'out') outEp = ep.endpointNumber;
    }
    if (inEp !== null && outEp !== null) {
      return { interfaceNumber: iface.interfaceNumber, endpointIn: inEp, endpointOut: outEp };
    }
  }
  throw new Error('No bulk in/out endpoint pair found on accessory device.');
}

/**
 * Full handshake helper. Picks a device (interactive), runs AOAP, returns
 * an opened+claimed accessory-mode device with {device, endpointIn, endpointOut}.
 *
 * Caller is responsible for releaseInterface()/close() when done.
 */
export async function pairOverAoap({ identity = ACCESSORY_IDENTITY, log = () => {} } = {}) {
  log('requesting device…');
  const probe = await requestDevice();
  try {
    log(`probe: ${probe.manufacturerName ?? '?'} / ${probe.productName ?? '?'} ` +
        `(${hex4(probe.vendorId)}:${hex4(probe.productId)})`);

    // If the user already picked an accessory-mode device, skip handshake.
    if (probe.vendorId === ACCESSORY_VID &&
        (probe.productId === ACCESSORY_PID_ACCESSORY ||
         probe.productId === ACCESSORY_PID_ACCESSORY_ADB)) {
      log('device is already in accessory mode, skipping handshake');
      return await claimAccessory(probe);
    }

    log('GET_PROTOCOL…');
    const version = await getProtocol(probe);
    log(`AOAP version: ${version}`);

    log('SEND_STRING ×6…');
    await sendIdentity(probe, identity);

    log('START_ACCESSORY…');
    await startAccessory(probe);

    // The probe device closes itself when the phone re-enumerates. Best-effort cleanup.
    try { await probe.close(); } catch { /* expected — device is gone */ }
  } catch (err) {
    try { await probe.close(); } catch {}
    throw err;
  }

  log('waiting for accessory re-enumeration…');
  const accessory = await waitForAccessoryDevice();
  log(`accessory found: ${hex4(accessory.vendorId)}:${hex4(accessory.productId)}`);
  return await claimAccessory(accessory);
}

async function claimAccessory(device) {
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  const { interfaceNumber, endpointIn, endpointOut } = findBulkEndpoints(device);
  await device.claimInterface(interfaceNumber);
  return { device, interfaceNumber, endpointIn, endpointOut };
}

function hex4(n) {
  return '0x' + (n ?? 0).toString(16).padStart(4, '0');
}
