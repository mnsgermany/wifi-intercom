// Самопроверка без браузера: упаковка QR, шифр рукопожатия, маршрутизация хаба, ключ, живой MQTT-брокер.
// Запуск: node test/selfcheck.mjs [--net]
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('..', import.meta.url));
for (const f of ['js/boot.js', 'js/net.js', 'js/license.js']) vm.runInThisContext(readFileSync(dir + f, 'utf8'), { filename: f });
const { WFI_BOOT: BOOT, WFI_NET: NET, WFI_LICENSE: LIC } = globalThis;

// QR: упаковка и распаковка SDP
const obj = { h: 'a1b2c3d4e5', d: { type: 'offer', sdp: 'v=0\r\n'.repeat(80) } };
const packed = await BOOT.pack(obj);
assert.deepEqual(await BOOT.unpack(packed), obj);
assert.ok(packed.length < 200, 'сжатие работает');

// шифр рукопожатия: свой ключ открывает, чужой — нет
const k = BOOT.b64u(crypto.getRandomValues(new Uint8Array(16)));
const r1 = await BOOT.room(k), r2 = await BOOT.room(BOOT.b64u(crypto.getRandomValues(new Uint8Array(16))));
const sealed = await r1.seal({ pid: 'x', desc: { type: 'offer' } });
assert.equal((await r1.open(sealed)).pid, 'x');
await assert.rejects(r2.open(sealed));
assert.notEqual(r1.base, r2.base);

// хаб: hello → welcome + roster, relay только адресату, каналы меняет только хаб
const hub = new NET.Hub({ hostId: 'H', channels: ['Общий', 'Звук'], trialEnd: null });
const inbox = { H: [], A: [], B: [] };
for (const id of Object.keys(inbox)) hub.attach(id, (m) => inbox[id].push(m));
hub.onMessage('H', { t: 'hello', name: 'Хаб', listen: ['Общий'], talk: 'Общий' });
hub.onMessage('A', { t: 'hello', name: 'Вася', listen: ['Звук'], talk: 'Звук' });
assert.ok(inbox.A.some((m) => m.t === 'welcome' && m.id === 'A'));
assert.equal(inbox.B.at(-1).members.length, 2);
hub.onMessage('A', { t: 'relay', to: 'B', data: { desc: 1 } });
assert.deepEqual(inbox.B.at(-1), { t: 'relay', from: 'A', data: { desc: 1 } });
assert.ok(!inbox.H.some((m) => m.t === 'relay'));
hub.onMessage('A', { t: 'channels', list: ['Взлом'] });
assert.deepEqual(hub.channels, ['Общий', 'Звук']);
hub.onMessage('H', { t: 'channels', list: ['Общий', 'Свет'] });
assert.deepEqual(inbox.A.at(-1).channels, ['Общий', 'Свет']);
hub.onMessage('A', { t: 'chat', text: '<b>x</b>' });
assert.equal(inbox.H.at(-1).text, '<b>x</b>'); // экранирует интерфейс (textContent)
hub.detach('A');
assert.equal(inbox.H.at(-1).members.length, 1);

// ключ: подписываем тем же private.pem, что и бот
const pem = dir + '../qlab_wave/license/private.pem';
const email = 'test@example.com';
const key = execFileSync('sh', ['-c', `printf '%s' 'WiFiIntercom-1|${email}' | openssl dgst -sha256 -sign "${pem}" | base64 | tr -d '\\n'`]).toString();
assert.equal(await LIC.valid(email, key), true);
assert.equal(await LIC.valid(' TEST@example.com ', key), true);
assert.equal(await LIC.valid('other@example.com', key), false);
const riderKey = execFileSync('sh', ['-c', `printf '%s' 'RiderStudio-1|${email}|0000000000000000' | openssl dgst -sha256 -sign "${pem}" | base64 | tr -d '\\n'`]).toString();
assert.equal(await LIC.valid(email, riderKey), false, 'ключи других программ не подходят');

// живой брокер: два клиента, сообщение доходит
if (process.argv.includes('--net')) {
  let got;
  const a = await BOOT.connect((t, p) => { got = [t, p]; });
  const b = await BOOT.connect(() => {}, a.broker);
  const topic = r1.base + '/selftest';
  a.sub(topic);
  await new Promise((ok) => setTimeout(ok, 800));
  b.pub(topic, sealed);
  for (let i = 0; i < 40 && !got; i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(got, [topic, sealed]);
  console.log('брокер', BOOT.BROKERS[a.broker], 'ok');
  a.close(); b.close();
}
console.log('selfcheck ok');
