// The Decide heads (model/dtw_model.py DecideHeads) in plain JavaScript, applied
// to token states from llama-server. A few small matrix-vector products per
// item: microseconds next to the encoder pass.
import fs from 'fs';
import path from 'path';

export function loadHeads(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'heads.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(dir, 'heads.bin'));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const T = {};
  for (const [name, t] of Object.entries(meta.tensors)) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    T[name] = { data: all.subarray(t.offset, t.offset + n), shape: t.shape };
  }
  return { meta, T };
}

/** y = W x + b for a torch Linear (W: [out, in]). */
function linear(T, prefix, x) {
  const W = T[`${prefix}.weight`]; const b = T[`${prefix}.bias`];
  const [o, i] = W.shape; const y = new Float32Array(o);
  for (let r = 0; r < o; r++) {
    let s = b ? b.data[r] : 0; const off = r * i;
    for (let c = 0; c < i; c++) s += W.data[off + c] * x[c];
    y[r] = s;
  }
  return y;
}
const gelu = (v) => v.map((x) => 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x))));
export function softmax(v, temp = 1) {
  const m = Math.max(...v); const e = Array.from(v, (x) => Math.exp((x - m) / temp)); const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}
const argmax = (v) => { let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i; return k; };
function mean(H, a, b) {
  const d = H[0].length; const m = new Float32Array(d);
  for (let t = a; t < b; t++) for (let j = 0; j < d; j++) m[j] += H[t][j];
  for (let j = 0; j < d; j++) m[j] /= (b - a);
  return m;
}
const cat = (...xs) => { const n = xs.reduce((s, x) => s + x.length, 0); const o = new Float32Array(n); let k = 0; for (const x of xs) { o.set(x, k); k += x.length; } return o; };

export function createHeads(dir) {
  const { meta, T } = loadHeads(dir);
  const temp = meta.temperature || { kind: 1, cert: 1 };
  return {
    meta,
    /** Tag ids per token. */
    tags(H) { return H.map((h) => argmax(linear(T, 'tag.1', h))); },
    gate(ctx) { const z = linear(T, 'gate.1', ctx)[0]; return 1 / (1 + Math.exp(-z)); },
    span(H, ctx, a, b) {
      const z = gelu(linear(T, 'span.1', cat(mean(H, a, b), H[a], ctx)));
      const kind = softmax(linear(T, 'kind', z), temp.kind); const cert = softmax(linear(T, 'cert', z), temp.cert);
      const about = softmax(linear(T, 'about', z)); const imp = 1 / (1 + Math.exp(-linear(T, 'imp', z)[0]));
      return {
        kind: meta.kinds[argmax(kind)], kindP: Math.max(...kind), cert: meta.certs[argmax(cert)], certP: Math.max(...cert),
        certDist: Object.fromEntries(meta.certs.map((c, i) => [c, cert[i]])), about: meta.abouts[argmax(about)], importance: imp,
      };
    },
    /** Merge target: -1 = new, k = known memory k; relation for the chosen memory. */
    merge(H, a, b, mems) {
      if (!mems.length) return { target: -1, p: 1, relation: null };
      const s = mean(H, a, b);
      const logits = [linear(T, 'new', s)[0]]; const rels = [];
      for (const [ma, mb] of mems) {
        const m = mean(H, ma, mb);
        const z = gelu(linear(T, 'pair.1', cat(s, m, s.map((x, i) => x * m[i]))));
        logits.push(linear(T, 'pair_score', z)[0]); rels.push(softmax(linear(T, 'pair_rel', z)));
      }
      const p = softmax(logits); const k = argmax(p);
      return { target: k - 1, p: p[k], relation: k > 0 ? meta.rels[argmax(rels[k - 1])] : null };
    },
  };
}
