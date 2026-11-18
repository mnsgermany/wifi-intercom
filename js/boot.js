// Знакомство телефонов: онлайн через публичный MQTT-брокер (бесплатно, без регистрации),
// офлайн — сжатый SDP в QR. Звук через брокер никогда не идёт, только первое рукопожатие.
(function (root) {
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
  ];
  const enc = new TextEncoder(), dec = new TextDecoder();

  const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  async function pipe(bytes, Stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw')));
    return new Uint8Array(await out.arrayBuffer());
  }
  // Для QR: в одной Wi-Fi нужны только UDP IPv4 (или .local) кандидаты — QR становится в разы проще.
  function slim(desc) {
    const keep = (l) => {
      if (l.startsWith('a=candidate:')) {
        const f = l.split(' ');
        return f[2].toLowerCase() === 'udp' && !f[4].includes(':');
      }
      return !/^a=(extmap-allow-mixed|msid-semantic|ice-options)/.test(l);
    };
    return { type: desc.type, sdp: desc.sdp.split('\r\n').filter((l) => l && keep(l)).join('\r\n') + '\r\n' };
  }

  const pack = async (obj) => b64u(await pipe(enc.encode(JSON.stringify(obj)), CompressionStream));
  const unpack = async (s) => JSON.parse(dec.decode(await pipe(unb64u(s), DecompressionStream)));

  // --- минимальный MQTT 3.1.1 поверх WebSocket: CONNECT, SUBSCRIBE, PUBLISH QoS0, PING ---
  const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
  function packet(type, body) {
    const len = []; let n = body.length;
    do { let d = n % 128; n = Math.floor(n / 128); if (n) d |= 128; len.push(d); } while (n);
    return new Uint8Array([type, ...len, ...body]);
  }

  function mqtt(url, onPublish) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      let buf = new Uint8Array(0), ping, done = false;
      const fail = (e) => { if (!done) { done = true; reject(e); } };
      const t = setTimeout(() => { fail(new Error('timeout')); ws.close(); }, 15000);
      ws.onerror = () => fail(new Error('ws'));
      ws.onclose = () => { clearInterval(ping); fail(new Error('closed')); };
      ws.onopen = () => ws.send(packet(0x10, [...str('MQTT'), 4, 2, 0, 30, ...str('wfi' + Math.random().toString(36).slice(2, 12))]));
      ws.onmessage = (e) => {
        const add = new Uint8Array(e.data), nb = new Uint8Array(buf.length + add.length);
        nb.set(buf); nb.set(add, buf.length); buf = nb;
        for (;;) {
          let mul = 1, len = 0, i = 1, d;
          do { if (i >= buf.length) return; d = buf[i++]; len += (d & 127) * mul; mul *= 128; } while (d & 128);
          if (buf.length < i + len) return;
          const type = buf[0] >> 4, body = buf.subarray(i, i + len);
          buf = buf.slice(i + len);
          if (type === 2) { // CONNACK
            clearTimeout(t);
            if (body[1] !== 0) { fail(new Error('refused')); ws.close(); return; }
            done = true;
            ping = setInterval(() => ws.readyState === 1 && ws.send(new Uint8Array([0xC0, 0])), 20000);
            resolve({
              sub: (topic) => ws.send(packet(0x82, [0, 1, ...str(topic), 0])),
              pub: (topic, payload) => ws.send(packet(0x30, [...str(topic), ...enc.encode(payload)])),
              close: () => ws.close(),
            });
          } else if (type === 3) { // PUBLISH (QoS0)
            const tl = (body[0] << 8) | body[1];
            onPublish(dec.decode(body.subarray(2, 2 + tl)), dec.decode(body.subarray(2 + tl)));
          }
        }
      };
    });
  }

  // Шифруем рукопожатие ключом из QR: брокер публичный, а SDP знать посторонним незачем.
  async function room(k) {
    const raw = unb64u(k);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    const base = 'wfintercom/' + [...h.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return {
      base,
      async seal(obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
        return b64u(new Uint8Array([...iv, ...ct]));
      },
      async open(s) {
        const b = unb64u(s);
        return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, key, b.slice(12))));
      },
    };
  }

  /** Входящий: самый быстрый живой брокер. Возвращает {broker, sub, pub, close}. */
  async function connect(onPublish) {
    let winner = null;
    const tries = BROKERS.map((url, i) => mqtt(url, (t, p) => winner?.broker === i && onPublish(t, p)).then((c) => {
      if (winner) { c.close(); throw new Error('late'); } // опоздавшие закрываем
      return (winner = Object.assign(c, { broker: i }));
    }));
    try { return await Promise.any(tries); } catch { throw new Error('Нет связи с брокером'); }
  }

  /**
   * Хаб: слушает все брокеры, до которых дотянулся, — входящий может попасть на любой.
   * onPublish(topic, payload, client) — отвечать через тот же client. onEach(client) — для каждого подключения.
   * Промис — когда подключился первый; остальные досоединяются сами.
   */
  function connectAll(onPublish, onEach) {
    const all = [];
    const tries = BROKERS.map((url, i) => {
      let c = null;
      return mqtt(url, (t, p) => c && onPublish(t, p, c)).then((x) => {
        c = Object.assign(x, { broker: i });
        all.push(c);
        onEach(c);
        return all;
      });
    });
    return Promise.any(tries).catch(() => { throw new Error('Нет связи с брокером'); });
  }

  root.WFI_BOOT = { connect, connectAll, room, pack, unpack, slim, b64u, BROKERS };
})(typeof window !== 'undefined' ? window : globalThis);
