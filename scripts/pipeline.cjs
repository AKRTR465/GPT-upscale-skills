#!/usr/bin/env node
'use strict';
// Deterministic postprocessing only. The host image editor supplies AI redraws.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
sharp.concurrency(1);
sharp.cache({ memory: 128, files: 8, items: 24 });
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const xml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
function assert(ok, msg) { if (!ok) throw new Error(msg); }
function write(p, obj) {
  const tmp = p + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n'); fs.renameSync(tmp, p);
}
function num(v, fallback, min = 1) {
  const n = v === undefined ? fallback : Number(v);
  assert(Number.isFinite(n) && n >= min, `Invalid numeric value: ${v}`); return n;
}
function int(v, fallback, min = 1) { const n = num(v, fallback, min); assert(Number.isInteger(n), 'Expected integer'); return n; }
function check(opt, allowed) { for (const k of Object.keys(opt)) assert(allowed.includes(k), `Unknown option --${k}`); }
function job(dir) {
  const root = path.resolve(dir), m = read(path.join(root, 'manifest.json'));
  assert(m.schemaVersion === 1, 'Unsupported manifest version'); return { root, m };
}
function file(j, rel) {
  const p = path.resolve(j.root, rel), r = path.relative(j.root, p);
  assert(r && !r.startsWith('..') && !path.isAbsolute(r), 'Job file must stay inside its directory'); return p;
}
function region(j, id) { assert(ID.test(id), 'Invalid ID'); const t = j.m.regions.find(t => t.id === id); assert(t, `Unknown region ${id}`); return t; }
function recPath(j, id) { assert(ID.test(id), 'Invalid ID'); return file(j, `records/${id}.json`); }
function record(j, id) { const p = recPath(j, id); return fs.existsSync(p) ? read(p) : null; }
function geometry(m, t) {
  const r = t.region;
  assert(Object.values(r).every(Number.isInteger) && r.left >= 0 && r.top >= 0 && r.width > 0 && r.height > 0 && r.left + r.width <= m.width && r.top + r.height <= m.height, 'Invalid region geometry');
}
function signature(j, t, r) {
  return crypto.createHash('sha256').update(JSON.stringify({ region: t, input: hash(file(j, t.input)),
    generated: hash(file(j, r.generated)), mask: t.mask ? hash(file(j, t.mask)) : null,
    base: hash(file(j, j.m.base)), method: r.method, prompt: r.prompt, reason: r.reason })).digest('hex');
}
async function crop(j, t) { await sharp(file(j, j.m.base)).extract(t.region).png().toFile(file(j, t.input)); t.inputSha256 = hash(file(j, t.input)); }

