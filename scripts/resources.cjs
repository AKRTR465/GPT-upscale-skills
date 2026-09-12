'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const CLASSIC_TIFF_MAX_BYTES = 0xffffffff;
const MAX_DIMENSION = 0x7fffffff;
const MAX_TILES = 1000;

function dimensions(width, height) {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0,
    'Canvas dimensions must be positive integers');
  assert(width <= MAX_DIMENSION && height <= MAX_DIMENSION, 'Image dimensions exceed the signed 32-bit format boundary');
  const pixels = width * height;
  assert(Number.isSafeInteger(pixels) && Number.isSafeInteger(pixels * 4), 'Image byte count exceeds safe integer arithmetic');
  return pixels;
}

// Matches DiskRaster's actual classic TIFF header and RGBA strip layout.
function rasterLayout(width, height) {
  const pixels = dimensions(width, height), rowsPerStrip = 64, strips = Math.ceil(height / rowsPerStrip), count = 11;
  const bitsOffset = 8 + 2 + count * 12 + 4;
  const offsetsOffset = bitsOffset + 8, countsOffset = offsetsOffset + strips * 4;
  const pixelOffset = Math.ceil((countsOffset + strips * 4) / 4096) * 4096;
  const fileBytes = pixelOffset + pixels * 4;
  assert(fileBytes <= CLASSIC_TIFF_MAX_BYTES,
    'RGBA temporary file exceeds classic TIFF 32-bit addressing; BigTIFF or segmented storage is required');
  return { rowsPerStrip, strips, count, bitsOffset, offsetsOffset, countsOffset, pixelOffset, fileBytes };
}

function tiledTiffBytes(width, height, channels = 3) {
  dimensions(width, height);
  const tiles = Math.ceil(width / 256) * Math.ceil(height / 256);
  // Includes edge-tile padding, offset/byte-count tables and metadata allowance.
  const bytes = tiles * (256 * 256 * channels + 32) + 65536;
  assert(Number.isSafeInteger(bytes) && bytes <= CLASSIC_TIFF_MAX_BYTES,
    'Padded temporary TIFF exceeds classic TIFF 32-bit addressing; BigTIFF or segmented storage is required');
  return bytes;
}

function validateCanvas(width, height) {
  const pixelCount = dimensions(width, height), raster = rasterLayout(width, height);
  return { pixelCount, raster, baseTiffBytes: tiledTiffBytes(width, height) };
}

// Use explicit, already validated dimensions at every full-canvas read.
function imageOptions(width, height) { return { limitInputPixels: dimensions(width, height) }; }
async function inspectImage(filename) {
  // Header inspection only. Pixel decoding always uses an explicit limit below.
  const meta = await sharp(filename, { limitInputPixels: false }).metadata();
  validateCanvas(meta.width, meta.height);
  assert(!meta.pages || meta.pages === 1, 'Only single-frame still images are supported');
  return meta;
}

function resourceEstimate(width, height, regions, groups = []) {
  const canvas = validateCanvas(width, height), pixels = canvas.pixelCount;
  assert(Array.isArray(regions) && regions.length <= MAX_TILES, 'Job exceeds 1000 editing blocks');
  let cropPixels = 0, masks = 0, detailWorkingBytes = 0;
  for (const t of regions) {
    cropPixels += dimensions(t.region.width, t.region.height);
    if (t.mask) masks += tiledTiffBytes(t.region.width, t.region.height, 1);
  }
  for (const g of groups) {
    const r = g.region, bytes = tiledTiffBytes(r.width, r.height, 1);
    masks += bytes;
    detailWorkingBytes = Math.max(detailWorkingBytes, rasterLayout(r.width, r.height).fileBytes + bytes);
  }
  // Compression is content-dependent. Estimate near raw size, including SVG base64.
  const estimatedPngBytes = Math.ceil(pixels * 3 * 1.02) + 65536;
  const estimatedSvgBytes = Math.ceil((pixels + cropPixels) * 4 * 1.02 * 4 / 3) + (regions.length + 1000) * 1024;
  const estimatedExportBytes = estimatedPngBytes + estimatedSvgBytes;
  const estimatedTemporaryDiskBytes = canvas.baseTiffBytes + canvas.raster.fileBytes + cropPixels * 12 + masks + detailWorkingBytes;
  return {
    policyVersion: 1, fixedPixelLimit: null, maxEditableBlocks: MAX_TILES,
    storageFormat: 'classic-tiff-rgba8', classicTiffMaxBytes: CLASSIC_TIFF_MAX_BYTES,
    canvasRgbaBytes: pixels * 4, canvasTiffBytes: canvas.raster.fileBytes, baseTiffBytes: canvas.baseTiffBytes,
    estimatedTemporaryDiskBytes, estimatedExportBytes,
    estimatedAdditionalAssemblyBytes: canvas.raster.fileBytes + detailWorkingBytes + estimatedExportBytes,
    estimatedAdditionalVerificationBytes: canvas.baseTiffBytes,
    estimatedAdditionalPrepareBytes: estimatedTemporaryDiskBytes + estimatedExportBytes,
    diskEstimateNote: 'Content-dependent estimate including PNG/SVG exports; excludes retries and unrelated jobs. Disk checks add 20% and 256 MiB, and do not reserve space.',
    checksPassed: true, diskCheck: { status: 'not-requested' }
  };
}

function checkDisk(destination, additionalBytes) {
  assert(Number.isSafeInteger(additionalBytes) && additionalBytes >= 0, 'Invalid disk estimate');
  let existing = path.resolve(destination);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    assert(parent !== existing, 'Cannot locate destination filesystem'); existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) existing = path.dirname(existing);
  existing = fs.realpathSync(existing);
  const stat = fs.statfsSync(existing, { bigint: true });
  const available = stat.bavail * stat.bsize;
  const requiredBytes = Math.ceil(additionalBytes * 1.2) + 256 * 1024 ** 2;
  assert(Number.isSafeInteger(requiredBytes), 'Disk budget exceeds safe integer arithmetic');
  assert(available >= BigInt(requiredBytes),
    `Insufficient disk space at ${existing}: need ${requiredBytes} available bytes, found ${available}. Choose a destination with more free space`);
  return { status: 'passed', checkedAt: new Date().toISOString(), destination: path.resolve(destination), filesystemPath: existing,
    availableBytes: Number(available), requiredBytes, reservedBytes: 0 };
}

module.exports = { MAX_TILES, CLASSIC_TIFF_MAX_BYTES, dimensions, rasterLayout, tiledTiffBytes, validateCanvas,
  imageOptions, inspectImage, resourceEstimate, checkDisk };
