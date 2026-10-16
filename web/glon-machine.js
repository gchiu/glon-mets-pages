
const MAX_TOKEN = 63;   // glon_event / glon_event_value token limit (ABI §2.4)
const MAX_VALUE = 200;  // glon_event_value value limit (ABI §2.4)

export class GlonMachine {
  static async create(wasmBytes, { log = () => {} } = {}) {
    const m = new GlonMachine();
    m.log = log;
    const dec = new TextDecoder();
    const view = () => new Uint8Array(m.ex.memory.buffer);   // fresh: memory may grow
    const imports = {
      env: {
        host_print: (p, n) => m.log(dec.decode(view().subarray(p, p + n))),
        host_set_text: () => {},
        host_set_html: (h, p, n) => { m.html = dec.decode(view().subarray(p, p + n)); m.renders++; },
        host_canvas_script: () => {},
      },
    };
    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    m.ex = instance.exports;
    m.view = view;
    m.enc = new TextEncoder();
    m.html = "";
    m.renders = 0;
    if (m.ex.glon_init() !== 0) throw new Error("glon_init failed");
    return m;
  }

  put(str) {
    const b = this.enc.encode(str);
    const p = this.ex.glon_alloc(b.length);
    if (p === 0) throw new Error("glon_alloc failed (" + b.length + " bytes)");
    this.view().set(b, p);
    return [p, b.length];
  }

  load(src, name = "source") {
    const [p, n] = this.put(src);
    const rc = this.ex.glon_load(p, n);
    if (rc !== 0) throw new Error(`glon_load(${name}) failed rc=${rc} (${n} bytes)`);
  }

  event(token, value) {
    if (!token || token.length > MAX_TOKEN || /[\[\]':\s]/.test(token)) throw new Error("bad event token: " + token);
    const before = this.renders;
    let rc;
    if (value === undefined) {
      const [t, tn] = this.put(token);
      rc = this.ex.glon_event(t, tn);
    } else {
      const v = String(value);
      if (this.enc.encode(v).length > MAX_VALUE) throw new Error("event value over 200 bytes: " + token);
      const [t, tn] = this.put(token);
      const [vp, vn] = this.put(v);
      rc = this.ex.glon_event_value(t, tn, vp, vn);
    }
    if (rc !== 0) throw new Error(`glon event '${token}' failed rc=${rc}`);
    if (this.renders === before) throw new Error(`glon event '${token}' rendered nothing`);
    return this.html;
  }

  run(src) {
    const [p, n] = this.put(src);
    this.ex.glon_run(p, n);
    const ptr = this.ex.glon_result_ptr();
    return new TextDecoder().decode(this.view().subarray(ptr, ptr + this.ex.glon_result_len()));
  }
}
