#!/usr/bin/env node
/**
 * UTF-8 Round-trip Test
 *
 * Background: PROGRESS.md (2026-06-18) reported "Chinese title/notes stored as garbled".
 * Investigation (2026-06-18) proved this was a Windows GBK console false positive — actual
 * storage is always correct UTF-8. This script verifies that and prevents regression.
 *
 * Usage:
 *   node src/server.js  # in another terminal
 *   node scripts/test-utf8.js
 *
 * Exit codes:
 *   0 — round-trip OK
 *   1 — server unreachable
 *   2 — UTF-8 mismatch (real bug)
 */

const http = require('http');

const HOST = 'localhost';
const PORT = 3000;
const FAKE_SESSION_KEY = '0'.repeat(64);  // 32 bytes hex; encrypts the password field with junk key (we don't decrypt it back)

const TEST_CASES = [
  { label: 'Simplified Chinese',  text: '中文标题测试' },
  { label: 'Traditional Chinese', text: '繁體中文測試' },
  { label: 'Japanese',            text: '日本語のテスト' },
  { label: 'Korean',              text: '한국어 테스트' },
  { label: 'Emoji',               text: 'Hello 🌍 世界 🔐' },
  { label: 'Mixed + symbols',     text: 'Mixed 中文 / EN — — — 🎉' },
  { label: '4-byte CJK extension',text: '𠮷野家 (U+20BB7)' },
];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: HOST, port: PORT, path, method,
      headers: data
        ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length }
        : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw.toString('utf8')), raw }); }
        catch { resolve({ status: res.statusCode, body: null, raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. health check
  try {
    const h = await request('GET', '/api/health');
    if (h.status !== 200) { console.error('Server not healthy:', h.status); process.exit(1); }
  } catch (e) {
    console.error(`Server unreachable at ${HOST}:${PORT}. Start it first: node src/server.js`);
    process.exit(1);
  }

  console.log('UTF-8 Round-trip Test');
  console.log('='.repeat(60));

  let pass = 0, fail = 0;
  const insertedIds = [];

  for (const tc of TEST_CASES) {
    const payload = {
      sessionKey: FAKE_SESSION_KEY,
      title: tc.text,
      username: tc.text,
      password: 'pwd',
      notes: tc.text,
      category: tc.text,
    };
    const post = await request('POST', '/api/passwords', payload);
    if (!post.body || !post.body.success) {
      console.log(`  ❌ ${tc.label}: POST failed (${JSON.stringify(post.body)})`);
      fail++; continue;
    }
    const id = post.body.id;
    insertedIds.push(id);

    const get = await request('GET', `/api/passwords?sessionKey=${FAKE_SESSION_KEY}`);
    const found = (get.body || []).find((p) => p.id === id);
    if (!found) {
      console.log(`  ❌ ${tc.label}: GET did not return id=${id}`);
      fail++; continue;
    }

    const ok =
      found.title    === tc.text &&
      found.username === tc.text &&
      found.notes    === tc.text &&
      found.category === tc.text;

    if (ok) {
      console.log(`  ✅ ${tc.label.padEnd(28)} (${tc.text.length} chars, ${Buffer.byteLength(tc.text, 'utf8')} bytes)`);
      pass++;
    } else {
      console.log(`  ❌ ${tc.label}`);
      console.log(`     expected hex: ${Buffer.from(tc.text, 'utf8').toString('hex')}`);
      console.log(`     got      hex: ${Buffer.from(found.title, 'utf8').toString('hex')}`);
      fail++;
    }
  }

  // cleanup
  for (const id of insertedIds) await request('DELETE', `/api/passwords/${id}`);

  console.log('='.repeat(60));
  console.log(`Result: ${pass} pass, ${fail} fail`);
  console.log(`Cleaned up ${insertedIds.length} test rows.`);
  process.exit(fail === 0 ? 0 : 2);
})();
