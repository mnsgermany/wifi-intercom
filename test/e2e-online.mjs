// Режим «Есть интернет»: знакомство через комнату Worker, звук телефон ↔ хаб.
// Нужен запущенный Worker: cd worker && npx wrangler dev --port 8787 --ip 127.0.0.1
// Запуск: node test/e2e-online.mjs [адрес сайта] [адрес Worker]
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../node_modules/', import.meta.url));
const { chromium } = require('playwright');

const SITE = process.argv[2] || 'http://localhost:8751/';
const API = process.argv[3] || 'http://127.0.0.1:8787';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const open = async () => {
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
  await ctx.addInitScript((api) => localStorage.setItem('wfi_api', api), API);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  return p;
};

try {
  const host = await open();
  await host.goto(SITE);
  await host.fill('#name', 'Хаб');
  await host.click('#createBtn');
  await host.waitForFunction(() => (document.getElementById('joinQr').dataset.qr || '').includes('#c='), null, { timeout: 20000 });
  const url = await host.evaluate(() => document.getElementById('joinQr').dataset.qr);
  console.log('QR «Есть интернет»:', url.length, 'символов');
  await host.keyboard.press('Escape');

  const users = [];
  for (const name of ['Вася', 'Петя']) {
    const u = await open();
    await u.goto(url);
    await u.fill('#name', name);
    const t = Date.now();
    await u.click('#joinBtn');
    await u.waitForSelector('#main:not([hidden])', { timeout: 30000 }).catch(async (e) => {
      console.log(name, 'шаги:', await u.evaluate(() => (window.__wfi.S.log || []).join(' | ')));
      throw e;
    });
    console.log(name, 'в эфире за', Date.now() - t, 'мс');
    users.push(u);
  }
  const [A, B] = users;
  await host.waitForFunction(() => window.__wfi.S.roster.length === 3, null, { timeout: 10000 });
  for (const u of users) await u.waitForFunction(() => window.__wfi.S.roster.length === 3);

  const inBytes = (p) => p.evaluate(async () => {
    let b = 0; (await window.__wfi.S.peers.get(window.__wfi.S.hostId).pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived; }); return b;
  });
  const b0 = await inBytes(B);
  await A.evaluate(() => window.__wfi.setTalking(true));
  await A.waitForTimeout(2500);
  const b1 = await inBytes(B);
  assert.ok(b1 - b0 > 4000, `Петя слышит Васю через хаб: +${b1 - b0} Б`);
  console.log(`звук Вася → хаб → Петя: +${b1 - b0} Б за 2,5 с`);
  await A.evaluate(() => window.__wfi.sendHub({ t: 'chat', text: 'онлайн ок' }));
  await B.waitForFunction(() => document.getElementById('msgs').textContent.includes('онлайн ок'));
  console.log('чат — ок');

  // обрыв связи у Васи: сторож сам переподключает без QR
  await A.evaluate(() => window.__wfi.S.peers.get(window.__wfi.S.hostId).pc.close());
  await A.waitForFunction(() => { const p = window.__wfi.S.peers.get(window.__wfi.S.hostId); return p && !p.closed && p.dc.readyState === 'open'; }, null, { timeout: 30000 });
  await host.waitForFunction(() => window.__wfi.S.roster.length === 3, null, { timeout: 10000 });
  console.log('обрыв у Васи → переподключился сам');

  // Петя обновил страницу: «Вернуться в сессию» одной кнопкой, цвет тот же
  const colorB = await host.evaluate(() => window.__wfi.S.roster.find((m) => m.name === 'Петя').color);
  await B.reload();
  await B.waitForFunction(() => document.getElementById('joinBtn').textContent === 'Вернуться в сессию' && !document.getElementById('joinBtn').hidden);
  await B.click('#joinBtn');
  await B.waitForSelector('#main:not([hidden])', { timeout: 30000 });
  await host.waitForFunction((c) => window.__wfi.S.roster.length === 3 && window.__wfi.S.roster.find((m) => m.name === 'Петя')?.color === c, colorB, { timeout: 10000 });
  console.log('Петя обновил страницу → вернулся одной кнопкой, цвет тот же');
  console.log('E2E ONLINE OK');
} catch (e) {
  console.error('E2E ONLINE FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await Promise.race([browser.close(), new Promise((ok) => setTimeout(ok, 5000))]);
  process.exit(process.exitCode ?? 0);
}
