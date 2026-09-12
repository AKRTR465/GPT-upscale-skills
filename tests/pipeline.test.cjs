'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const p = require('../scripts/pipeline.cjs');

async function fixture(root, name = 'source.png', w = 360, h = 240) {
  // Synthetic geometry for functional checks, never an AI quality example.
  const shapes = Array.from({ length: 24 }, (_, i) => `<circle cx="${16 + (i * 47) % (w - 32)}" cy="${16 + (i * 37) % (h - 32)}" r="${3 + i % 10}" fill="rgb(${40 + i * 7},${190 - i * 3},${60 + i * 5})"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#20334d"/><path d="M20 30L${w - 20} ${h - 40}M50 ${h - 20}L${w - 60} 20" stroke="#ebd897" stroke-width="4"/>${shapes}</svg>`;
  const out = path.join(root, name); await sharp(Buffer.from(svg)).png().toFile(out); return out;
}

test('complete job: nonuniform grid, detail mask, retained region, actual SVG render', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = await fixture(root, 'source.png', 361, 241), before = p.hash(src), job = path.join(root, 'job');
  await p.prepare(src, job, { 'long-edge': '361', cols: '2', rows: '2', pad: '12', feather: '8' });
  const mask = path.join(root, 'mask.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="black"/><ellipse cx="40" cy="30" rx="28" ry="20" fill="white"/></svg>')).png().toFile(mask);
  await p.addRegion(job, 'detail', { left: '100', top: '70', width: '80', height: '60', mask });
  const m = JSON.parse(fs.readFileSync(path.join(job, 'manifest.json')));
  assert.equal(m.regions.length, 5); assert.equal(m.width, 361); assert.equal(m.height, 241);
  assert.equal(p.status(job).regions.filter(r => r.state === 'pending').length, 5);
  await assert.rejects(p.assemble(job, path.join(root, 'missing')), /not aligned/);
  assert.equal(fs.existsSync(path.join(root, 'missing')), false);
  const prompt = path.join(root, 'prompt.txt'); fs.writeFileSync(prompt, 'Synthetic unchanged crop for functional test only.');
  for (const r of m.regions) {
    if (r.id === 'r2c2') await p.ingest(job, r.id, null, { reason: 'Test of explicitly retained source region' }, true);
    else await p.ingest(job, r.id, path.join(job, r.input), { 'prompt-file': prompt });
    await p.align(job, r.id, { 'registration-width': '96' });
    await assert.rejects(p.assemble(job, path.join(root, 'not-reviewed')), /not accepted|not aligned/);
    p.accept(job, r.id, { note: 'Synthetic identity geometry checked by this functional test.' });
  }
  const output = path.join(root, 'delivery'); const done = await p.assemble(job, output);
  assert.equal(done.generated, 4); assert.equal(done.retained, 1);
  const verified = await p.verify(output); assert.equal(verified.passed, true);
  assert.ok(verified.meanChannelDifference < 0.5); assert.ok(verified.embeddedImages >= 6);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json')));
  assert.ok(report.records.find(r => r.id === 'r2c2').reason);
  assert.equal(p.hash(src), before);
  await assert.rejects(p.assemble(job, output), /already exists/);
  await assert.rejects(p.prepare(src, job, {}), /already exists/);
  // Altering an already accepted mask must invalidate both status and export.
  fs.appendFileSync(path.join(job, 'masks/detail.png'), 'changed');
  assert.equal(p.status(job).regions.find(r => r.id === 'detail').state, 'stale');
  await assert.rejects(p.assemble(job, path.join(root, 'stale')), /stale/);
});

