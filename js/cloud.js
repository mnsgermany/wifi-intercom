// Облачный режим: звук через Cloudflare Realtime SFU (каждый телефон — одно соединение с ближайшим
// сервером Cloudflare), служебные сообщения — через WebSocket-комнату нашего Worker.
(function (root) {
  const API = 'https://wifi-intercom.WORKERS_SUBDOMAIN.workers.dev';

  /** Комната с автопереподключением. onMsg(m) — входящие, onState('open'|'closed'). */
  function room(name, id, onMsg, onState) {
    let ws = null, closed = false;
    const queue = [];
    const open = () => {
      ws = new WebSocket(API.replace(/^http/, 'ws') + '/room/' + name + '?id=' + id);
      ws.onopen = () => { onState?.('open'); for (const s of queue.splice(0)) ws.send(s); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
      ws.onclose = (e) => {
        onState?.('closed');
        if (!closed && e.code !== 4000) setTimeout(open, 1500); // 4000 — нас заменило новое подключение
      };
    };
    open();
    return {
      send(m) { const s = JSON.stringify(m); if (ws.readyState === 1) ws.send(s); else queue.push(s); },
      close() { closed = true; ws.close(); },
    };
  }

  async function api(path, method, body) {
    const r = await fetch(API + '/sfu/' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errorCode) throw new Error(j.errorDescription || 'Облако ответило ' + r.status);
    return j;
  }

  /**
   * Своя сессия в SFU: публикуем микрофон как трек 'mic', забираем чужие.
   * onTrack(track, memberId), onState(iceState).
   */
  async function sfu(onTrack, onState) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    pc.oniceconnectionstatechange = () => onState?.(pc.iceConnectionState);
    const mids = new Map(); // mid → id участника
    pc.ontrack = (e) => onTrack(e.track, mids.get(e.transceiver.mid));
    const { sessionId } = await api('sessions/new', 'POST');
    const tx = pc.addTransceiver('audio', { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    const pub = await api(`sessions/${sessionId}/tracks/new`, 'POST', {
      sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp },
      tracks: [{ location: 'local', mid: tx.mid, trackName: 'mic' }],
    });
    await pc.setRemoteDescription(pub.sessionDescription);
    const connected = new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error('Нет связи с облаком')), 15000);
      const check = () => { if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') { clearTimeout(t); ok(); } };
      pc.addEventListener('iceconnectionstatechange', check); check();
    });

    // SFU требует проводить изменения по одному
    let chain = Promise.resolve();
    const serial = (fn) => (chain = chain.catch(() => {}).then(fn));

    return {
      sessionId, pc, connected,
      setTrack: (t) => tx.sender.replaceTrack(t),
      /** list: [{id, session}] → массив true/false: получилось ли забрать. */
      pull: (list) => serial(async () => {
        const r = await api(`sessions/${sessionId}/tracks/new`, 'POST', {
          tracks: list.map((x) => ({ location: 'remote', sessionId: x.session, trackName: 'mic' })),
        });
        const ok = (r.tracks || []).map((t, i) => { if (!t.errorCode && t.mid != null) mids.set(String(t.mid), list[i].id); return !t.errorCode; });
        if (r.requiresImmediateRenegotiation) {
          await pc.setRemoteDescription(r.sessionDescription);
          await pc.setLocalDescription(await pc.createAnswer());
          await api(`sessions/${sessionId}/renegotiate`, 'PUT', { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp } });
        }
        return ok;
      }),
      drop: (id) => serial(async () => {
        const mid = [...mids].find(([, v]) => v === id)?.[0];
        if (mid == null) return;
        mids.delete(mid);
        await api(`sessions/${sessionId}/tracks/close`, 'PUT', { tracks: [{ mid }], force: true });
      }),
      close: () => pc.close(),
    };
  }

  root.WFI_CLOUD = { room, sfu, configured: !API.includes('WORKERS_SUBDOMAIN') };
})(typeof window !== 'undefined' ? window : globalThis);
