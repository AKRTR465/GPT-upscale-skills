'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const p = require('../scripts/pipeline.cjs');
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watermark-mode-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'watermark-mode-'))); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function fixture(root) {
  const original = path.join(root, 'original.png'), clean = path.join(root, 'clean.png'), record = path.join(root, 'removal.json');
  const pixels = Buffer.alloc(64 * 48 * 3, 40), marked = Buffer.from(pixels);
  for (let y = 32; y < 40; y++) for (let x = 45; x < 55; x++) marked.fill(230, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3);
  await sharp(pixels, { raw: { width: 64, height: 48, channels: 3 } }).png().toFile(clean);
  await sharp(marked, { raw: { width: 64, height: 48, channels: 3 } }).png().toFile(original);
  const r = { schemaVersion: 1, status: 'cleaned', original: { path: 'original.png', sha256: p.hash(original) }, resultSha256: p.hash(clean),
    review: { note: 'Synthetic rectangular fixture, not AI removal.', outsideMaskChangedPixels: 0 },
    edits: [{ id: 'fixture', crop: { left: 40, top: 30, width: 20, height: 14 }, mask: 'synthetic-rectangle', outcome: 'removed', prompt: 'Synthetic fixture, no model call.', nativeSize: { width: 20, height: 14 } }] };
  fs.writeFileSync(record, JSON.stringify(r));
  return { original, clean, record, r, pixels, marked };
}
test('removal defaults off, is read-only in plan, and requires explicit complete provenance', async t => {
  const root = temp(t), f = await fixture(root), opts = { 'long-edge': 64, pad: 0 };
  const before = fs.readdirSync(root);
  assert.deepEqual((await p.plan(f.original, opts)).watermarkRemoval, { enabled: false, status: 'disabled' });
  assert.deepEqual(fs.readdirSync(root), before);
  const bad = path.join(root, 'bad');
  await assert.rejects(p.prepare(f.clean, bad, { ...opts, 'watermark-removal': 'on' }), /Cleanup stage required/);
  assert.equal(fs.existsSync(bad), false);
  await assert.rejects(p.plan(f.clean, { ...opts, 'removal-record': f.record }), /requires.*on/);
  await assert.rejects(p.plan(f.clean, { ...opts, 'watermark-removal': 'auto' }), /off or on/);
  const on = { ...opts, 'watermark-removal': 'on', 'removal-record': f.record };
  await assert.rejects(p.plan(f.original, on), /result hash mismatch/);
  const update = r => fs.writeFileSync(f.record, JSON.stringify(r));
  update({ ...f.r, review: { note: 'Invalid locality', outsideMaskChangedPixels: 1 } });
  await assert.rejects(p.plan(f.clean, on), /zero changed pixels/);
  update({ ...f.r, status: 'partial' });
  await assert.rejects(p.plan(f.clean, on), /retained edit/);
  update({ ...f.r, status: 'not-found', resultSha256: p.hash(f.original), edits: [] });
  assert.equal((await p.plan(f.original, on)).watermarkRemoval.status, 'not-found');
  update({ ...f.r, status: 'partial', resultSha256: p.hash(f.original), edits: [{ crop: f.r.edits[0].crop, outcome: 'retained', reason: 'Simulated rejected cleanup' }] });
  assert.equal((await p.plan(f.original, on)).watermarkRemoval.status, 'partial');
  update({ ...f.r, original: { path: 'original.png', sha256: '0'.repeat(64) } });
  await assert.rejects(p.plan(f.clean, on), /original hash mismatch/);
});
test('enabled cleanup supplies the base and exported SVG; off preserves the supplied marks', async t => {
  const root = temp(t), f = await fixture(root), off = path.join(root, 'off'), on = path.join(root, 'on');
  const opts = { 'long-edge': 64, pad: 0 };
  await p.prepare(f.original, off, opts);
  const baseOff = await sharp(path.join(off, 'base.tiff')).removeAlpha().raw().toBuffer();
  assert.deepEqual(baseOff, f.marked);
  await p.prepare(f.clean, on, { ...opts, 'watermark-removal': 'on', 'removal-record': f.record });
  assert.equal(p.status(on).watermarkRemoval.status, 'cleaned');
  const baseOn = await sharp(path.join(on, 'base.tiff')).removeAlpha().raw().toBuffer();
  assert.deepEqual(baseOn, f.pixels);
  await p.ingest(on, 'r1c1', null, { reason: 'Preserve synthetic clean base for export test' }, true);
  await p.align(on, 'r1c1'); p.accept(on, 'r1c1', { note: 'Synthetic fixture unchanged.' });
  const out = path.join(root, 'output'); await p.assemble(on, out);
  assert.equal((await p.verify(out)).passed, true);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
  assert.equal(report.watermarkRemoval.record.resultSha256, p.hash(f.clean));
  const svg = await sharp(path.join(out, 'refined.svg')).removeAlpha().raw().toBuffer();
  assert.deepEqual(svg, f.pixels);
  assert.equal(p.hash(f.original), f.r.original.sha256);
  const mp = path.join(on, 'manifest.json'), m = JSON.parse(fs.readFileSync(mp));
  m.watermarkRemoval = { enabled: false, status: 'disabled' }; fs.writeFileSync(mp, JSON.stringify(m));
  assert.equal(p.status(on).regions[0].state, 'stale', 'changing metadata cannot reuse accepted cleanup work');
});
