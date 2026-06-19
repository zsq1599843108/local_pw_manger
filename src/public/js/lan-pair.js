// Wi-Fi hotspot pairing UI logic for phone.html (M1' PoC).
//
// Plain script (not a module) so the inline onclick="startLanProbe()" can
// call it. Uses fetch against /api/lan/probe; the Express handler proxies
// to the phone's Ktor server inside the hotspot LAN.
//
// M2'+ adds pair / WebSocket. M1' is just ping/pong + readable error
// messages mapped from server-side error codes.

(function () {
  const btn  = document.getElementById('lan-btn');
  const log  = document.getElementById('lan-log');
  const hostInput = document.getElementById('lan-host');
  const portInput = document.getElementById('lan-port');

  function append(line) {
    if (!log) return;
    log.style.display = 'block';
    const stamp = new Date().toISOString().slice(11, 19);
    log.textContent += `[${stamp}] ${line}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async function startLanProbe() {
    if (!btn) return;
    const host = (hostInput?.value || '192.168.43.1').trim();
    const port = Number(portInput?.value || 9876);

    btn.disabled = true;
    log.textContent = '';
    log.style.display = 'block';
    append(`→ POST /api/lan/probe { host: ${host}, port: ${port} }`);

    try {
      const t0 = performance.now();
      const resp = await fetch('/api/lan/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
      });
      const data = await resp.json();
      const t1 = performance.now();
      const dur = (t1 - t0).toFixed(0);

      if (data.ok) {
        append(`✓ pong in ${dur}ms — ${data.app} v${data.ver}, server uptime ${formatMs(data.uptimeMs)}`);
        append(`📡 phone clock skew vs PC: ${(data.time - Date.now()).toString().padStart(5)} ms`);
        append('🎉 M1\' PoC validated — Wi-Fi LAN channel is up. Next: M2\' encrypted channel.');
      } else {
        append(`❌ probe failed [${data.code}]: ${data.error}`);
        if (data.hint) append(`💡 ${data.hint}`);
      }
    } catch (err) {
      append(`❌ ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  }

  function formatMs(ms) {
    if (ms == null) return '?';
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
  }

  window.startLanProbe = startLanProbe;
})();
