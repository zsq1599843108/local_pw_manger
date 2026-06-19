// Wires the "Pair via USB (AOAP)" button.
//
// ⚠️ DEPRECATED 2026-06-19 — kept for Linux/macOS only. Windows is blocked
// by the MTP driver locking vendor control transfers — see ADR-002 for the
// Wi-Fi-hotspot pivot.
//
// Two-stage flow that works around Windows MTP-driver blocking Chrome WebUSB:
//   Stage 1 — POST /api/aoap/handshake → Node-side libusb runs the 5-step
//             AOAP handshake, phone re-enumerates as accessory (PID 0x2D00).
//   Stage 2 — navigator.usb.requestDevice (filtered to 0x18D1) → user picks
//             the now-accessory device → bulk transferIn/transferOut for echo.
//
// On Linux/macOS Stage 1 also works (libusb is happy on those platforms).
// On Windows if Stage 1 succeeds but Stage 2 still throws "Access denied",
// the user needs Zadig to install WinUSB for the accessory PID — the page
// surfaces a link to docs/troubleshooting-windows.md.

const ACCESSORY_VID = 0x18D1;
const ACCESSORY_PIDS = [0x2D00, 0x2D01, 0x2D02, 0x2D03, 0x2D04, 0x2D05];

const btn = document.getElementById('aoap-btn');
const log = document.getElementById('aoap-log');

function append(line) {
  if (!log) return;
  log.style.display = 'block';
  const stamp = new Date().toISOString().slice(11, 19);
  log.textContent += `[${stamp}] ${line}\n`;
  log.scrollTop = log.scrollHeight;
}

async function startAoapPairing() {
  if (!btn) return;
  btn.disabled = true;
  log.textContent = '';
  log.style.display = 'block';

  let session = null;
  try {
    // ─── Stage 1: server-side libusb handshake ────────────────────────────
    append('→ requesting server-side handshake (POST /api/aoap/handshake)…');
    const resp = await fetch('/api/aoap/handshake', { method: 'POST' });
    const data = await resp.json();
    if (!data.ok) {
      append(`❌ handshake failed: [${data.code}] ${data.error}`);
      if (data.hint === 'plug-phone') {
        append('💡 Plug an Android phone via USB and retry.');
      } else if (data.hint === 'windows-driver') {
        append('💡 Windows likely blocking via MTP driver. ' +
               'Try changing phone USB mode to "charging only", or run Zadig — ' +
               'see docs/troubleshooting-windows.md.');
      } else if (data.hint === 'unplug-extras') {
        append('💡 Multiple candidate phones detected — unplug all but one.');
      }
      return;
    }
    if (data.alreadyAccessory) {
      append(`✓ phone already in accessory mode (${hex4(data.vendorId)}:${hex4(data.productId)}), skipping handshake`);
    } else {
      append(`✓ AOAP handshake done (proto v${data.protocolVersion}). Phone is re-enumerating…`);
      // Give Windows ~1.5s to detect re-enumeration and bind WinUSB driver.
      await wait(1500);
    }

    // ─── Stage 2: WebUSB takes over the accessory-mode device ─────────────
    if (!navigator.usb) {
      append('❌ WebUSB unavailable in this browser. Use Chrome or Edge.');
      return;
    }
    append('→ asking user to pick the accessory device (filter VID 0x18D1)…');
    const filters = ACCESSORY_PIDS.map(productId => ({ vendorId: ACCESSORY_VID, productId }));
    const device = await navigator.usb.requestDevice({ filters });
    append(`✓ selected: ${device.manufacturerName ?? '?'} / ${device.productName ?? '?'} (${hex4(device.vendorId)}:${hex4(device.productId)})`);

    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    const eps = findBulkEndpoints(device);
    await device.claimInterface(eps.interfaceNumber);
    session = { device, ...eps };
    append(`✓ accessory claimed: iface=${eps.interfaceNumber} epIn=${eps.endpointIn} epOut=${eps.endpointOut}`);

    // ─── Echo round-trip ──────────────────────────────────────────────────
    const tx = new TextEncoder().encode('HELLO from PC at ' + new Date().toISOString());
    append(`→ TX ${tx.byteLength} bytes: "HELLO from PC at …"`);
    const txResult = await device.transferOut(eps.endpointOut, tx);
    append(`   transferOut status=${txResult.status} bytesWritten=${txResult.bytesWritten}`);

    append('← waiting for echo (up to 5s)…');
    const rxResult = await Promise.race([
      device.transferIn(eps.endpointIn, 64 * 1024),
      new Promise((_, rej) => setTimeout(() => rej(new Error('rx timeout')), 5000)),
    ]);
    if (rxResult?.data) {
      const rxText = new TextDecoder().decode(rxResult.data);
      append(`← RX ${rxResult.data.byteLength} bytes: "${rxText}"`);
      if (rxText.startsWith('ECHO:HELLO')) {
        append('🎉 round-trip OK — M1 PoC validated');
      } else {
        append('⚠️ unexpected payload (expected ECHO:HELLO… prefix)');
      }
    }
  } catch (err) {
    append(`❌ ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    if (String(err?.message ?? '').toLowerCase().includes('access denied')) {
      append('💡 WebUSB Access denied even after AOAP handshake — install ' +
             'WinUSB for VID 0x18D1 PID 0x2D00 via Zadig. See docs/troubleshooting-windows.md.');
    }
    console.error(err);
  } finally {
    if (session) {
      try { await session.device.releaseInterface(session.interfaceNumber); } catch {}
      try { await session.device.close(); } catch {}
    }
    btn.disabled = false;
  }
}

function findBulkEndpoints(device) {
  const cfg = device.configuration;
  if (!cfg) throw new Error('Device has no active configuration.');
  for (const iface of cfg.interfaces) {
    let inEp = null, outEp = null;
    for (const ep of iface.alternate.endpoints) {
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

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function hex4(n) { return '0x' + (n ?? 0).toString(16).padStart(4, '0'); }

window.startAoapPairing = startAoapPairing;
