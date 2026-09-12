'use strict';
// Shared, read-only geometry planning. No image generation or filesystem writes.
const sharp = require('sharp');
const MAX_PIXELS = 256000000;
const MAX_TILES = 1000;
const PRESETS = Object.freeze({ '2k': 2560, '4k': 3840, '8k': 7680, '16k': 15360 });
const LAYOUT_OPTIONS = ['max-tile-edge', 'overlap', 'pad', 'cols', 'rows', 'feather'];
const SIZE_OPTIONS = ['preset', 'long-edge', 'short-edge'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function assert(ok, message) { if (!ok) throw new Error(message); }
function integer(value, fallback, name, min = 1) {
  const n = value === undefined ? fallback : Number(value);
  assert(value !== '' && value !== null && typeof value !== 'boolean' && Number.isSafeInteger(n) && n >= min, `Invalid --${name}: expected an integer >= ${min}`);
  return n;
}
function checkOptions(opt, allowed) {
  for (const key of Object.keys(opt)) assert(allowed.includes(key), `Unknown option --${key}`);
}
function validateCanvas(width, height) {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0, 'Canvas dimensions must be positive integers');
  assert(width * height <= MAX_PIXELS, `Canvas exceeds ${MAX_PIXELS} pixels (256 MP); reduce the requested dimensions`);
}
function planGrid(width, height, opt = {}) {
  checkOptions(opt, LAYOUT_OPTIONS); validateCanvas(width, height);
  const maxTileEdge = integer(opt['max-tile-edge'], 1024, 'max-tile-edge');
  assert(maxTileEdge <= 1024, 'Hard tile limit: --max-tile-edge cannot exceed 1024');
  assert(!(own(opt, 'overlap') && own(opt, 'pad')), 'Choose --overlap OR --pad, not both');
  const overlap = own(opt, 'pad') ? 2 * integer(opt.pad, 64, 'pad', 0) : integer(opt.overlap, 128, 'overlap', 0);
  assert(overlap % 2 === 0, '--overlap must be even, because each side receives half');
  assert(overlap < maxTileEdge, '--overlap must be smaller than --max-tile-edge');
  const pad = overlap / 2, coreLimit = maxTileEdge - overlap;
  const recommendedCols = width <= maxTileEdge ? 1 : Math.ceil(width / coreLimit);
  const recommendedRows = height <= maxTileEdge ? 1 : Math.ceil(height / coreLimit);
  const cols = integer(opt.cols, recommendedCols, 'cols'), rows = integer(opt.rows, recommendedRows, 'rows');
  assert(cols <= width && rows <= height, 'Invalid grid: rows and columns cannot exceed canvas dimensions');
  assert(cols * rows <= MAX_TILES, `Grid exceeds ${MAX_TILES} editable blocks; reduce dimensions or overlap, or raise a lowered tile limit`);
  const feather = opt.feather === undefined ? 48 : Number(opt.feather);
  assert(opt.feather !== '' && opt.feather !== null && typeof opt.feather !== 'boolean' && Number.isFinite(feather) && feather > 0, 'Invalid --feather: expected a positive finite number');
  assert(cols * rows === 1 || pad >= 2, 'Multi-tile jobs need padding of at least 2 pixels (overlap >= 4)');
  // Check only split axes: a one-pixel-high banner does not need vertical seams.
  assert((cols === 1 || pad < Math.floor(width / cols) / 2) && (rows === 1 || pad < Math.floor(height / rows) / 2),
    'Padding must be less than half the smallest core edge on each split axis; reduce overlap or use fewer manual divisions');
  const regions = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const left = Math.round(col * width / cols), top = Math.round(row * height / rows);
    const right = Math.round((col + 1) * width / cols), bottom = Math.round((row + 1) * height / rows);
    const x = Math.max(0, left - pad), y = Math.max(0, top - pad), id = `r${row + 1}c${col + 1}`;
    const core = { left, top, width: right - left, height: bottom - top };
    const region = { left: x, top: y, width: Math.min(width, right + pad) - x, height: Math.min(height, bottom + pad) - y };
    assert(region.width <= maxTileEdge && region.height <= maxTileEdge,
      `Tile ${id} is ${region.width}x${region.height}, exceeding the ${maxTileEdge}px limit. Suggested grid: --cols ${recommendedCols} --rows ${recommendedRows}`);
    assert(core.width > 0 && core.height > 0 && region.left <= core.left && region.top <= core.top &&
      region.left + region.width >= right && region.top + region.height >= bottom &&
      region.left + region.width <= width && region.top + region.height <= height, 'Invalid planned crop geometry');
    regions.push({ id, kind: 'tile', row, col, core, region, input: `inputs/${id}.png` });
  }
  const pixelCount = width * height, cropPixels = regions.reduce((sum, t) => sum + t.region.width * t.region.height, 0);
  return {
    schemaVersion: 2, layoutVersion: 'uniform-core-v2', width, height, maxTileEdge, cols, rows, pad, overlap, feather,
    pixelCount, tileCount: regions.length,
    maxCrop: { width: Math.max(...regions.map(t => t.region.width)), height: Math.max(...regions.map(t => t.region.height)) },
    regions,
    resources: {
      maxPixels: MAX_PIXELS, maxEditableBlocks: MAX_TILES, canvasRgbaBytes: pixelCount * 4,
      // Base TIFF + canvas TIFF + uncompressed-equivalent inputs/results/aligned
      // tiles. This is planning guidance, not a disk-space reservation or cap.
      estimatedTemporaryDiskBytes: pixelCount * 8 + cropPixels * 12,
      diskEstimateNote: 'Estimate for base/canvas and three tile copies; excludes final exports, extra detail blocks, retries and filesystem overhead.',
      checksPassed: true
    }
  };
}
async function plan(source, opt = {}) {
  checkOptions(opt, [...LAYOUT_OPTIONS, ...SIZE_OPTIONS]);
  const selectors = SIZE_OPTIONS.filter(key => own(opt, key));
  assert(selectors.length <= 1, 'Choose only one of --preset, --long-edge OR --short-edge');
  const preset = selectors.length === 0 ? '8k' : own(opt, 'preset') ? opt.preset : null;
  assert(preset === null || own(PRESETS, preset), 'Invalid --preset: choose 2k, 4k, 8k or 16k');
  const requestedLongEdge = preset ? PRESETS[preset] : own(opt, 'long-edge') ? integer(opt['long-edge'], undefined, 'long-edge') : null;
  const requestedShortEdge = own(opt, 'short-edge') ? integer(opt['short-edge'], undefined, 'short-edge') : null;
  const meta = await sharp(source, { limitInputPixels: MAX_PIXELS }).metadata();
  assert(meta.width && meta.height, 'Source does not have readable image dimensions');
  const swap = meta.orientation >= 5 && meta.orientation <= 8;
  const sourceWidth = swap ? meta.height : meta.width, sourceHeight = swap ? meta.width : meta.height;
  validateCanvas(sourceWidth, sourceHeight);
  const scale = Math.max(1, requestedShortEdge !== null ? requestedShortEdge / Math.min(sourceWidth, sourceHeight) : requestedLongEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale), height = Math.round(sourceHeight * scale);
  const layout = Object.fromEntries(LAYOUT_OPTIONS.filter(key => own(opt, key)).map(key => [key, opt[key]]));
  const grid = planGrid(width, height, layout);
  // A source without alpha is necessarily opaque; stats streams sources with
  // alpha instead of materializing a normalized full-canvas image buffer.
  assert(!meta.hasAlpha || (await sharp(source, { limitInputPixels: MAX_PIXELS }).stats()).isOpaque,
    'Transparent sources need a separate alpha-preserving workflow');
  return {
    ...grid, sourceWidth, sourceHeight, preset, requestedLongEdge, requestedShortEdge,
    scale, preservedLargerSource: requestedShortEdge !== null ? Math.min(sourceWidth, sourceHeight) > requestedShortEdge : Math.max(sourceWidth, sourceHeight) > requestedLongEdge
  };
}
module.exports = { plan, planGrid, MAX_PIXELS, MAX_TILES };