test('registration recovers a translated image and records native size', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-shift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = await fixture(root), job = path.join(root, 'job');
  await p.prepare(src, job, { 'long-edge': '360', cols: '1', rows: '1', pad: '0' });
  const patch = await sharp(src).extract({ left: 0, top: 0, width: 354, height: 236 }).png().toBuffer();
  const shifted = path.join(root, 'shifted.png');
  await sharp({ create: { width: 360, height: 240, channels: 3, background: '#20334d' } }).composite([{ input: patch, left: 6, top: 4 }]).png().toFile(shifted);
  const prompt = path.join(root, 'prompt.txt'); fs.writeFileSync(prompt, 'Synthetic translation; no generation performed.');
  await p.ingest(job, 'r1c1', shifted, { 'prompt-file': prompt });
  const r = await p.align(job, 'r1c1', { 'registration-width': '240' });
  assert.equal(r.nativeWidth, 360); assert.equal(r.nativeHeight, 240);
  assert.ok(r.stats.nccAfterAffine > r.stats.nccBefore + 0.05, JSON.stringify(r.stats));
  assert.ok(r.stats.nccAfterAffine > 0.98, JSON.stringify(r.stats));
  assert.throws(() => p.accept(job, 'r1c1', {}), /QA note/);
  p.accept(job, 'r1c1', { note: 'Recovered synthetic translation.' });
  fs.appendFileSync(path.join(job, 'generated/r1c1.png'), 'changed');
  await assert.rejects(p.assemble(job, path.join(root, 'stale')), /stale/);
  const archive = p.reset(job, 'r1c1', { reason: 'Test retry after stale generated content' });
  assert.equal(p.status(job).regions[0].state, 'pending');
  assert.ok(fs.existsSync(path.join(job, archive.archived, 'record.json')));
  assert.ok(fs.existsSync(path.join(job, archive.archived, 'generated/r1c1.png')));
  await p.ingest(job, 'r1c1', src, { 'prompt-file': prompt });
  assert.equal(p.status(job).regions[0].state, 'imported');
});

test('short-edge sizing, preserve larger input, EXIF orientation and invalid options', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-size-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = await fixture(root, 'banner.png', 400, 100);
  const a = await p.prepare(src, path.join(root, 'short'), { 'short-edge': '200', cols: '2', rows: '1', pad: '8' });
  assert.deepEqual(a.dimensions, [800, 200]);
  const b = await p.prepare(src, path.join(root, 'larger'), { 'long-edge': '200', cols: '1', rows: '1', pad: '0' });
  assert.deepEqual(b.dimensions, [400, 100]);
  const rotated = path.join(root, 'rotated.jpg'); await sharp(src).withMetadata({ orientation: 6 }).jpeg().toFile(rotated);
  const c = await p.prepare(rotated, path.join(root, 'rotated'), { 'long-edge': '400', cols: '1', rows: '1', pad: '0' });
  assert.deepEqual(c.dimensions, [100, 400]);
  await assert.rejects(p.prepare(src, path.join(root, 'bad'), { cols: '0' }), /numeric/);
  await assert.rejects(p.prepare(src, path.join(root, 'bad'), { unknown: '1' }), /Unknown option/);
  await assert.rejects(p.prepare(src, path.join(root, 'bad'), { 'long-edge': '400', 'short-edge': '200' }), /Choose/);
  const alpha = path.join(root, 'transparent.png');
  await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toFile(alpha);
  await assert.rejects(p.prepare(alpha, path.join(root, 'transparent'), {}), /Transparent/);
});

test('seam follows a low-difference continuous corridor', () => {
  const w = 20, h = 30, a = Buffer.alloc(w * h * 4, 255), b = Buffer.from(a);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const low = x >= 8 && x <= 10;
    for (let c = 0; c < 3; c++) b[(y * w + x) * 4 + c] = low ? 255 : 20;
  }
  const route = p.seamRoute(a, b, w, h, w, true, 1);
  assert.ok(Array.from(route).every(x => x >= 8 && x <= 11));
  for (let i = 1; i < route.length; i++) assert.ok(Math.abs(route[i] - route[i - 1]) <= 2);
});

test('large embedded images split without losing pixels or introducing external links', async () => {
  const w = 61, h = 39, bytes = Buffer.alloc(w * h * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 71 + Math.floor(i / 13) * 17) % 256;
  const png = await sharp(bytes, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const images = await p.svgImages(png, { left: 0, top: 0, width: w, height: h }, 'demo', 600);
  assert.ok((images.match(/<image /g) || []).length > 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${images}</svg>`;
  const rendered = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer(); assert.deepEqual(rendered, bytes);
});
