// Микрофон → (фильтр голосовой полосы) → worklet (RNNoise, гейт, детектор голоса) → трек для WebRTC.
(function (root) {
  let wasm = null;
  async function loadWasm() {
    if (!wasm) wasm = await (await fetch('vendor/rnnoise.wasm')).arrayBuffer();
    return wasm;
  }

  /**
   * opts: { ns: 'builtin'|'rnnoise'|'off', band: bool, gateDb: number }
   * onLevel({db, voice}) — для индикатора и режима «по голосу».
   */
  async function start(opts, onLevel) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, // без наушников звук из динамика иначе вернётся в микрофон
        autoGainControl: true,
        noiseSuppression: opts.ns === 'builtin',
        channelCount: 1,
      },
    });
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.resume();
    await ctx.audioWorklet.addModule('js/proc-worklet.js');
    let node = ctx.createMediaStreamSource(stream);
    if (opts.band) {
      const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 150, Q: 0.7 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4000, Q: 0.7 });
      node.connect(hp); hp.connect(lp); node = lp;
    }
    const useRnn = opts.ns === 'rnnoise' && ctx.sampleRate === 48000;
    const proc = new AudioWorkletNode(ctx, 'wfi-proc', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { gateDb: opts.gateDb, wasm: useRnn ? (await loadWasm()).slice(0) : null },
    });
    proc.port.onmessage = (e) => { if (e.data.err) console.warn('rnnoise', e.data.err); else onLevel?.(e.data); };
    const dest = ctx.createMediaStreamDestination();
    node.connect(proc); proc.connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    return {
      track,
      raw: stream,
      rnnoise: useRnn,
      setGate: (gateDb) => proc.port.postMessage({ gateDb }),
      alive: () => stream.getAudioTracks().every((t) => t.readyState === 'live') && ctx.state !== 'closed',
      stop() { stream.getTracks().forEach((t) => t.stop()); track.stop(); ctx.close().catch(() => {}); },
    };
  }

  // Короткий сигнал (вызов, вход в эфир) — без файлов.
  let bctx;
  function beep(freqs = [880, 1320], dur = 0.12) {
    bctx = bctx || new AudioContext();
    bctx.resume();
    let t = bctx.currentTime;
    for (const f of freqs) {
      const o = bctx.createOscillator(), g = bctx.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(bctx.destination); o.start(t); o.stop(t + dur); t += dur;
    }
  }

  root.WFI_AUDIO = { start, beep };
})(typeof window !== 'undefined' ? window : globalThis);
