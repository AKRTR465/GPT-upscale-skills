'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const p = require('../scripts/pipeline.cjs');
const read = f => JSON.parse(fs.readFileSync(f));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refinement-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
async function solid(filename, width, height, value) {
  await sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } }).png().toFile(filename);
}

test('oversized details split, stitch, apply mask once, and preserve detail insertion order', async t => {
  const root = temporary(t), source = path.join(root, 'source.png'), job = path.join(root, 'job');
  await solid(source, 1200, 160, 10);
  await p.prepare(source, job, { 'long-edge': 1200, 'max-tile-edge': 512 });
  const mask = path.join(root, 'mask.png'), smallMask = path.join(root, 'small-mask.png');
  await solid(mask, 1050, 140, 128); await solid(smallMask, 20, 20, 255);
  const added = await p.addRegion(job, 'detail', { left: 100, top: 10, width: 1050, height: 140, mask, context: source });
  assert.equal(added.grouped, true); assert.equal(added.regions.length, 3);
  await p.addRegion(job, 'late', { left: 130, top: 30, width: 20, height: 20, mask: smallMask });
  const m = read(path.join(job, 'manifest.json'));
  assert.equal(m.schemaVersion, 2); assert.equal(m.detailGroups.length, 1);
  assert.ok(m.regions.every(r => r.region.width <= 512 && r.region.height <= 512));
  const context = await sharp(path.join(job, added.context)).metadata();
  assert.ok(context.width <= 1024 && context.height <= 1024);
  const prompt = path.join(root, 'prompt.txt'); fs.writeFileSync(prompt, 'Synthetic constant-color fixture; no image model.');
  for (const region of m.regions) {
    if (region.kind === 'tile') await p.ingest(job, region.id, null, { reason: 'Synthetic baseline' }, true);
    else {
      const generated = path.join(root, `${region.id}.png`);
      await solid(generated, region.region.width, region.region.height, region.id === 'late' ? 60 : 210);
      await p.ingest(job, region.id, generated, { 'prompt-file': prompt });
    }
    await p.align(job, region.id, { 'registration-width': 96 });
    p.accept(job, region.id, { note: 'Synthetic functional fixture only' });
  }
  const out = path.join(root, 'out'); await p.assemble(job, out);
  const result = await p.verify(out); assert.equal(result.passed, true); assert.equal(result.pixelsCompared, 1200 * 160);
  const image = await sharp(path.join(out, 'refined.png')).removeAlpha().raw().toBuffer();
  const first = await sharp(path.join(job, 'aligned', `${added.regions[0]}.png`)).removeAlpha().raw().toBuffer();
  const late = await sharp(path.join(job, 'aligned/late.png')).removeAlpha().raw().toBuffer();
  const expected = Math.round(first[0] * 128 / 255 + 10 * 127 / 255);
  for (const x of [110, 350, 449, 700, 1050, 1149]) assert.equal(image[(80 * 1200 + x) * 3], expected, `parent mask at x=${x}`);
  assert.equal(image[(35 * 1200 + 135) * 3], late[0], 'later small detail must override the group');
  assert.equal(image[(80 * 1200 + 50) * 3], 10, 'outside parent unchanged');
  fs.appendFileSync(path.join(job, added.context), 'changed');
  assert.ok(p.status(job).regions.filter(r => r.kind === 'detail-tile').every(r => r.state === 'stale'));
});

test('CLI plan is read only; invalid prepare and mismatched crops fail before importing', async t => {
  const root = temporary(t), source = path.join(root, 'source.png'); await solid(source, 100, 50, 20);
  const before = fs.readdirSync(root);
  const run = spawnSync(process.execPath, [path.join(__dirname, '../scripts/pipeline.cjs'), 'plan', source, '--preset', '4k'], { encoding: 'utf8', cwd: root });
  assert.equal(run.status, 0, run.stderr); const plan = JSON.parse(run.stdout);
  assert.equal(plan.width, 3840); assert.equal(plan.maxTileEdge, 1024); assert.deepEqual(fs.readdirSync(root), before);
  const bad = path.join(root, 'bad');
  await assert.rejects(p.prepare(source, bad, { preset: '8k', cols: 1, rows: 1 }), /limit/); assert.equal(fs.existsSync(bad), false);
  const job = path.join(root, 'job'); await p.prepare(source, job, { 'long-edge': 100, pad: 0 });
  await solid(path.join(job, 'inputs/r1c1.png'), 101, 50, 20);
  await assert.rejects(p.ingest(job, 'r1c1', null, { reason: 'test' }, true), /planned dimensions/);
  assert.equal(fs.readdirSync(path.join(job, 'records')).length, 0);
});

test('legacy manifest keeps coordinates and rejects oversized new edits without migration', async t => {
  const root = temporary(t), source = path.join(root, 'source.png'), job = path.join(root, 'job');
  await solid(source, 300, 200, 30); await p.prepare(source, job, { 'long-edge': 300, pad: 0 });
  const manifest = path.join(job, 'manifest.json'), m = read(manifest); m.schemaVersion = 1;
  fs.writeFileSync(manifest, JSON.stringify(m)); const before = fs.readFileSync(manifest);
  await p.ingest(job, 'r1c1', null, { reason: 'Legacy synthetic fixture' }, true);
  await p.align(job, 'r1c1'); p.accept(job, 'r1c1', { note: 'Legacy geometry preserved' });
  const out = path.join(root, 'out'); await p.assemble(job, out); assert.equal((await p.verify(out)).passed, true);
  assert.deepEqual(fs.readFileSync(manifest), before);
  const record = path.join(job, 'records/r1c1.json'); fs.unlinkSync(record);
  m.width = 1100; m.regions[0].region.width = 1100; fs.writeFileSync(manifest, JSON.stringify(m));
  await assert.rejects(p.ingest(job, 'r1c1', null, { reason: 'test' }, true), /Legacy region exceeds 1K/);
  assert.equal(fs.existsSync(record), false);
});

test('detail block budget fails before writing masks, and legacy exports remain verifiable', async t => {
  const root = temporary(t), source = path.join(root, 'source.png'), job = path.join(root, 'job');
  await solid(source, 32, 24, 42); await p.prepare(source, job, { 'long-edge': 32, pad: 0 });
  const manifest = path.join(job, 'manifest.json'), m = read(manifest);
  m.regions = Array.from({ length: 1000 }, (_, i) => ({ ...m.regions[0], id: `region-${i}` }));
  fs.writeFileSync(manifest, JSON.stringify(m));
  await assert.rejects(p.addRegion(job, 'extra', { left: 0, top: 0, width: 32, height: 24, mask: source }), /1000/);
  assert.deepEqual(fs.readdirSync(path.join(job, 'masks')), []);
  const out = path.join(root, 'legacy'); fs.mkdirSync(out);
  const png = path.join(out, 'refined.png'), svg = path.join(out, 'refined.svg'); fs.copyFileSync(source, png);
  fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><image width="32" height="24" href="data:image/png;base64,${fs.readFileSync(png).toString('base64')}"/></svg>`);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ schemaVersion: 1, width: 32, height: 24, svgSha256: p.hash(svg), pngSha256: p.hash(png) }));
  assert.equal((await p.verify(out)).passed, true);
});
