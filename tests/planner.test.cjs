'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { plan, planGrid, MAX_TILES } = require('../scripts/planner.cjs');

function checkCoverage(p) {
  assert.equal(p.regions.length, p.cols * p.rows);
  let covered = 0;
  for (let row = 0; row < p.rows; row++) for (let col = 0; col < p.cols; col++) {
    const t = p.regions[row * p.cols + col], c = t.core, r = t.region;
    assert.equal(t.id, `r${row + 1}c${col + 1}`);
    assert.ok(r.width <= p.maxTileEdge && r.height <= p.maxTileEdge);
    assert.ok(r.left >= 0 && r.top >= 0 && r.left + r.width <= p.width && r.top + r.height <= p.height);
    assert.ok(r.left <= c.left && r.top <= c.top && r.left + r.width >= c.left + c.width && r.top + r.height >= c.top + c.height);
    assert.equal(c.left, col ? p.regions[row * p.cols + col - 1].core.left + p.regions[row * p.cols + col - 1].core.width : 0);
    assert.equal(c.top, row ? p.regions[(row - 1) * p.cols + col].core.top + p.regions[(row - 1) * p.cols + col].core.height : 0);
    if (col === p.cols - 1) assert.equal(c.left + c.width, p.width);
    if (row === p.rows - 1) assert.equal(c.top + c.height, p.height);
    if (col) {
      const previous = p.regions[row * p.cols + col - 1].region;
      assert.equal(previous.left + previous.width - r.left, p.overlap);
    }
    if (row) {
      const previous = p.regions[(row - 1) * p.cols + col].region;
      assert.equal(previous.top + previous.height - r.top, p.overlap);
    }
    covered += c.width * c.height;
  }
  assert.equal(covered, p.width * p.height);
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiled-planner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().map(name => {
    const p = path.join(root, name), stat = fs.statSync(p);
    return [name, stat.isDirectory() ? null : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')];
  });
}

test('all presets plan exact dimensions, auto grids and resource summaries without writes', async t => {
  const dir = temporary(t), source = path.join(dir, 'source.png');
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#334455' } }).png().toFile(source);
  const before = snapshot(dir);
  for (const [preset, width, height, cols, rows] of [
    ['2k', 2560, 1440, 3, 2], ['4k', 3840, 2160, 5, 3], ['8k', 7680, 4320, 9, 5], ['16k', 15360, 8640, 18, 10]
  ]) {
    const p = await plan(source, { preset });
    assert.equal(p.preset, preset); assert.equal(p.requestedLongEdge, width); assert.equal(p.requestedShortEdge, null);
    assert.deepEqual([p.width, p.height, p.cols, p.rows], [width, height, cols, rows]);
    assert.equal(p.schemaVersion, 2); assert.equal(p.layoutVersion, 'uniform-core-v2');
    assert.equal(p.maxTileEdge, 1024); assert.equal(p.overlap, 128); assert.equal(p.pad, 64);
    assert.equal(p.pixelCount, width * height); assert.equal(p.resources.canvasRgbaBytes, width * height * 4);
    assert.ok(p.resources.estimatedTemporaryDiskBytes >= p.resources.canvasRgbaBytes * 2);
    checkCoverage(p);
  }
  const p = await plan(source);
  assert.equal(p.preset, '8k'); assert.deepEqual(p.maxCrop, { width: 982, height: 992 });
  assert.deepEqual(snapshot(dir), before, 'Read-only plan must not modify or create files');
});

test('portrait, square, 4:3, narrow images and rounded grids cover every target pixel', () => {
  for (const [width, height] of [[8640, 15360], [15360, 15360], [15360, 11520], [1, 3000], [3000, 1], [1023, 1025], [1025, 1023], [1793, 2691], [17, 19]]) {
    checkCoverage(planGrid(width, height));
  }
  assert.equal(planGrid(15360, 15360).pixelCount, 235929600);
  assert.deepEqual([planGrid(8640, 15360).cols, planGrid(8640, 15360).rows], [10, 18]);
  for (const size of [1023, 1024, 1025]) {
    const p = planGrid(size, size); checkCoverage(p);
    assert.equal(p.tileCount, size <= 1024 ? 1 : 4);
  }
  const smallLimit = planGrid(1001, 667, { 'max-tile-edge': 256, overlap: 32 });
  checkCoverage(smallLimit); assert.equal(smallLimit.maxTileEdge, 256);
});

test('manual layout and pad compatibility preserve exact requested coordinates', () => {
  const a = planGrid(361, 241, { cols: '2', rows: '2', pad: '12', feather: '8' });
  const b = planGrid(361, 241, { cols: '2', rows: '2', overlap: '24', feather: '8' });
  assert.deepEqual(a, b); checkCoverage(a);
  assert.deepEqual(a.regions[0].core, { left: 0, top: 0, width: 181, height: 121 });
  assert.deepEqual(a.regions[0].region, { left: 0, top: 0, width: 193, height: 133 });
  const partlyExplicit = planGrid(2560, 1440, { rows: 4 });
  assert.equal(partlyExplicit.rows, 4); assert.equal(partlyExplicit.cols, 3); checkCoverage(partlyExplicit);
  assert.throws(() => planGrid(7680, 4320, { cols: 4, rows: 3 }), /exceeding.*1024px.*Suggested grid: --cols 9 --rows 5/);
});

test('invalid limits, padding, numeric values, layouts and budgets are rejected', () => {
  const invalid = [
    [{ 'max-tile-edge': 1025 }, /cannot exceed 1024/], [{ 'max-tile-edge': 0 }, /integer/],
    [{ overlap: 127 }, /even/], [{ overlap: 1024 }, /smaller/], [{ overlap: 512 }, /half/],
    [{ overlap: 0 }, /padding/], [{ overlap: 2 }, /padding/], [{ overlap: 128, pad: 64 }, /OR/],
    [{ cols: 0 }, /integer/], [{ rows: 1.5 }, /integer/], [{ cols: 2000 }, /Invalid grid/],
    [{ cols: 100, rows: 100, pad: 2 }, /1000/], [{ cols: 20, pad: 64 }, /half/],
    [{ feather: 0 }, /feather/], [{ overlap: '' }, /integer/], [{ rows: true }, /integer/],
    [{ unknown: 1 }, /Unknown/]
  ];
  for (const [options, error] of invalid) assert.throws(() => planGrid(1536, 1536, options), error, JSON.stringify(options));
  assert.throws(() => planGrid(1.5, 100), /positive integers/);
  assert.throws(() => planGrid(0, 100), /positive integers/);
  assert.equal(planGrid(16001, 16000).pixelCount, 256016000);
  assert.equal(planGrid(16000, 16000).pixelCount, 256000000);
  assert.throws(() => planGrid(32768, 32768), /classic TIFF/);
  assert.throws(() => planGrid(4000, 4000, { 'max-tile-edge': 128, overlap: 4 }), /1000/);
  const p = planGrid(5000, 500, { 'max-tile-edge': 100, overlap: 4, cols: 100, rows: 10 });
  assert.equal(p.tileCount, MAX_TILES); checkCoverage(p);
  assert.throws(() => planGrid(4550, 550, { 'max-tile-edge': 100, overlap: 4, cols: 91, rows: 11 }), /1000/);
});

test('source orientation, larger originals, custom edges and opacity are respected', async t => {
  const dir = temporary(t), rotated = path.join(dir, 'rotated.jpg'), large = path.join(dir, 'larger.png');
  await sharp({ create: { width: 80, height: 40, channels: 3, background: '#998877' } }).withMetadata({ orientation: 6 }).jpeg().toFile(rotated);
  const p = await plan(rotated, { 'long-edge': 160 });
  assert.deepEqual([p.sourceWidth, p.sourceHeight, p.width, p.height], [40, 80, 80, 160]);
  assert.equal(p.preset, null); assert.equal(p.requestedLongEdge, 160);
  const short = await plan(rotated, { 'short-edge': 100 });
  assert.deepEqual([short.width, short.height], [100, 200]); assert.equal(short.requestedLongEdge, null);
  await sharp({ create: { width: 1280, height: 10, channels: 3, background: '#112233' } }).png().toFile(large);
  const preserved = await plan(large, { 'long-edge': 1024 });
  assert.deepEqual([preserved.width, preserved.height], [1280, 10]); assert.equal(preserved.preservedLargerSource, true);
  const transparent = path.join(dir, 'transparent.png'), opaque = path.join(dir, 'opaque.png');
  await sharp({ create: { width: 20, height: 10, channels: 4, background: '#11223380' } }).png().toFile(transparent);
  await sharp({ create: { width: 20, height: 10, channels: 4, background: '#112233ff' } }).png().toFile(opaque);
  const before = snapshot(dir);
  await assert.rejects(plan(transparent, { 'long-edge': 20 }), /Transparent sources/);
  assert.equal((await plan(opaque, { 'long-edge': 20 })).tileCount, 1);
  await assert.rejects(plan(rotated, { preset: '2k', 'long-edge': 20 }), /Choose only one/);
  await assert.rejects(plan(rotated, { 'long-edge': 20, 'short-edge': 10 }), /Choose only one/);
  await assert.rejects(plan(rotated, { preset: '3k' }), /Invalid --preset/);
  await assert.rejects(plan(rotated, { 'long-edge': 0 }), /integer/);
  await assert.rejects(plan(rotated, { 'short-edge': 22000 }), /1000/);
  assert.deepEqual(snapshot(dir), before);
});
