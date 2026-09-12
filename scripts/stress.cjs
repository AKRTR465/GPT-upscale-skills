#!/usr/bin/env node
'use strict';
// Synthetic acceptance harness. Calls no image model and makes no AI-quality
// or registration-quality claims. Child isolation measures each shape afresh.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const MEMORY_LIMIT = 4 * 1024 ** 3;
const SHAPES = Object.freeze({ landscape: [1024, 576], standard: [1024, 768], square: [1024, 1024], portrait: [576, 1024] });
function options(args) {
  const result = {}, allowed = ['work-dir', 'report', 'long-edge', 'shape', 'child', 'dimensions'];
  for (let i = 0; i < args.length; i += 2) {
    assert(args[i].startsWith('--') && allowed.includes(args[i].slice(2)) && args[i + 1] && !args[i + 1].startsWith('--'), `Invalid argument ${args[i]}`);
    const key = args[i].slice(2); assert(!(key in result), `Duplicate --${key}`); result[key] = args[i + 1];
  }
  return result;
}
function diskBytes(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += diskBytes(p);
    else if (entry.isFile()) bytes += fs.statSync(p).size;
  }
  return bytes;
}
function save(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, (key, entry) => ['destination', 'filesystemPath'].includes(key) ? undefined : entry, 2) + '\n');
}
const rssHighWater = () => process.resourceUsage().maxRSS * 1024;
const elapsed = start => Number(process.hrtime.bigint() - start) / 1e6;