async function prepare(source, dir, opt = {}) {
  check(opt, ['long-edge', 'short-edge', 'cols', 'rows', 'pad', 'feather']);
  assert(!(opt['long-edge'] && opt['short-edge']), 'Choose long-edge OR short-edge');
  const root = path.resolve(dir), src = path.resolve(source);
  assert(!fs.existsSync(root), 'Job directory already exists; use a new job');
  assert((await sharp(src).stats()).isOpaque, 'Transparent sources need a separate alpha-preserving workflow');
  const normalized = await sharp(src).rotate().toColourspace('srgb').removeAlpha().png().toBuffer({ resolveWithObject: true });
  const sw = normalized.info.width, sh = normalized.info.height, target = int(opt['short-edge'] || opt['long-edge'], 7680);
  const scale = Math.max(1, target / (opt['short-edge'] ? Math.min(sw, sh) : Math.max(sw, sh)));
  const width = Math.round(sw * scale), height = Math.round(sh * scale);
  assert(width * height <= 150000000, 'Helper limit: 150 megapixels; reduce the canvas or adapt memory handling');
  const cols = int(opt.cols, width > height * 3 ? 6 : width >= height ? 4 : 3);
  const rows = int(opt.rows, width > height * 3 ? 2 : width >= height ? 3 : 4);
  const pad = int(opt.pad, 224, 0), feather = num(opt.feather, 48, 0.01);
  assert(cols <= width && rows <= height && cols * rows <= 1000, 'Invalid grid');
  assert(pad < Math.min(width / cols, height / rows) / 2, 'Padding must be less than half the smallest core edge');
  assert(cols * rows === 1 || pad >= 2, 'Multi-tile jobs need padding of at least 2 pixels');
  fs.mkdirSync(root, { recursive: true });
  for (const d of ['inputs', 'generated', 'aligned', 'records', 'qa', 'masks']) fs.mkdirSync(path.join(root, d));
  const m = { schemaVersion: 1, sourceName: path.basename(src), sourceSha256: hash(src), sourceWidth: sw, sourceHeight: sh,
    width, height, cols, rows, pad, feather, base: 'base.png', regions: [] }, j = { root, m };
  await sharp(normalized.data).resize(width, height, { kernel: 'lanczos3', fit: 'fill' }).png().toFile(file(j, m.base)); m.baseSha256 = hash(file(j, m.base));
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const left = Math.round(col * width / cols), top = Math.round(row * height / rows);
    const right = Math.round((col + 1) * width / cols), bottom = Math.round((row + 1) * height / rows);
    const x = Math.max(0, left - pad), y = Math.max(0, top - pad), id = `r${row + 1}c${col + 1}`;
    const t = { id, kind: 'tile', row, col, core: { left, top, width: right - left, height: bottom - top },
      region: { left: x, top: y, width: Math.min(width, right + pad) - x, height: Math.min(height, bottom + pad) - y }, input: `inputs/${id}.png` };
    await crop(j, t); m.regions.push(t);
  }
  write(path.join(root, 'manifest.json'), m);
  const pw = Math.min(1800, width), ph = Math.round(height * pw / width), z = width / pw;
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${width} ${height}">${m.regions.map(t => `<rect x="${t.core.left}" y="${t.core.top}" width="${t.core.width}" height="${t.core.height}" fill="none" stroke="#00ffb7" stroke-width="${3 * z}"/><text x="${t.core.left + 12 * z}" y="${t.core.top + 28 * z}" font-size="${22 * z}" fill="#00ffb7">${t.id}</text>`).join('')}</svg>`;
  await sharp(file(j, m.base)).resize(pw, ph).composite([{ input: Buffer.from(overlay) }]).jpeg().toFile(file(j, 'qa/plan.jpg'));
  return { job: root, dimensions: [width, height], tiles: m.regions.length, overlap: pad * 2 };
}
async function addRegion(dir, id, opt) {
  check(opt, ['left', 'top', 'width', 'height', 'mask']); const j = job(dir);
  assert(ID.test(id) && !j.m.regions.some(t => t.id === id), 'Invalid or duplicate ID');
  assert(j.m.regions.every(t => !record(j, t.id)), 'Finish planning before importing or dispatching workers');
  assert(opt.mask, 'Provide a grayscale placement mask');
  const t = { id, kind: 'detail', region: { left: int(opt.left, NaN, 0), top: int(opt.top, NaN, 0), width: int(opt.width, NaN), height: int(opt.height, NaN) }, input: `inputs/${id}.png`, mask: `masks/${id}.png` };
  geometry(j.m, t); const meta = await sharp(opt.mask).metadata();
  assert(meta.width === t.region.width && meta.height === t.region.height, 'Mask dimensions must equal region dimensions');
  await sharp(opt.mask).removeAlpha().greyscale().png().toFile(file(j, t.mask));
  await crop(j, t); j.m.regions.push(t); write(path.join(j.root, 'manifest.json'), j.m); return { added: id };
}
async function ingest(dir, id, input, opt, retained = false) {
  check(opt, retained ? ['reason'] : ['prompt-file']); const j = job(dir), t = region(j, id);
  assert(!record(j, id), 'Already imported; use a new job for another reconstruction');
  assert(retained ? opt.reason?.trim() : opt['prompt-file'], retained ? 'A fallback reason is required' : 'Provide --prompt-file');
  const prompt = retained ? null : fs.readFileSync(opt['prompt-file'], 'utf8'); assert(retained || prompt.trim(), 'Prompt is empty');
  const generated = `generated/${id}.png`;
  await sharp(retained ? file(j, t.input) : input).rotate().toColourspace('srgb').removeAlpha().png().toFile(file(j, generated));
  const meta = await sharp(file(j, generated)).metadata();
  const r = { id, state: 'imported', method: retained ? 'retained' : 'generated', generated, nativeWidth: meta.width, nativeHeight: meta.height, prompt, reason: retained ? opt.reason : null };
  write(recPath(j, id), r); return r;
}
function ncc(a, b) {
  let sa = 0, sb = 0, aa = 0, bb = 0, ab = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; aa += a[i] ** 2; bb += b[i] ** 2; ab += a[i] * b[i]; }
  const d = Math.sqrt(Math.max(0, (aa - sa * sa / a.length) * (bb - sb * sb / a.length)));
  return d > 1e-8 ? (ab - sa * sb / a.length) / d : null;
}
function sample(a, w, h, x, y, c, ch) {
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), dx = x - x0, dy = y - y0;
  return (a[(y0 * w + x0) * ch + c] * (1 - dx) + a[(y0 * w + x1) * ch + c] * dx) * (1 - dy) + (a[(y1 * w + x0) * ch + c] * (1 - dx) + a[(y1 * w + x1) * ch + c] * dx) * dy;
}
let cvPromise;
async function align(dir, id, opt = {}) {
  check(opt, ['registration-width']); const j = job(dir), t = region(j, id), r = record(j, id);
  assert(r?.state === 'imported', 'Import a result first; already aligned regions use their existing result');
  geometry(j.m, t); assert(hash(file(j, t.input)) === t.inputSha256 && hash(file(j, j.m.base)) === j.m.baseSha256, 'Reference changed after planning');
  const cv = await (cvPromise ||= require('@techstark/opencv-js'));
  const W = t.region.width, H = t.region.height, RW = Math.min(int(opt['registration-width'], 640), W), RH = Math.max(8, Math.round(H * RW / W));
  const mats = [], keep = m => (mats.push(m), m), warnings = [];
  try {
    const ga = await sharp(file(j, t.input)).resize(RW, RH, { fit: 'fill' }).greyscale().blur(1.25).raw().toBuffer();
    const gb = await sharp(file(j, r.generated)).resize(RW, RH, { fit: 'fill' }).greyscale().blur(1.25).raw().toBuffer();
    const a = keep(cv.matFromArray(RH, RW, cv.CV_8UC1, ga)), b = keep(cv.matFromArray(RH, RW, cv.CV_8UC1, gb));
    const warp = keep(cv.matFromArray(2, 3, cv.CV_32FC1, [1, 0, 0, 0, 1, 0]));
    let M = [1, 0, 0, 0, 1, 0], ecc = null; const before = ncc(ga, gb);
    if (r.method !== 'retained') {
      try { ecc = cv.findTransformECC(a, b, warp, cv.MOTION_AFFINE, new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, 100, 0.00001), keep(new cv.Mat()), 5); M = Array.from(warp.data32F); }
      catch (e) { warnings.push('ECC failed; identity affine used: ' + String(e).slice(0, 200)); }
    }
    const det = M[0] * M[4] - M[1] * M[3];
    if (!M.every(Number.isFinite) || det < 0.82 || det > 1.2 || Math.abs(M[1]) > 0.09 || Math.abs(M[3]) > 0.09 || Math.abs(M[2]) > RW * 0.075 || Math.abs(M[5]) > RH * 0.075) { warnings.push('Affine exceeded conservative bounds'); M = [1, 0, 0, 0, 1, 0]; }
    warp.data32F.set(M); const affine = keep(new cv.Mat());
    cv.warpAffine(b, affine, warp, new cv.Size(RW, RH), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REFLECT_101, new cv.Scalar());
    let afterAffine = ncc(ga, affine.data);
    if (before !== null && afterAffine !== null && afterAffine < before - 0.002) { warnings.push('Affine reduced correlation; rejected'); M = [1, 0, 0, 0, 1, 0]; b.copyTo(affine); afterAffine = before; }
    const flow = keep(new cv.Mat()), smoothed = keep(new cv.Mat());
    cv.calcOpticalFlowFarneback(a, affine, flow, 0.5, 4, 41, 5, 7, 1.5, 0);
    cv.GaussianBlur(flow, smoothed, new cv.Size(0, 0), 4, 4, cv.BORDER_REFLECT_101);
    const f = smoothed.data32F; let clipped = 0;
    for (let i = 0; i < f.length; i += 2) {
      const mag = Math.hypot(f[i], f[i + 1]), limit = 7 * RW / 640;
      if (r.method === 'retained') { f[i] = 0; f[i + 1] = 0; }
      else if (!Number.isFinite(mag)) { f[i] = 0; f[i + 1] = 0; clipped++; }
      else if (mag > limit) { f[i] *= limit / mag; f[i + 1] *= limit / mag; clipped++; }
    }
    const native = await sharp(file(j, r.generated)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const src = keep(cv.matFromArray(native.info.height, native.info.width, cv.CV_8UC4, native.data));
    const mx = keep(new cv.Mat(H, W, cv.CV_32FC1)), my = keep(new cv.Mat(H, W, cv.CV_32FC1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let rx = (x + 0.5) * RW / W - 0.5, ry = (y + 0.5) * RH / H - 0.5;
      const fx = sample(f, RW, RH, rx, ry, 0, 2), fy = sample(f, RW, RH, rx, ry, 1, 2); rx += fx; ry += fy;
      mx.data32F[y * W + x] = (M[0] * rx + M[1] * ry + M[2] + 0.5) * native.info.width / RW - 0.5;
      my.data32F[y * W + x] = (M[3] * rx + M[4] * ry + M[5] + 0.5) * native.info.height / RH - 0.5;
    }
    const dst = keep(new cv.Mat()); cv.remap(src, dst, mx, my, cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    const pixels = Buffer.from(dst.data), LW = Math.min(256, W), LH = Math.max(1, Math.round(H * LW / W));
    // Fill transparent borders only for the color estimate; exported alpha stays intact.
    const ref = await sharp(file(j, t.input)).ensureAlpha().raw().toBuffer(), filled = Buffer.from(pixels);
    for (let i = 0; i < filled.length; i += 4) { const alpha = filled[i + 3] / 255; for (let c = 0; c < 3; c++) filled[i + c] = Math.round(filled[i + c] * alpha + ref[i + c] * (1 - alpha)); filled[i + 3] = 255; }
    const lowA = await sharp(file(j, t.input)).removeAlpha().resize(LW, LH).blur(3).raw().toBuffer();
    const lowB = await sharp(filled, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().resize(LW, LH).blur(3).raw().toBuffer();
    const diff = Float32Array.from(lowA, (v, i) => clamp((v - lowB[i]) * 0.78, -32, 32)); let holes = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4; if (pixels[i + 3] < 250) holes++;
      for (let c = 0; c < 3; c++) pixels[i + c] = clamp(Math.round(pixels[i + c] + sample(diff, LW, LH, (x + 0.5) * LW / W - 0.5, (y + 0.5) * LH / H - 0.5, c, 3)), 0, 255);
    }
    r.aligned = `aligned/${id}.png`; await sharp(pixels, { raw: { width: W, height: H, channels: 4 } }).png().toFile(file(j, r.aligned));
    const finalGray = await sharp(file(j, r.aligned)).flatten({ background: '#808080' }).resize(RW, RH).greyscale().blur(1.25).raw().toBuffer();
    r.stats = { ecc, affine: M, nccBefore: before, nccAfterAffine: afterAffine, nccAfterRemap: ncc(ga, finalGray), flowClippedFraction: clipped / (RW * RH), outsideFootprintFraction: holes / (W * H), warnings };
    r.signature = signature(j, t, r); r.alignedSha256 = hash(file(j, r.aligned)); r.state = 'aligned';
    const qw = Math.min(600, W), qh = Math.round(H * qw / W);
    const left = await sharp(file(j, t.input)).resize(qw, qh).png().toBuffer(), right = await sharp(file(j, r.aligned)).flatten({ background: '#808080' }).resize(qw, qh).png().toBuffer();
    await sharp({ create: { width: qw * 2, height: qh, channels: 3, background: '#808080' } }).composite([{ input: left, left: 0, top: 0 }, { input: right, left: qw, top: 0 }]).jpeg({ quality: 92 }).toFile(file(j, `qa/${id}.jpg`));
    write(recPath(j, id), r); return r;
  } finally { for (const m of mats.reverse()) m.delete(); }
}
function current(j, t, r) {
  assert(r && ['aligned', 'accepted'].includes(r.state), `${t.id}: not aligned`);
  assert(r.signature === signature(j, t, r) && r.alignedSha256 === hash(file(j, r.aligned)), `${t.id}: stale inputs, mask, prompt, or aligned result`);
}
function accept(dir, id, opt) {
  check(opt, ['note']); const j = job(dir), t = region(j, id), r = record(j, id);
  assert(opt.note?.trim(), 'Record a visual QA note'); current(j, t, r);
  r.state = 'accepted'; r.qaNote = opt.note; write(recPath(j, id), r); return { id, state: r.state };
}
function status(dir) {
  const j = job(dir); return { dimensions: [j.m.width, j.m.height], regions: j.m.regions.map(t => {
    const r = record(j, t.id); let stale = false;
    if (r && ['aligned', 'accepted'].includes(r.state)) { try { current(j, t, r); } catch { stale = true; } }
    return { id: t.id, kind: t.kind, state: stale ? 'stale' : r?.state || 'pending', method: r?.method || null, native: r ? [r.nativeWidth, r.nativeHeight] : null };
  }) };
}
function reset(dir, id, opt) {
  check(opt, ['reason']); const j = job(dir); region(j, id);
  assert(opt.reason?.trim(), 'Explain why this region needs another attempt');
  const r = record(j, id); assert(r, 'Region is already pending');
  const archive = file(j, `history/${id}-${crypto.randomUUID()}`);
  fs.mkdirSync(archive, { recursive: true });
  const moves = [r.generated, r.aligned, `qa/${id}.jpg`].filter(Boolean).map(rel => file(j, rel)).filter(p => fs.existsSync(p));
  for (const src of moves) {
    // Retain subdirectory names because generated and aligned files share IDs.
    const dest = path.join(archive, path.basename(path.dirname(src)));
    fs.mkdirSync(dest, { recursive: true }); fs.renameSync(src, path.join(dest, path.basename(src)));
  }
  write(path.join(archive, 'reset.json'), { id, reason: opt.reason });
  fs.renameSync(recPath(j, id), path.join(archive, 'record.json'));
  return { id, state: 'pending', archived: path.relative(j.root, archive) };
}

function seamRoute(old, newer, w, h, overlap, vertical, step = 4) {
  const steps = vertical ? h : w, choices = Math.min(vertical ? w : h, overlap);
  if (choices < 3) return new Float32Array(steps).fill(choices / 2 * step);
  const lo = Math.min(2, Math.floor(choices / 4)), hi = choices - lo - 1;
  let prev = new Float64Array(choices), now = new Float64Array(choices); const back = new Int32Array(steps * choices);
  const lum = (a, i) => a[i] * 0.2126 + a[i + 1] * 0.7152 + a[i + 2] * 0.0722;
  for (let s = 0; s < steps; s++) {
    now.fill(Infinity);
    for (let p = lo; p <= hi; p++) {
      const x = vertical ? p : s, y = vertical ? s : p, i = (y * w + x) * 4;
      const ix = (y * w + Math.min(w - 1, x + 1)) * 4, iy = (Math.min(h - 1, y + 1) * w + x) * 4;
      const diff = (Math.abs(old[i] - newer[i]) + Math.abs(old[i + 1] - newer[i + 1]) + Math.abs(old[i + 2] - newer[i + 2])) / 3;
      const edge = Math.abs(lum(old, ix) - lum(old, i)) + Math.abs(lum(newer, ix) - lum(newer, i)) + Math.abs(lum(old, iy) - lum(old, i)) + Math.abs(lum(newer, iy) - lum(newer, i));
      let best = s ? Infinity : 0, from = p;
      if (s) for (let q = Math.max(lo, p - 2); q <= Math.min(hi, p + 2); q++) { const v = prev[q] + 0.45 * Math.abs(q - p); if (v < best) { best = v; from = q; } }
      now[p] = best + diff + 0.16 * edge + 1.5 * ((p - choices / 2) / (choices / 2)) ** 2 + (newer[i + 3] < 220 ? 500 : 0); back[s * choices + p] = from;
    }
    [prev, now] = [now, prev];
  }
  let p = lo; for (let q = lo + 1; q <= hi; q++) if (prev[q] < prev[p]) p = q;
  const route = new Float32Array(steps); for (let s = steps - 1; s >= 0; s--) { route[s] = (p + 0.5) * step; p = back[s * choices + p]; } return route;
}
function routeAt(route, x, scale) { const p = clamp((x + 0.5) / scale - 0.5, 0, route.length - 1), i = Math.floor(p), k = Math.min(i + 1, route.length - 1); return route[i] + (route[k] - route[i]) * (p - i); }
function smooth(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
async function svgImages(png, r, id, limit = 5750000) {
  if (png.length <= limit) return `<image id="${xml(id)}" x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" preserveAspectRatio="none" href="data:image/png;base64,${png.toString('base64')}"/>`;
  assert(r.width > 1 || r.height > 1, 'Cannot split embedded image further');
  const vertical = r.width >= r.height, size = vertical ? r.width : r.height, half = Math.floor(size / 2);
  const a = { left: 0, top: 0, width: vertical ? half : r.width, height: vertical ? r.height : half };
  const b = { left: vertical ? half : 0, top: vertical ? 0 : half, width: vertical ? size - half : r.width, height: vertical ? r.height : size - half };
  const first = await sharp(png).extract(a).png().toBuffer(), second = await sharp(png).extract(b).png().toBuffer();
  return await svgImages(first, { left: r.left, top: r.top, width: a.width, height: a.height }, id + 'a', limit) + await svgImages(second, { left: r.left + b.left, top: r.top + b.top, width: b.width, height: b.height }, id + 'b', limit);
}
async function assemble(dir, destination) {
  const j = job(dir), { width: W, height: H } = j.m, out = path.resolve(destination);
  assert(!fs.existsSync(out), 'Output directory already exists; choose a new version');
  const expected = new Set(); for (let row = 0; row < j.m.rows; row++) for (let col = 0; col < j.m.cols; col++) expected.add(`r${row + 1}c${col + 1}`);
  for (const t of j.m.regions.filter(t => t.kind === 'tile')) assert(expected.delete(t.id), `Duplicate or unexpected tile ${t.id}`);
  assert(!expected.size, 'Manifest is missing planned grid tiles');
  for (const t of j.m.regions) { geometry(j.m, t); const r = record(j, t.id); current(j, t, r); assert(r.state === 'accepted', `${t.id}: visual QA not accepted`); }
  assert(hash(file(j, j.m.base)) === j.m.baseSha256, 'Reference base changed'); fs.mkdirSync(out, { recursive: true });
  const canvas = await sharp(file(j, j.m.base)).ensureAlpha().raw().toBuffer(), svg = path.join(out, 'refined.svg');
  fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>Tiled image refinement</title><desc>Generated raster reconstruction in independently editable embedded image layers.</desc>`);
  const append = async (id, label, png, r) => fs.appendFileSync(svg, `<g id="${xml(id)}" inkscape:groupmode="layer" inkscape:label="${xml(label)}">${await svgImages(png, r, id + '-image')}</g>\n`);
  await append('base', 'Reference base', fs.readFileSync(file(j, j.m.base)), { left: 0, top: 0, width: W, height: H });
  const order = [...j.m.regions.filter(t => t.kind === 'tile').sort((a, b) => a.row - b.row || a.col - b.col), ...j.m.regions.filter(t => t.kind === 'detail')], records = [], seamPaths = [];
  for (const t of order) {
    const rec = record(j, t.id), r = t.region, pixels = await sharp(file(j, rec.aligned)).ensureAlpha().raw().toBuffer();
    if (t.kind === 'tile') {
      const sw = Math.ceil(r.width / 4), sh = Math.ceil(r.height / 4), sx = r.width / sw, sy = r.height / sh;
      const old = await sharp(canvas, { raw: { width: W, height: H, channels: 4 } }).extract(r).resize(sw, sh).raw().toBuffer();
      const newer = await sharp(pixels, { raw: { width: r.width, height: r.height, channels: 4 } }).resize(sw, sh).raw().toBuffer();
      const prevX = t.col ? order.find(q => q.kind === 'tile' && q.row === t.row && q.col === t.col - 1) : null;
      const prevY = t.row ? order.find(q => q.kind === 'tile' && q.row === t.row - 1 && q.col === t.col) : null;
      const ox = prevX ? prevX.region.left + prevX.region.width - r.left : 0, oy = prevY ? prevY.region.top + prevY.region.height - r.top : 0;
      const left = ox ? seamRoute(old, newer, sw, sh, Math.round(ox / sx), true, sx) : null;
      const top = oy ? seamRoute(old, newer, sw, sh, Math.round(oy / sy), false, sy) : null;
      const feather = num(t.feather, j.m.feather, 0.01);
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
        let a = 1;
        if (left && x < ox) a = Math.min(a, smooth((x - routeAt(left, y, sy)) / Math.min(feather, ox / 2) + 0.5));
        if (top && y < oy) a = Math.min(a, smooth((y - routeAt(top, x, sx)) / Math.min(feather, oy / 2) + 0.5));
        pixels[(y * r.width + x) * 4 + 3] = Math.round(pixels[(y * r.width + x) * 4 + 3] * a);
      }
      if (left) seamPaths.push(Array.from(left, (v, i) => [r.left + v, r.top + (i + 0.5) * sy]));
      if (top) seamPaths.push(Array.from(top, (v, i) => [r.left + (i + 0.5) * sx, r.top + v]));
    } else {
      const mask = await sharp(file(j, t.mask)).removeAlpha().greyscale().raw().toBuffer();
      for (let i = 0; i < mask.length; i++) pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * mask[i] / 255);
    }
    const png = await sharp(pixels, { raw: { width: r.width, height: r.height, channels: 4 } }).png().toBuffer();
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const i = (y * r.width + x) * 4, k = ((r.top + y) * W + r.left + x) * 4, a = pixels[i + 3] / 255;
      for (let c = 0; c < 3; c++) canvas[k + c] = Math.round(pixels[i + c] * a + canvas[k + c] * (1 - a));
    }
    await append(t.id, `${t.id} (${rec.method})`, png, r);
    records.push({ ...rec, region: r, destinationScale: [r.width / rec.nativeWidth, r.height / rec.nativeHeight] });
  }
  fs.appendFileSync(svg, '</svg>\n');
  await sharp(canvas, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().withIccProfile('srgb').png().toFile(path.join(out, 'refined.png'));
  const pw = Math.min(1920, W), ph = Math.round(H * pw / W);
  await sharp(canvas, { raw: { width: W, height: H, channels: 4 } }).resize(pw, ph).jpeg({ quality: 94 }).toFile(path.join(out, 'preview.jpg'));
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke="#00ffb7" stroke-width="${2 * W / pw}">${seamPaths.map(p => `<polyline points="${p.map(v => v.join(',')).join(' ')}"/>`).join('')}</g></svg>`;
  await sharp(path.join(out, 'preview.jpg')).composite([{ input: Buffer.from(overlay) }]).jpeg().toFile(path.join(out, 'seams.jpg'));
  const report = { schemaVersion: 1, sourceName: j.m.sourceName, sourceSha256: j.m.sourceSha256, width: W, height: H,
    generatedRegions: records.filter(r => r.method === 'generated').length, retainedRegions: records.filter(r => r.method === 'retained').length,
    disclosure: 'Interpretive detail. Output canvas size differs from native generation resolution. SVG embeds raster layers.',
    svgSha256: hash(svg), pngSha256: hash(path.join(out, 'refined.png')), records };
  write(path.join(out, 'report.json'), report); return { output: out, dimensions: [W, H], generated: report.generatedRegions, retained: report.retainedRegions };
}
async function verify(destination, opt = {}) {
  check(opt, ['max-mean-difference', 'max-outlier-fraction']); const out = path.resolve(destination), r = read(path.join(out, 'report.json'));
  const svg = path.join(out, 'refined.svg'), png = path.join(out, 'refined.png');
  assert(hash(svg) === r.svgSha256 && hash(png) === r.pngSha256, 'Export hashes changed');
  const text = fs.readFileSync(svg, 'utf8'), hrefs = [...text.matchAll(/\bhref="([^"]*)"/g)].map(m => m[1]);
  assert(hrefs.length && hrefs.every(h => h.startsWith('data:image/png;base64,')), 'SVG must contain embedded PNG images only');
  assert(!/<(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY/i.test(text), 'Unexpected active or external SVG content');
  const a = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }), b = await sharp(svg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert(a.info.width === r.width && a.info.height === r.height && b.info.width === r.width && b.info.height === r.height && a.data.length === b.data.length, 'Full-resolution dimensions do not match');
  let sum = 0, max = 0, outliers = 0;
  for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); sum += d; max = Math.max(max, d); if (d > 10) outliers++; }
  const result = { width: r.width, height: r.height, meanChannelDifference: sum / a.data.length, maxChannelDifference: max, fractionAbove10: outliers / a.data.length,
    embeddedImages: hrefs.length, maxDataAttributeBytes: Math.max(...hrefs.map(h => Buffer.byteLength(h))), svgSha256: r.svgSha256, pngSha256: r.pngSha256,
    visualQA: 'Separate visual inspection required; this verifies render and file consistency only.' };
  result.passed = result.meanChannelDifference <= num(opt['max-mean-difference'], 0.5, 0) && result.fractionAbove10 <= num(opt['max-outlier-fraction'], 0.001, 0);
  write(path.join(out, 'verification.json'), result); assert(result.passed, 'SVG/PNG comparison failed; inspect verification.json'); return result;
}
async function main(args) {
  const pos = [], opt = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { pos.push(args[i]); continue; }
    const k = args[i].slice(2); assert(args[i + 1] !== undefined && !args[i + 1].startsWith('--') && !(k in opt), `Invalid option --${k}`); opt[k] = args[++i];
  }
  const [cmd, a, b, c] = pos;
  if (!cmd || cmd === 'help') { console.log('prepare SOURCE JOB; add-region JOB ID; ingest JOB ID IMAGE; retain JOB ID; align JOB ID; accept JOB ID; reset JOB ID; status JOB; assemble JOB NEW_OUTPUT; verify OUTPUT. Options: references/cli.md'); return; }
  const counts = { prepare: 3, 'add-region': 3, ingest: 4, retain: 3, align: 3, accept: 3, reset: 3, status: 2, assemble: 3, verify: 2 };
  assert(counts[cmd] === pos.length, 'Unknown command or incorrect positional arguments'); let result;
  switch (cmd) {
    case 'prepare': result = await prepare(a, b, opt); break;
    case 'add-region': result = await addRegion(a, b, opt); break;
    case 'ingest': result = await ingest(a, b, c, opt); break;
    case 'retain': result = await ingest(a, b, null, opt, true); break;
    case 'align': result = await align(a, b, opt); break;
    case 'accept': result = accept(a, b, opt); break;
    case 'reset': result = reset(a, b, opt); break;
    case 'status': check(opt, []); result = status(a); break;
    case 'assemble': check(opt, []); result = await assemble(a, b); break;
    case 'verify': result = await verify(a, opt); break;
  }
  console.log(JSON.stringify(result, null, 2));
}
module.exports = { prepare, addRegion, ingest, align, accept, reset, status, assemble, verify, seamRoute, svgImages, hash };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
