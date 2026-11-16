// Songbook converter: screenshots -> tab / chord names, entirely in the browser.
// Image pixels never leave the machine: line detection is plain JS on a canvas, digit/letter
// reading uses Tesseract.js (WASM, runs locally; only its code + English model are fetched from a CDN).
(function(global){
"use strict";

const TESS_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
let _tessP = null;
// two workers: Tesseract adapts to what it has just read, so reading many digits
// made it miss single letters like "F". Frets and chord names never share a worker.
const _workers = {};
function loadTesseract(){
  if(global.Tesseract) return Promise.resolve(global.Tesseract);
  if(!_tessP) _tessP = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = TESS_URL;
    s.onload = () => res(global.Tesseract); s.onerror = () => { _tessP = null; rej(new Error("Couldn't load the OCR engine")); };
    document.head.appendChild(s);
  });
  return _tessP;
}
function getWorker(name){
  if(!_workers[name]) _workers[name] = (async () => { const T = await loadTesseract(); return T.createWorker("eng"); })()
    .catch(e => { delete _workers[name]; throw e; });
  return _workers[name];
}

// ---------- image helpers ----------
function loadImage(src){ return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Couldn't open the image")); i.src = src; }); }
function toGray(img){
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", {willReadFrequently: true}); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for(let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000;
  return {w, h, g, canvas: c};
}
// ink mask by local contrast. dark=true: ink darker than its surroundings.
function inkMask(G, dark, r, k){
  const {w, h, g} = G, W = w + 1, I = new Float64Array(W * (h + 1));
  for(let y = 0; y < h; y++){ let s = 0; for(let x = 0; x < w; x++){ s += g[y*w+x]; I[(y+1)*W + x+1] = I[y*W + x+1] + s; } }
  const m = new Uint8Array(w * h);
  for(let y = 0; y < h; y++){
    const y0 = Math.max(0, y-r), y1 = Math.min(h, y+r+1);
    for(let x = 0; x < w; x++){
      const x0 = Math.max(0, x-r), x1 = Math.min(w, x+r+1);
      const mean = (I[y1*W+x1] - I[y0*W+x1] - I[y1*W+x0] + I[y0*W+x0]) / ((y1-y0) * (x1-x0));
      const v = g[y*w+x];
      m[y*w+x] = dark ? (v < mean - k ? 1 : 0) : (v > mean + k ? 1 : 0);
    }
  }
  return m;
}

// ---------- staff detection ----------
function lineCandidates(m, w, h){
  const maxGap = Math.max(4, Math.round(w * 0.045)), minRun = Math.round(w * 0.22);
  const rows = [];
  for(let y = 0; y < h; y++){
    let best = null, start = -1, last = -1, cnt = 0;
    for(let x = 0; x <= w; x++){
      const on = x < w && m[y*w+x];
      if(on){ if(start < 0 || x - last > maxGap){ if(start >= 0 && last - start >= minRun && (!best || last-start > best.x1-best.x0) && cnt > (last-start)*0.6) best = {x0:start, x1:last}; start = x; cnt = 0; } last = x; cnt++; }
    }
    if(start >= 0 && last - start >= minRun && (!best || last-start > best.x1-best.x0) && cnt > (last-start)*0.6) best = {x0:start, x1:last};
    rows.push(best);
  }
  // merge consecutive rows into lines
  const lines = [];
  for(let y = 0; y < h; y++){
    const r = rows[y]; if(!r) continue;
    const L = lines[lines.length - 1];
    if(L && L.yEnd === y - 1 && Math.min(L.x1, r.x1) - Math.max(L.x0, r.x0) > 0.5 * (r.x1 - r.x0)){ L.yEnd = y; L.x0 = Math.min(L.x0, r.x0); L.x1 = Math.max(L.x1, r.x1); }
    else lines.push({yStart: y, yEnd: y, x0: r.x0, x1: r.x1});
  }
  return lines.filter(L => L.yEnd - L.yStart < 12).map(L => Object.assign(L, {y: (L.yStart + L.yEnd) / 2, th: L.yEnd - L.yStart + 1}));
}
function findStaves(lines, n){
  n = n || 6;
  const out = []; let i = 0;
  // pick n evenly spaced lines starting at line i; a stray partial line squeezed between two
  // staff lines (e.g. a row of dashes touching a line) is skipped instead of breaking the staff
  function pick(i){
    for(let j = i + 1; j < lines.length && j <= i + 3; j++){
      const sp0 = lines[j].y - lines[i].y; if(sp0 < 6) continue;
      const tol = Math.max(2, sp0 * 0.22), g = [lines[i], lines[j]], idx = [i, j];
      for(let k = j + 1; k < lines.length && g.length < n; k++){
        const d = lines[k].y - g[g.length-1].y;
        if(d < sp0 - tol) continue;
        if(d > sp0 + tol) break;
        // several candidates at about the right place: take the longest one
        let kb = k;
        for(let q = k + 1; q < lines.length && lines[q].y - g[g.length-1].y <= sp0 + tol; q++)
          if(lines[q].x1 - lines[q].x0 > lines[kb].x1 - lines[kb].x0) kb = q;
        k = kb; g.push(lines[k]); idx.push(k);
      }
      if(g.length < n) continue;
      const gaps = []; for(let k = 1; k < n; k++) gaps.push(g[k].y - g[k-1].y);
      const sp = gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)];
      if(!gaps.every(d => Math.abs(d - sp) <= Math.max(2, sp * 0.22))) continue;
      const x0s = g.map(L=>L.x0).sort((a,b)=>a-b), x1s = g.map(L=>L.x1).sort((a,b)=>a-b);
      const x0 = x0s[Math.floor(n/2)], x1 = x1s[Math.floor(n/2)];
      if(!g.every(L => Math.min(L.x1, x1) - Math.max(L.x0, x0) > 0.6 * (x1 - x0))) continue;
      return {st: {lines: g, sp, x0, x1, y0: g[0].y, y1: g[n-1].y}, last: idx[idx.length-1]};
    }
    return null;
  }
  while(i + n <= lines.length){
    const p = pick(i);
    if(p){ out.push(p.st); i = p.last + 1; } else i++;
  }
  return out;
}

