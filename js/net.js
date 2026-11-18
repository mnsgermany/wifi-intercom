// Сетка WebRTC: каждый с каждым напрямую по Wi-Fi. Канал данных 'ctl' + один аудио-трансивер.
// Первое рукопожатие идёт через boot (брокер, QR или хаб), дальнейшие — по самому каналу данных.
(function (root) {
  // Только локальные кандидаты: STUN/TURN не нужны в одной сети и не работают без интернета.
  const RTC = { iceServers: [] };

  function gathered(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((ok) => {
      const t = setTimeout(ok, 2500);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); }
      });
    });
  }

  class Peer {
    constructor(id, { initiator, boot, onMsg, onTrack, onOpen, onClose }) {
      Object.assign(this, { id, initiator, polite: !initiator, boot, onMsg, onTrack, onOpen, onClose });
      this.making = false;
      this.closed = false;
      this.track = null; // что сейчас отдаём этому собеседнику (микрофон или null)
      const pc = this.pc = new RTCPeerConnection(RTC);
      this.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
      this.dc.onopen = () => {
        if (initiator && !this.tx) {
          this.tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
          this.tx.sender.replaceTrack(this.track).catch(() => {});
        }
        onOpen?.(this);
      };
      this.dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'sig') this.signal(m.desc); else onMsg?.(m, this);
      };
      this.dc.onclose = () => this.close();
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close();
      };
      pc.ontrack = (e) => {
        // ответчик тоже хочет говорить: направление ставим до ответа, перепереговоров не будет
        if (e.transceiver.direction !== 'sendrecv') e.transceiver.direction = 'sendrecv';
        this.tx = e.transceiver;
        try { e.receiver.jitterBufferTarget = 0; } catch { /* Safari без поддержки */ }
        this.tx.sender.replaceTrack(this.track).catch(() => {});
        onTrack?.(e.track, this);
      };
      pc.onnegotiationneeded = () => this.negotiate();
    }

    async negotiate() {
      if (!this.initiator && this.dc.readyState !== 'open') return; // первым предлагает инициатор
      try {
        this.making = true;
        await this.pc.setLocalDescription();
        await gathered(this.pc);
        this.send2(this.pc.localDescription.toJSON());
      } catch (e) { console.warn('negotiate', e); } finally { this.making = false; }
    }

    async signal(desc) {
      const pc = this.pc;
      const collision = desc.type === 'offer' && (this.making || pc.signalingState !== 'stable');
      if (collision && !this.polite) return;
      try {
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          await gathered(pc);
          this.send2(pc.localDescription.toJSON());
        }
      } catch (e) { console.warn('signal', e); }
    }

    send2(desc) {
      if (this.dc.readyState === 'open') this.dc.send(JSON.stringify({ t: 'sig', desc }));
      else this.boot(desc);
    }

    send(m) { if (this.dc.readyState === 'open') this.dc.send(JSON.stringify(m)); }

    setTrack(track) {
      if (this.track === track) return;
      this.track = track;
      this.tx?.sender.replaceTrack(track).catch(() => {});
    }

    async stats() {
      const out = { rtt: null, jb: null };
      try {
        (await this.pc.getStats()).forEach((s) => {
          if (s.type === 'candidate-pair' && s.nominated && s.currentRoundTripTime != null) out.rtt = s.currentRoundTripTime * 1000;
          if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.jitterBufferEmittedCount) {
            out.jb = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
          }
        });
      } catch { /* закрыт */ }
      return out;
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      try { this.pc.close(); } catch { /* уже */ }
      this.onClose?.(this);
    }
  }

  // Хаб: список участников и каналов, пересылка служебных сообщений. Звук через него не идёт.
  const COLORS = ['#ff5c5c', '#ffb020', '#3ddc84', '#38bdf8', '#c084fc', '#f472b6', '#facc15', '#2dd4bf', '#fb923c', '#a3e635'];

  class Hub {
    constructor({ hostId, channels, trialEnd }) {
      this.hostId = hostId;
      this.channels = channels;
      this.trialEnd = trialEnd; // null = лицензия
      this.members = new Map();
      this.links = new Map(); // id → send(m)
      this.n = 0;
    }

    attach(id, send) { this.links.set(id, send); }

    detach(id) {
      this.links.delete(id);
      if (this.members.delete(id)) this.roster();
    }

    to(id, m) { this.links.get(id)?.(m); }
    all(m) { for (const send of this.links.values()) send(m); }

    roster() {
      this.all({ t: 'roster', members: [...this.members.values()], channels: this.channels, host: this.hostId, trialEnd: this.trialEnd });
    }

    onMessage(id, m) {
      const me = this.members.get(id);
      switch (m.t) {
        case 'hello': {
          const info = { id, name: String(m.name || 'Без имени').slice(0, 24), role: String(m.role || '').slice(0, 16),
            listen: m.listen || [], talk: m.talk || '', talking: false, color: COLORS[this.n++ % COLORS.length] };
          this.members.set(id, info);
          this.to(id, { t: 'welcome', id, color: info.color });
          this.roster();
          break;
        }
        case 'update':
          if (!me) return;
          for (const k of ['name', 'role', 'listen', 'talk']) if (k in m) me[k] = m[k];
          this.roster();
          break;
        case 'relay':
          if (this.links.has(m.to)) this.to(m.to, { t: 'relay', from: id, data: m.data });
          break;
        case 'talk':
          if (!me) return;
          me.talking = !!m.on;
          this.all({ t: 'talk', id, on: me.talking, ch: me.talk });
          break;
        case 'stt':
          this.all({ t: 'stt', id, text: String(m.text).slice(0, 400), final: !!m.final });
          break;
        case 'chat':
          this.all({ t: 'chat', id, text: String(m.text).slice(0, 500), ts: Date.now() });
          break;
        case 'call':
          this.all({ t: 'call', id, ch: m.ch });
          break;
        case 'channels':
          if (id !== this.hostId || !Array.isArray(m.list)) return;
          this.channels = m.list.map((c) => String(c).slice(0, 20)).filter(Boolean).slice(0, 12);
          this.roster();
          break;
      }
    }

    end(reason) { this.all({ t: 'end', reason }); }
  }

  root.WFI_NET = { Peer, Hub, COLORS };
})(typeof window !== 'undefined' ? window : globalThis);
