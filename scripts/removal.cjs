'use strict';
// Read-only provenance gate. Editing, masked compositing and visual QA belong
// to the host cleanup workflow; this does not run a model or certify its art.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectImage } = require('./resources.cjs');
const OPTIONS = ['watermark-removal', 'removal-record'];
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
function hash(filename) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(filename, 'r'), buf = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
const oriented = m => m.orientation >= 5 && m.orientation <= 8 ? [m.height, m.width] : [m.width, m.height];
async function removalProvenance(source, opt) {
  const mode = opt['watermark-removal'] === undefined ? 'off' : opt['watermark-removal'];
  assert(mode === 'off' || mode === 'on', '--watermark-removal must be off or on');
  if (mode === 'off') {
    assert(opt['removal-record'] === undefined, '--removal-record requires --watermark-removal on');
    return { enabled: false, status: 'disabled' };
  }
  assert(typeof opt['removal-record'] === 'string' && opt['removal-record'].trim(),
    'Cleanup stage required: provide --removal-record after the workflow in references/watermark-removal.md');
  const recordFile = path.resolve(opt['removal-record']), r = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert(r.schemaVersion === 1 && ['cleaned', 'not-found', 'partial'].includes(r.status), 'Invalid removal record status/version');
  assert(typeof r.original?.path === 'string' && r.original.path.trim(), 'Removal record needs original.path');
  const original = path.resolve(path.dirname(recordFile), r.original.path);
  assert(r.original.sha256 === hash(original), 'Removal original hash mismatch');
  assert(r.resultSha256 === hash(source), 'Removal result hash mismatch: SOURCE must be the reviewed cleanup result');
  const [oldMeta, newMeta] = await Promise.all([inspectImage(original), inspectImage(source)]);
  const [w, h] = oriented(oldMeta), [nw, nh] = oriented(newMeta);
  assert(w === nw && h === nh, 'Cleanup must preserve oriented source dimensions');
  assert(Array.isArray(r.edits), 'Removal record needs an edits array');
  assert(typeof r.review?.note === 'string' && r.review.note.trim(), 'Removal record needs a visual review note');
  assert(r.review.outsideMaskChangedPixels === 0, 'Cleanup record must report zero changed pixels outside the mask');
  for (const e of r.edits) {
    const c = e.crop;
    assert(c && ['left', 'top', 'width', 'height'].every(k => Number.isSafeInteger(c[k])) &&
      c.left >= 0 && c.top >= 0 && c.width > 0 && c.height > 0 && c.width <= 1024 && c.height <= 1024 &&
      c.left + c.width <= w && c.top + c.height <= h, 'Removal crop must fit source and the 1024px edit cap');
    assert(['removed', 'retained'].includes(e.outcome), 'Removal edit outcome must be removed or retained');
    if (e.outcome === 'removed') {
      assert(typeof e.prompt === 'string' && e.prompt.trim() && typeof e.mask === 'string' && e.mask.trim(), 'Removed edit needs exact prompt and mask reference');
      assert(e.nativeSize && ['width', 'height'].every(k => Number.isSafeInteger(e.nativeSize[k]) && e.nativeSize[k] > 0), 'Removed edit needs actual nativeSize');
    } else assert(typeof e.reason === 'string' && e.reason.trim(), 'Retained removal needs a reason');
  }
  const retained = r.edits.filter(e => e.outcome === 'retained').length;
  assert(r.status !== 'cleaned' || (r.edits.length > 0 && retained === 0), 'Cleaned status requires all listed edits removed');
  assert(r.status !== 'partial' || retained > 0, 'Partial status needs a retained edit');
  assert(r.status !== 'not-found' || (r.edits.length === 0 && r.resultSha256 === r.original.sha256), 'Not-found must preserve the original file');
  assert(r.status !== 'cleaned' || ['png', 'tiff'].includes(newMeta.format), 'Cleaned source must be lossless PNG or TIFF');
  assert(r.status !== 'partial' || r.edits.length === retained || ['png', 'tiff'].includes(newMeta.format), 'Edited partial source must be lossless PNG or TIFF');
  return { enabled: true, status: r.status, recordSource: recordFile, recordSha256: hash(recordFile), record: r,
    provenanceCheck: 'File hashes, oriented dimensions and record consistency checked; locality and visual QA are recorded host-workflow results.' };
}
module.exports = { OPTIONS, removalProvenance };