// ---------- components ----------
function components(m, w, x0, y0, x1, y1){
  const seen = new Uint8Array(w * (y1 + 1)), comps = [], stack = [];
  for(let y = y0; y <= y1; y++) for(let x = x0; x <= x1; x++){
    const p = y*w + x; if(!m[p] || seen[p]) continue;
    let c = {x0: x, x1: x, y0: y, y1: y, n: 0, px: []}; seen[p] = 1; stack.push(p);
    while(stack.length){
      const q = stack.pop(), qx = q % w, qy = (q - qx) / w;
      c.n++; c.px.push(q);
      if(qx < c.x0) c.x0 = qx; if(qx > c.x1) c.x1 = qx; if(qy < c.y0) c.y0 = qy; if(qy > c.y1) c.y1 = qy;
      for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++){
        const nx = qx + dx, ny = qy + dy; if(nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
        const r = ny*w + nx; if(m[r] && !seen[r]){ seen[r] = 1; stack.push(r); }
      }
    }
    comps.push(c);
  }
  return comps;
}

// ---------- read one staff ----------
function analyseStaff(G, m, st){
  const {w} = G, sp = st.sp;
  const mm = m.slice();
  // 1. remove the staff lines, including the short dashes between closely packed frets
  //    ("0-0-0" would otherwise stay glued into one blob), but keep columns where a digit
  //    stroke continues both above and below the line (also diagonally, for 2/7/4)
  //    a) pixels in long horizontal runs (the line itself), unless a stroke crosses there
  //    b) short runs too when nothing is inked above or below them within half a gap (a dash)
  const xa = Math.max(0, st.x0 - 4), xb = Math.min(w - 1, st.x1 + 4), longRun = Math.max(6, sp * 0.9);
  const inkAt = (y, x) => y >= 0 && y < G.h && ((x > 0 && m[y*w+x-1]) || m[y*w+x] || (x < w-1 && m[y*w+x+1]));
  const reach = Math.max(3, Math.round(sp * 0.4));
  for(const L of st.lines){
    const a = Math.max(0, L.yStart - 1), b = Math.min(G.h - 1, L.yEnd + 1), up = a - 1, dn = b + 1;
    const lonely = x => { for(let d = 0; d < reach; d++){ const yu = up - d, yd = dn + d;
      if((yu >= 0 && m[yu*w+x]) || (yd < G.h && m[yd*w+x])) return false; } return true; };
    for(let y = a; y <= b; y++){
      let s = -1;
      for(let x = xa; x <= xb + 1; x++){
        const on = x <= xb && m[y*w+x];
        if(on && s < 0) s = x;
        if(!on && s >= 0){
          const long = x - s >= longRun;
          for(let k = s; k < x; k++){
            if(long ? !(inkAt(up, k) && inkAt(dn, k)) : lonely(k)) mm[y*w+k] = 0;
          }
          s = -1;
        }
      }
    }
  }
  // 2. bar lines: columns inked through (almost) the whole staff height
  const bars = [], H = st.y1 - st.y0;
  let run = null;
  for(let x = Math.max(0, st.x0 - 6); x <= Math.min(w - 1, st.x1 + 6); x++){
    let c = 0; for(let y = Math.round(st.y0); y <= Math.round(st.y1); y++) c += m[y*w+x];
    if(c >= H * 0.88){ if(run && x - run.x1 <= 1) run.x1 = x; else { run = {x0: x, x1: x}; bars.push(run); } }
  }
  const realBars = bars.filter(b => b.x1 - b.x0 <= Math.max(3, sp * 0.3));
  for(const b of realBars) for(let x = b.x0 - 1; x <= b.x1 + 1; x++) for(let y = Math.round(st.y0 - sp*0.3); y <= Math.round(st.y1 + sp*0.3); y++) if(x >= 0 && x < w) mm[y*w+x] = 0;
  // 3. glyphs between first and last line (+ half a gap)
  const by0 = Math.max(0, Math.round(st.y0 - sp * 0.6)), by1 = Math.min(G.h - 1, Math.round(st.y1 + sp * 0.6));
  // a glyph on one string can touch the glyph on the next string through a bit of kept staff line
  // (e.g. a 0 above an X in the same column): cut such tall blobs halfway between the lines
  const mids = []; for(let i = 0; i + 1 < st.lines.length; i++) mids.push((st.lines[i].y + st.lines[i+1].y) / 2);
  const bandOf = y => { let b = 0; while(b < mids.length && y > mids[b]) b++; return b; };
  const splitTall = c => {
    const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
    if(ch <= sp * 1.35 || ch > sp * 2.4 || c.x0 < st.x0 + sp * 1.2 || cw > sp * 1.3 || bandOf(c.y0) === bandOf(c.y1)) return [c];
    const parts = {};
    for(const q of c.px){
      const qx = q % w, qy = (q - qx) / w, b = bandOf(qy);
      const p = parts[b] || (parts[b] = {x0: qx, x1: qx, y0: qy, y1: qy, n: 0, px: []});
      p.n++; p.px.push(q); if(qx < p.x0) p.x0 = qx; if(qx > p.x1) p.x1 = qx; if(qy < p.y0) p.y0 = qy; if(qy > p.y1) p.y1 = qy;
    }
    return Object.values(parts).filter(p => p.x1 - p.x0 + 1 >= sp * 0.45);
  };
  const comps = components(mm, w, Math.max(0, st.x0 - 4), by0, Math.min(w - 1, st.x1 + 4), by1)
    .flatMap(splitTall)
    .filter(c => { const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1; return ch >= sp * 0.35 && ch <= sp * 1.35 && cw <= sp * 1.3 && c.n >= 6; });
  // 4. string of each glyph
  for(const c of comps){
    const cy = (c.y0 + c.y1) / 2; let bi = 0, bd = 1e9;
    st.lines.forEach((L, i) => { const d = Math.abs(L.y - cy); if(d < bd){ bd = d; bi = i; } });
    // frets sit centred on their line; pieces halfway between two lines (edges of a highlight
    // box, rhythm stems) are not frets
    c.s = bd <= sp * 0.36 ? bi : -1; c.cx = (c.x0 + c.x1) / 2;
  }
  // 5. merge neighbours on the same string (two-digit frets)
  const glyphs = comps.filter(c => c.s >= 0).sort((a, b) => a.x0 - b.x0), groups = [];
  for(const c of glyphs){
    // merge only overlapping pieces or very close ones (the two digits of "12"); a dash-wide
    // gap means two separate frets
    const g = groups.find(g => g.s === c.s && c.x0 - g.x1 <= Math.max(2, sp * 0.15) && c.x0 >= g.x0);
    if(g){ g.x1 = Math.max(g.x1, c.x1); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); g.parts.push(c); }
    else groups.push({s: c.s, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, parts: [c]});
  }
  groups.forEach(g => g.cx = (g.x0 + g.x1) / 2);
  return {staff: st, groups, bars: realBars.map(b => (b.x0 + b.x1) / 2), mask: mm};
}

