// AudioWorklet: RNNoise (по желанию) + гейт + детектор голоса. Кадр RNNoise — 480 сэмплов при 48 кГц.
const FRAME = 480;

class Proc extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const o = opt.processorOptions || {};
    this.gateDb = o.gateDb ?? -50;
    this.inq = new Float32Array(FRAME * 4); this.inN = 0;
    this.outq = new Float32Array(FRAME * 4); this.outN = 0;
    this.gain = 1; this.hold = 0; this.voice = false; this.peak = 0; this.tick = 0; this.prob = 0;
    if (o.wasm) {
      try {
        let mem;
        const inst = new WebAssembly.Instance(new WebAssembly.Module(o.wasm), {
          a: { a: () => 0, b: (d, s, n) => new Uint8Array(mem.buffer).copyWithin(d, s, s + n) },
        });
        const x = inst.exports;
        mem = x.c;
        x.d();
        this.st = x.f(0);
        this.ptr = x.g(FRAME * 4);
        this.x = x; this.mem = mem;
      } catch (e) { this.port.postMessage({ err: String(e) }); }
    }
    this.port.onmessage = (e) => { if ('gateDb' in e.data) this.gateDb = e.data.gateDb; };
  }

  frame(f) {
    if (this.x) {
      const heap = new Float32Array(this.mem.buffer, this.ptr, FRAME);
      for (let i = 0; i < FRAME; i++) heap[i] = f[i] * 32768;
      this.prob = this.x.j(this.st, this.ptr, this.ptr);
      for (let i = 0; i < FRAME; i++) f[i] = heap[i] / 32768;
    }
    let s = 0;
    for (let i = 0; i < FRAME; i++) s += f[i] * f[i];
    const db = 10 * Math.log10(s / FRAME + 1e-12);
    const loud = db > this.gateDb && (!this.x || this.prob > 0.35);
    if (loud) this.hold = 30; else if (this.hold > 0) this.hold--; // 30 кадров = 300 мс удержания
    this.voice = this.hold > 0;
    const target = this.voice ? 1 : 0.03;
    for (let i = 0; i < FRAME; i++) { this.gain += (target - this.gain) * 0.004; f[i] *= this.gain; }
    this.peak = Math.max(this.peak, db);
  }

  process(inputs, outputs) {
    const inp = inputs[0][0], out = outputs[0][0];
    if (!out) return true;
    if (inp) {
      this.inq.set(inp, this.inN); this.inN += inp.length;
      while (this.inN >= FRAME) {
        const f = this.inq.slice(0, FRAME);
        this.inq.copyWithin(0, FRAME, this.inN); this.inN -= FRAME;
        this.frame(f);
        if (this.outN + FRAME <= this.outq.length) { this.outq.set(f, this.outN); this.outN += FRAME; }
      }
    }
    const n = Math.min(out.length, this.outN);
    out.set(this.outq.subarray(0, n));
    out.fill(0, n);
    this.outq.copyWithin(0, n, this.outN); this.outN -= n;
    if (++this.tick % 16 === 0) { // ~ каждые 43 мс
      this.port.postMessage({ db: this.peak, voice: this.voice });
      this.peak = -100;
    }
    return true;
  }
}

registerProcessor('wfi-proc', Proc);
