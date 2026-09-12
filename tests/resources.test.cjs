'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const p = require('../scripts/pipeline.cjs');
const { planGrid } = require('../scripts/planner.cjs');
const { DiskRaster } = require('../scripts/raster.cjs');
const { rasterLayout, validateCanvas, checkDisk } = require('../scripts/resources.cjs');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refinement-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
async function source(root) {
  const filename = path.join(root, 'source.png');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#123456' } }).png().toFile(filename);
  return filename;
}
const noSpace = () => ({ bavail: 0n, bsize: 4096n });

test('322 MP geometry has no fixed pixel rejection and stays within edit and TIFF limits', () => {
  const plan = planGrid(37258, 8640);
  assert.deepEqual([plan.cols, plan.rows, plan.tileCount], [42, 10, 420]);
  assert.deepEqual(plan.maxCrop, { width: 1016, height: 992 });
  assert.equal(plan.pixelCount, 321909120);
  assert.equal(plan.resources.fixedPixelLimit, null);
  assert.equal(plan.resources.canvasRgbaBytes, 1287636480);
  assert.equal(plan.regions.reduce((n, t) => n + t.core.width * t.core.height, 0), plan.pixelCount);
  assert.ok(plan.regions.every(t => t.region.width <= 1024 && t.region.height <= 1024));
  assert.throws(() => planGrid(30000, 30000), /1000/);
});

test('classic TIFF offsets and unsafe dimensions fail before opening any file', t => {
  const root = temporary(t), target = path.join(root, 'invalid.tiff');
  assert.equal(rasterLayout(37258, 8640).fileBytes, 1287640576);
  assert.throws(() => DiskRaster.create(target, 32768, 32768), /classic TIFF/);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => validateCanvas(2 ** 31, 1), /32-bit/);
  assert.throws(() => validateCanvas(2 ** 31 - 1, 2 ** 31 - 1), /safe integer/);
  assert.throws(() => rasterLayout(-1, 100), /positive integers/);
});

test('read-only destination checks follow existing ancestors; low disk leaves no job', async t => {
  const root = temporary(t), input = await source(root), destination = path.join(root, 'missing', 'job');
  const before = fs.readdirSync(root);
  const plan = await p.plan(input, { 'long-edge': 80, 'work-dir': destination });
  assert.equal(plan.resources.diskCheck.status, 'passed');
  assert.equal(plan.resources.diskCheck.filesystemPath, fs.realpathSync(root));
  assert.deepEqual(fs.readdirSync(root), before);
  const mocked = t.mock.method(fs, 'statfsSync', noSpace);
  await assert.rejects(p.plan(input, { 'long-edge': 80, 'work-dir': destination }), /Insufficient disk space/);
  await assert.rejects(p.prepare(input, destination, { 'long-edge': 80 }), /Insufficient disk space/);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.throws(() => checkDisk(root, -1), /Invalid disk/);
  mocked.mock.restore();
});

test('detail, assembly and verification disk failures preserve existing task state', async t => {
  const root = temporary(t), input = await source(root), job = path.join(root, 'job'), out = path.join(root, 'out');
  await p.prepare(input, job, { 'long-edge': 80, pad: 0 });
  const manifest = path.join(job, 'manifest.json'), before = fs.readFileSync(manifest);
  let mocked = t.mock.method(fs, 'statfsSync', noSpace);
  await assert.rejects(p.addRegion(job, 'detail', { left: 0, top: 0, width: 80, height: 40, mask: input }), /Insufficient disk space/);
  assert.deepEqual(fs.readFileSync(manifest), before);
  assert.deepEqual(fs.readdirSync(path.join(job, 'masks')), []);
  mocked.mock.restore();
  await p.ingest(job, 'r1c1', null, { reason: 'Synthetic resource test' }, true);
  await p.align(job, 'r1c1'); p.accept(job, 'r1c1', { note: 'Synthetic source retained' });
  mocked = t.mock.method(fs, 'statfsSync', noSpace);
  await assert.rejects(p.assemble(job, out), /Insufficient disk space/);
  assert.equal(fs.existsSync(out), false);
  mocked.mock.restore();
  await p.assemble(job, out);
  const files = fs.readdirSync(out);
  mocked = t.mock.method(fs, 'statfsSync', noSpace);
  await assert.rejects(p.verify(out), /Insufficient disk space/);
  assert.deepEqual(fs.readdirSync(out), files);
  mocked.mock.restore();
  assert.equal((await p.verify(out)).passed, true);
});