// render a group from the cleaned mask, black on white, upscaled, for OCR
// The glyph is drawn from the original greys (smooth edges read better than blocky masks),
// keeping only its own pixels; everything else is white. Upscaled to ~60 px high with margins.
function groupCanvas(G, g){
  const w = G.w, pad = 3, gw = g.x1 - g.x0 + 1 + pad*2, gh = g.y1 - g.y0 + 1 + pad*2;
  const own = new Set(); for(const part of g.parts) for(const p of part.px) own.add(p);
  let lo = 255, hi = 0; for(const p of own){ const v = G.g[p]; if(v < lo) lo = v; if(v > hi) hi = v; }
  const small = document.createElement("canvas"); small.width = gw; small.height = gh;
  const sx = small.getContext("2d"), id = sx.createImageData(gw, gh);
  for(let y = 0; y < gh; y++) for(let x = 0; x < gw; x++){
    const px = g.x0 - pad + x, py = g.y0 - pad + y, p = py*w + px;
    let v = 255;
    if(own.has(p)) v = 0;
    else if(px >= 0 && px < w && py >= 0 && py < G.h){
      // anti-aliased edge pixel next to the glyph: keep a soft grey
      if(own.has(p-1) || own.has(p+1) || own.has(p-w) || own.has(p+w)) v = 150;
    }
    const k = (y*gw + x) * 4; id.data[k] = id.data[k+1] = id.data[k+2] = v; id.data[k+3] = 255;
  }
  sx.putImageData(id, 0, 0);
  const scale = 60 / gh, cw = Math.round(gw * scale) + 48, chh = Math.round(gh * scale) + 48;
  const c = document.createElement("canvas"); c.width = cw; c.height = chh;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cw, chh);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  x.drawImage(small, 24, 24, cw - 48, chh - 48);
  return c;
}