async function syntheticSource(sharp, filename, width, height) {
  // Geometry, smooth gradients and a fine repetitive pattern exercise both
  // compression and seams without reading or publishing any personal images.
  const circles = Array.from({ length: 30 }, (_, i) => `<circle cx="${(i * 137 + 41) % width}" cy="${(i * 89 + 29) % height}" r="${7 + i % 19}" fill="rgb(${(i * 37) % 200 + 30},${(i * 51) % 180 + 40},${(i * 23) % 160 + 60})"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop stop-color="#25496c"/><stop offset="1" stop-color="#d9b77b"/></linearGradient><pattern id="p" width="31" height="29" patternUnits="userSpaceOnUse"><path d="M0 0L31 29M31 0L0 29" stroke="#87a58b" stroke-width="0.6"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#p)"/>${circles}<path d="M0 ${height / 3}L${width} ${height * 2 / 3}M${width / 4} 0L${width * 3 / 4} ${height}" stroke="#f0deb9" stroke-width="3"/></svg>`;
  await sharp(Buffer.from(svg)).removeAlpha().png().toFile(filename);
}

async function fixtureRecords(sharp, p, job, manifest) {
  const base = p.hash(path.join(job, manifest.base));
  let altered = 0;
  for (let index = 0; index < manifest.regions.length; index++) {
    const t = manifest.regions[index], generated = `generated/${t.id}.png`, aligned = `aligned/${t.id}.png`;
    const crop = await sharp(path.join(job, t.input)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(crop.info.width, t.region.width); assert.equal(crop.info.height, t.region.height);
    assert(crop.info.width <= 1024 && crop.info.height <= 1024);
    if (index === 0 || index % 17 === 3) {
      altered++;
      for (let y = 0; y < t.region.height; y++) for (let x = 0; x < t.region.width; x++) {
        const i = (y * t.region.width + x) * 4;
        crop.data[i] = Math.min(255, crop.data[i] + 12);
        crop.data[i + 1] = Math.max(0, crop.data[i + 1] - 7);
        crop.data[i + 3] = 96 + ((x + y) % 160);
      }
    }
    await sharp(crop.data, { raw: { width: t.region.width, height: t.region.height, channels: 4 } }).png().toFile(path.join(job, generated));
    fs.copyFileSync(path.join(job, generated), path.join(job, aligned));
    const r = {
      id: t.id, state: 'accepted', method: 'generated', generated, aligned,
      nativeWidth: t.region.width, nativeHeight: t.region.height,
      prompt: 'Synthetic test fixture, no model was called.', reason: null,
      qaNote: 'Synthetic fixture only; acceptance exercises export infrastructure, not human visual QA.',
      stats: { syntheticFixture: true, registrationSkipped: true }, alignedSha256: p.hash(path.join(job, aligned))
    };
    r.signature = crypto.createHash('sha256').update(JSON.stringify({
      region: t, input: p.hash(path.join(job, t.input)), generated: p.hash(path.join(job, generated)),
      mask: null, base, method: r.method, prompt: r.prompt, reason: r.reason
    })).digest('hex');
    save(path.join(job, 'records', `${t.id}.json`), r);
  }
  return { records: manifest.regions.length, colorAndAlphaPerturbedTiles: altered, modelCalls: 0, registrationCalls: 0 };
}

function customDimensions(value) {
  assert(typeof value === 'string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(value), '--dimensions must be WIDTHxHEIGHT');
  const dims = value.split('x').map(Number); require('./planner.cjs').planGrid(...dims); return dims;
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }

async function child(opt) {
  const sharp = require('sharp'), p = require('./pipeline.cjs');
  const shape = opt.shape, exact = opt.dimensions ? customDimensions(opt.dimensions) : null;
  const divisor = exact ? gcd(...exact) : 1;
  const sourceDims = exact ? exact.map(d => d / divisor) : SHAPES[shape], longEdge = exact ? Math.max(...exact) : Number(opt['long-edge']);
  assert(sourceDims && Number.isInteger(longEdge) && longEdge >= 1024, 'Child requires a valid shape and long edge >= 1024');
  const work = path.resolve(opt['work-dir']), reportPath = path.resolve(opt.report);
  fs.mkdirSync(work, { recursive: true });
  const temp = fs.mkdtempSync(path.join(work, `${shape}-`)), job = path.join(temp, 'job'), output = path.join(temp, 'export'), source = path.join(temp, 'source.png');
  const report = {
    shape, requestedLongEdge: longEdge, expectedDimensions: exact || sourceDims.map(d => Math.round(d * longEdge / 1024)),
    testKind: 'synthetic export acceptance; no image model or registration', platform: process.platform,
    node: process.version, memoryLimitBytes: MEMORY_LIMIT, stages: [], passed: false,
    diskMeasurement: 'Recursive file sizes at stage ends. Peak estimate adds transient raster bytes reported by the renderer; it is not a continuously sampled exact disk peak.'
  };
  const started = process.hrtime.bigint();
  let maxObservedDiskBytes = 0, estimatedPeakDiskBytes = 0, previousDiskBytes = 0;
  async function stage(name, fn) {
    const start = process.hrtime.bigint(), highWaterBefore = rssHighWater();
    let sampledPeakRssBytes = process.memoryUsage().rss;
    const timer = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 200);
    let value;
    try { value = await fn(); return value; }
    finally {
      clearInterval(timer); sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
      const diskBytesAfter = diskBytes(temp), temporaryRasterBytes = value?.resources?.temporaryRasterBytes || value?.temporaryRasterBytes || 0;
      maxObservedDiskBytes = Math.max(maxObservedDiskBytes, diskBytesAfter);
      estimatedPeakDiskBytes = Math.max(estimatedPeakDiskBytes, Math.max(previousDiskBytes, diskBytesAfter) + temporaryRasterBytes);
      previousDiskBytes = diskBytesAfter;
      const result = { name, milliseconds: elapsed(start), sampledPeakRssBytes, cumulativeOsPeakRssBefore: highWaterBefore, cumulativeOsPeakRssAfter: rssHighWater(), diskBytesAfter, temporaryRasterBytes };
      report.stages.push(result);
      process.stdout.write(`${shape}: ${name} ${(result.milliseconds / 1000).toFixed(1)}s, cumulative peak ${(result.cumulativeOsPeakRssAfter / 1024 ** 2).toFixed(0)} MiB\n`);
    }
  }
  try {
    await stage('source', () => syntheticSource(sharp, source, ...sourceDims));
    const prepared = await stage('prepare', () => p.prepare(source, job, longEdge === 15360 ? { preset: '16k' } : { 'long-edge': longEdge }));
    assert.deepEqual(prepared.dimensions, report.expectedDimensions);
    const manifest = JSON.parse(fs.readFileSync(path.join(job, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2); report.tileCount = manifest.regions.length; report.maxCrop = manifest.maxCrop;
    report.fixture = await stage('synthetic-records', () => fixtureRecords(sharp, p, job, manifest));
    const assembled = await stage('assemble', () => p.assemble(job, output));
    assert.deepEqual(assembled.dimensions, report.expectedDimensions);
    const verified = await stage('verify', () => p.verify(output));
    assert.equal(verified.passed, true);
    assert.deepEqual([verified.width, verified.height], report.expectedDimensions);
    assert.equal(verified.pixelsCompared, manifest.width * manifest.height, 'Verification must cover every output pixel');
    report.verification = verified;
    const replanned = await stage('replan-export', () => p.plan(path.join(output, 'refined.png'), { 'long-edge': longEdge - 1 }));
    assert.deepEqual([replanned.width, replanned.height], report.expectedDimensions);
    assert.equal(replanned.preservedLargerSource, true);
    report.largeSourceReplanPassed = true;
    report.exportBytes = { png: fs.statSync(path.join(output, 'refined.png')).size, svg: fs.statSync(path.join(output, 'refined.svg')).size };
    report.peakResidentBytes = rssHighWater();
    assert(report.peakResidentBytes <= MEMORY_LIMIT, `Peak RSS ${report.peakResidentBytes} exceeds 4 GiB`);
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error); report.peakResidentBytes = rssHighWater();
  } finally {
    report.elapsedMilliseconds = elapsed(started); report.maxObservedDiskBytes = maxObservedDiskBytes; report.estimatedPeakDiskBytes = estimatedPeakDiskBytes;
    // temp was created here beneath work. Reports live outside temp and survive.
    const relative = path.relative(work, temp);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Cleanup target escaped acceptance workspace');
    const reportRelative = path.relative(temp, reportPath);
    assert(reportRelative === '..' || reportRelative.startsWith('..' + path.sep) || path.isAbsolute(reportRelative), 'Report must be outside the temporary fixture');
    fs.rmSync(temp, { recursive: true, force: true }); report.temporaryFixtureRemoved = true;
    save(reportPath, report);
  }
  return report.passed;
}

async function parent(opt) {
  const longEdge = opt['long-edge'] === undefined ? 15360 : Number(opt['long-edge']);
  assert(!opt.dimensions || (!opt.shape && !opt['long-edge']), '--dimensions is exclusive with --shape and --long-edge');
  const exact = opt.dimensions ? customDimensions(opt.dimensions) : null;
  assert(Number.isSafeInteger(longEdge) && longEdge >= 1024, '--long-edge must be an integer >= 1024');
  const selected = exact ? ['custom'] : opt.shape ? [opt.shape] : Object.keys(SHAPES);
  assert(exact || selected.every(s => Object.prototype.hasOwnProperty.call(SHAPES, s)), '--shape must be landscape, standard, square or portrait');
  for (const shape of selected) { const dims = exact || SHAPES[shape].map(d => Math.round(d * longEdge / 1024)); require('./planner.cjs').planGrid(...dims); }
  const work = path.resolve(opt['work-dir'] || path.join('work', 'stress'));
  fs.mkdirSync(work, { recursive: true }); const run = fs.mkdtempSync(path.join(work, 'acceptance-'));
  const reportPath = path.resolve(opt.report || path.join(run, 'report.json'));
  const result = {
    schemaVersion: 1, testKind: 'synthetic large-canvas infrastructure acceptance', startedAt: new Date().toISOString(),
    longEdge: exact ? Math.max(...exact) : longEdge, requestedDimensions: exact, full16kAcceptance: !exact && longEdge === 15360 && selected.length === 4, memoryLimitBytes: MEMORY_LIMIT,
    platform: process.platform, node: process.version, execution: 'sequential isolated child processes', shapes: [], passed: false
  };
  for (const shape of selected) {
    const childReport = path.join(run, `${shape}.json`);
    const status = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [__filename, '--child', 'true', '--work-dir', run, '--report', childReport, '--long-edge', String(longEdge), '--shape', shape, ...(exact ? ['--dimensions', opt.dimensions] : [])], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      proc.once('error', reject); proc.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const report = fs.existsSync(childReport) ? JSON.parse(fs.readFileSync(childReport, 'utf8')) : { shape, passed: false, error: 'Child exited before writing its report' };
    result.shapes.push({ ...report, childExitCode: status.code, childSignal: status.signal });
    save(reportPath, result);
  }
  result.completedAt = new Date().toISOString();
  result.passed = result.shapes.every(s => s.passed && s.childExitCode === 0 && s.peakResidentBytes <= MEMORY_LIMIT);
  save(reportPath, result);
  process.stdout.write(`Acceptance ${result.passed ? 'passed' : 'failed'}: ${selected.length} shapes; report ${reportPath}\n`);
  return result.passed;
}
async function main(args) { const opt = options(args); const passed = opt.child ? await child(opt) : await parent(opt); if (!passed) process.exitCode = 1; }
module.exports = { diskBytes, SHAPES };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