// shape test for "0": exactly one enclosed hole, sitting in the middle, glyph taller than wide
function looksLikeZero(g, G){
  const w = G.w, gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
  if(gw < 4 || gw / gh < 0.5 || gw / gh > 1.3) return false;
  const own = new Set(); for(const part of g.parts) for(const p of part.px) own.add(p);
  const W = gw + 2, H = gh + 2, bg = new Uint8Array(W * H).fill(1);
  for(const p of own){ const px = p % w, py = (p - px) / w; bg[(py - g.y0 + 1) * W + (px - g.x0 + 1)] = 0; }
  const seen = new Uint8Array(W * H); let holes = 0, hy0 = 0, hy1 = 0, hx0 = 0, hx1 = 0;
  for(let i = 0; i < W * H; i++){
    if(!bg[i] || seen[i]) continue;
    let touches = false, y0 = H, y1 = 0, x0h = W, x1h = 0; const st = [i]; seen[i] = 1;
    while(st.length){
      const q = st.pop(), x = q % W, y = (q - x) / W;
      if(x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
      if(y < y0) y0 = y; if(y > y1) y1 = y; if(x < x0h) x0h = x; if(x > x1h) x1h = x;
      for(const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
        const nx = x + dx, ny = y + dy; if(nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = ny * W + nx; if(bg[r] && !seen[r]){ seen[r] = 1; st.push(r); }
      }
    }
    if(!touches){ holes++; hy0 = y0; hy1 = y1;  hx0 = x0h; hx1 = x1h; }
  }
  if(holes !== 1) return false;
  const mid = ((hy0 + hy1) / 2 - 1) / gh, hh = (hy1 - hy0 + 1) / gh;
  return mid > 0.35 && mid < 0.65 && hh > 0.4 && (hx1 - hx0 + 1) < (hy1 - hy0 + 1) * 0.9;
}

let _lastWords = [];
const FRET_CHARS = "0123456789hpbrxX/~";
const isFret = t => /\d/.test(t || "") || t === "x";
async function ocrGlyph(wk, c, modes){
  for(const psm of modes){
    await wk.setParameters({tessedit_char_whitelist: FRET_CHARS, tessedit_pageseg_mode: psm});
    const r = await wk.recognize(c);
    let t = (r.data.text || "").replace(/\s+/g, "");
    if(/^[xX]+$/.test(t)) t = "x";              // muted string
    if(isFret(t) && r.data.confidence >= 40) return {text: t, conf: r.data.confidence};
  }
  return {text: "", conf: 0};
}
async function readGroups(A, G, onProgress){
  const wk = await getWorker("frets");
  let i = 0;
  for(const g of A.groups){
    const c = groupCanvas(G, g);
    const wide = (g.x1 - g.x0) > (g.y1 - g.y0) * 1.1;   // probably two characters, e.g. 12
    const r = await ocrGlyph(wk, c, wide ? ["7", "8", "13"] : ["10", "8", "7", "13"]);
    g.text = r.text; g.conf = r.conf;
    // OCR sometimes gives nothing for a clean "0": a tall oval with one centred hole is a zero
    if(!g.text && looksLikeZero(g, G)){ g.text = "0"; g.conf = 50; g.guess = true; }
    if(onProgress) onProgress(++i, A.groups.length);
  }
  // two-digit frets whose digits were read apart: "1" right next to a digit on the same string -> "12"
  const sp = A.staff.sp, drop = new Set(), byX = A.groups.slice().sort((a, b) => a.x0 - b.x0);
  for(const g of byX){
    if(drop.has(g) || g.text !== "1") continue;
    const n = byX.find(h => h !== g && !drop.has(h) && h.s === g.s && h.x0 >= g.x1 - 1 && h.x0 - g.x1 <= sp * 0.42 && /^\d$/.test(h.text || ""));
    if(!n) continue;
    g.text = "1" + n.text; g.x1 = Math.max(g.x1, n.x1); g.y0 = Math.min(g.y0, n.y0); g.y1 = Math.max(g.y1, n.y1);
    g.parts = g.parts.concat(n.parts); g.cx = (g.x0 + g.x1) / 2; drop.add(n);
  }
  if(drop.size) A.groups = A.groups.filter(g => !drop.has(g));
}

// ---------- tab text ----------
const STD = ["e", "B", "G", "D", "A", "E"];
function tabText(A, names){
  names = names || STD;
  const sp = A.staff.sp;
  const notes = A.groups.filter(g => isFret(g.text)).sort((a, b) => a.cx - b.cx);
  const cols = [];
  for(const g of notes){
    const c = cols[cols.length - 1];
    if(c && g.cx - c.x <= sp * 0.55 && !c.notes[g.s]){ c.notes[g.s] = g.text; c.x = (c.x * c.n + g.cx) / (c.n + 1); c.n++; }
    else cols.push({x: g.cx, n: 1, notes: {[g.s]: g.text}});
  }
  const ev = cols.map(c => ({x: c.x, col: c})).concat(A.bars.map(x => ({x, bar: true}))).sort((a, b) => a.x - b.x);
  // drop bars at the very start/end of the staff (they become the outer "|")
  while(ev.length && ev[0].bar && ev[0].x - A.staff.x0 < sp * 0.6) ev.shift();
  while(ev.length && ev[ev.length-1].bar && A.staff.x1 - ev[ev.length-1].x < sp * 0.6) ev.pop();
  const out = names.map(n => n + "|");
  let prevX = A.staff.x0;
  for(const e of ev){
    const dashes = Math.max(1, Math.min(6, Math.round((e.x - prevX) / sp * 1.2)));
    for(let s = 0; s < 6; s++) out[s] += "-".repeat(dashes);
    if(e.bar){ for(let s = 0; s < 6; s++) out[s] += "|"; }
    else {
      const wd = Math.max(...Object.values(e.col.notes).map(t => t.length));
      for(let s = 0; s < 6; s++){ const t = e.col.notes[s] || ""; out[s] += t + "-".repeat(wd - t.length); }
    }
    prevX = e.x;
  }
  const tail = Math.max(1, Math.min(6, Math.round((A.staff.x1 - prevX) / sp * 1.2)));
  return out.map(l => l + "-".repeat(tail) + "|").join("\n");
}

// ---------- chord names ----------
async function readChordNames(G, isChord, exclude){
  const wk = await getWorker("chords");
  await wk.setParameters({tessedit_char_whitelist: "ABCDEFGabdgijmsu#b/0123456789()+-°ø", tessedit_pageseg_mode: "11"});
  // hide the tab staves (they confuse the page-layout step), painting them in the surrounding colour
  let cv = G.canvas;
  if(exclude && exclude.length){
    cv = document.createElement("canvas"); cv.width = G.w; cv.height = G.h;
    const x = cv.getContext("2d"); x.drawImage(G.canvas, 0, 0);
    for(const z of exclude){
      const y = Math.max(0, Math.round(z.y0) - 2), p = x.getImageData(2, y, 1, 1).data;
      x.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`; x.fillRect(0, Math.max(0, z.y0), G.w, z.y1 - z.y0);
    }
  }
  // small chord labels (~14 px) read much better at double size; boxes are scaled back below
  const S = G.h < 1600 ? 2 : 1;
  if(S > 1){ const big = document.createElement("canvas"); big.width = G.w * S; big.height = G.h * S;
    const bx = big.getContext("2d"); bx.imageSmoothingQuality = "high"; bx.drawImage(cv, 0, 0, big.width, big.height); cv = big; }
  const r = await wk.recognize(cv);
  if(S > 1) for(const wd of (r.data.words || [])) for(const k of ["x0","x1","y0","y1"]) wd.bbox[k] /= S;
  _lastWords = (r.data.words || []).map(wd => wd.text + ":" + Math.round(wd.confidence));
  const words = (r.data.words || []).map(wd => {
      let t = wd.text.trim().replace(/°/g, "dim").replace(/ø/g, "m7b5"), conf = wd.confidence;
      if(t && !isChord(t)){ // common misreads around the slash: "C/iG", "Cl/G", "C//G"
        const f = t.replace(/[ijl|]*\/+[ijl|]*/g, "/");
        if(f !== t && isChord(f)){ t = f; conf = Math.max(conf, 60); }
      }
      return {t, conf, b: wd.bbox};
    })
    .filter(wd => wd.t && isChord(wd.t) && wd.conf >= (wd.t.length <= 1 ? 75 : wd.t.includes("/") ? 40 : 55))
    .filter(wd => !(exclude || []).some(z => wd.b.y1 > z.y0 && wd.b.y0 < z.y1));
  // group into text lines by vertical overlap
  words.sort((a, b) => a.b.y0 - b.b.y0);
  const lines = [];
  for(const wd of words){
    const L = lines.find(L => wd.b.y0 < L.y1 && wd.b.y1 > L.y0);
    if(L){ L.w.push(wd); L.y0 = Math.min(L.y0, wd.b.y0); L.y1 = Math.max(L.y1, wd.b.y1); }
    else lines.push({y0: wd.b.y0, y1: wd.b.y1, w: [wd]});
  }
  return lines.map(L => L.w.sort((a, b) => a.b.x0 - b.b.x0).map(wd => wd.t));
}

// ---------- public ----------
// convertImage(src, {isChord, tuning, onProgress}) ->
//   {tabs:[{text, staff, groups, bars}], chords:[[names]], width, height, gray}
async function convertImage(src, opts){
  opts = opts || {};
  const img = await loadImage(src), G = toGray(img);
  const r = Math.max(8, Math.round(Math.min(G.w, G.h) / 60));
  let best = null;
  for(const dark of [true, false]){
    const m = inkMask(G, dark, r, 22), lines = lineCandidates(m, G.w, G.h), staves = findStaves(lines, 6);
    if(staves.length && (!best || staves.length > best.staves.length)) best = {m, staves};
  }
  const tabs = [];
  if(best){
    const names = tuningNames(opts.tuning);
    for(const st of best.staves){
      const A = analyseStaff(G, best.m, st);
      await readGroups(A, G, opts.onProgress);
      // six even lines with nothing readable on them (e.g. a fretboard diagram): not a tab
      // (a diagram has a few fret numbers under it, so require most marks on the lines to read as frets)
      const nRead = A.groups.filter(g => /\d/.test(g.text || "") && !g.guess).length;
      if(nRead < Math.max(2, A.groups.length * 0.4)) continue;
      tabs.push({text: tabText(A, names), staff: st, groups: A.groups, bars: A.bars});
    }
  }
  let chords = [];
  if(opts.isChord && opts.chords !== false){
    const ex = tabs.map(t => ({y0: t.staff.y0 - t.staff.sp, y1: t.staff.y1 + t.staff.sp}));
    try{ chords = await readChordNames(G, opts.isChord, ex); }catch(e){ chords = []; }
  }
  return {tabs, chords, width: G.w, height: G.h};
}
function tuningNames(t){
  const s = String(t || "").trim().split(/[\s,]+/).filter(Boolean);
  if(s.length !== 6) return STD;
  const r = s.slice().reverse(); r[0] = r[0].toLowerCase(); return r;
}
// draw what was found on top of the screenshot (for the review dialog)
function drawOverlay(canvas, img, res){
  canvas.width = res.width; canvas.height = res.height;
  const x = canvas.getContext("2d"); x.drawImage(img, 0, 0);
  x.lineWidth = Math.max(2, res.width / 400);
  for(const t of res.tabs){
    x.strokeStyle = "rgba(0,160,90,.9)";
    for(const L of t.staff.lines){ x.beginPath(); x.moveTo(t.staff.x0, L.y); x.lineTo(t.staff.x1, L.y); x.stroke(); }
    for(const g of t.groups){
      const ok = isFret(g.text);
      x.strokeStyle = ok ? "rgba(230,90,20,.95)" : "rgba(150,150,150,.8)";
      x.strokeRect(g.x0 - 2, g.y0 - 2, g.x1 - g.x0 + 4, g.y1 - g.y0 + 4);
    }
  }
}
async function terminate(){
  for(const k of Object.keys(_workers)){ const p = _workers[k]; delete _workers[k]; try{ (await p).terminate(); }catch(e){} }
}

global.SongbookConvert = {convertImage, drawOverlay, loadImage, terminate, lastWords: () => _lastWords, _internal: {toGray, inkMask, lineCandidates, findStaves, analyseStaff, tabText}};
})(typeof window !== "undefined" ? window : globalThis);
