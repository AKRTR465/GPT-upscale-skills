# Operating guide

## Canvas and tile planning

The coordinate base is an oriented, sRGB image resized to the target canvas. It provides a stable reference and fills narrow uncovered edges. It is not evidence of reconstructed detail.

Treat 7680 pixels on the long edge as a default convention, not a universal definition of 8K. A 2:3 portrait becomes 5120×7680. A 4.31:1 banner at 7680 pixels wide is only about 1782 pixels high; a request for a 4320-pixel short edge instead requires approximately 18620 pixels of width. Calculate from the actual oriented source dimensions and round once. Preserve a source that is already larger unless the user asks to reduce it.

Start from a grid appropriate to the scene, then adapt to the editor's actual returned size:

| Shape | Example grid | Typical initial overlap |
|---|---|---|
| Landscape | 4 columns × 3 rows | 448 pixels |
| Portrait | 3 columns × 4 rows | 448 pixels |
| Wide banner | 6 columns × 2 rows | 256 pixels |

`pad` extends each core on all sides. Adjacent tiles overlap by twice `pad`, clipped at canvas edges. These are working examples, not model limits. The helper requires pad to be smaller than half the smallest core edge to keep neighbors and seam strips well-defined.

For a tile destined for `(Tw, Th)` with actual generated size `(Gw, Gh)`, report the final placement factors `Tw/Gw` and `Th/Gh`. A request for 2000 pixels may return fewer pixels. For example, a 1932×2144 destination filled by 1191×1321 generated pixels is still enlarged about 1.62×. Requesting a larger size in prose does not establish a native output resolution.

If the observed factor is much above your chosen quality target (1.5× is a useful review point, not a strict limit), use more/smaller cores or describe the limitation. Overlap also consumes the editor's pixel budget. Do one representative pilot before dispatching all edits. Favor semantic crops around eyes, hands, lettering, and repeated geometry over indiscriminately increasing tile count.

The helper currently targets **opaque still images**. Transparency preservation, HDR, animation, and scientific pixel values need a different normalization/compositing path.

## Edit prompts and review

Use the normalized crop as the edit target, with full-image style context if the host supports separate reference images. Inspect each input before editing; follow the host tool's available schema rather than assuming exact model names or pixel-size arguments.

Keep objects cut off by crop boundaries cut off. Ask for stable edge geometry and color. Do not complete a cropped hand or ornament, move a pupil, alter a silhouette, or turn printed grain into photographic texture. A border band of about 10–15% is a useful prompt cue, but it is not a hard pixel mask and does not guarantee matching edges.

Save the exact prompt and actual result before alignment. Redraws can change symbols, tiny text, decorative marks, texture, and anatomy even when the prompt says not to. Preserve intentional depth-of-field and brush softness. Evaluate at matching display scales; a small full-image preview is inadequate for judging final detail.

## Registration and color matching

The bundled registration follows the tested workflow:

1. Build blurred grayscale references at up to 640 pixels wide.
2. Estimate an affine transform with ECC. Reject excessive determinant, shear, or translation, and reject an affine transform that lowers correlation.
3. Compute Farneback optical flow after the affine step. Smooth the field and limit displacement to the equivalent of 7 pixels at a 640-pixel reference width.
4. Combine the transform and flow into one map, sampling the original generated pixels only once at final resolution.
5. Estimate local low-frequency RGB differences and add bounded color corrections while retaining high-frequency detail.

The affine bounds are defaults from one workflow, not quality guarantees. Check warnings, extreme flow clipping, uncovered borders, warped faces, and bent mechanical lines. A high normalized cross-correlation can coexist with a wrong eye or invented ornament. Repeated textures and very flat regions can be ambiguous; an ECC failure falls back to identity affine and still requires visual review.

Large appearance changes should be regenerated rather than forced into place with aggressive flow. `reset` archives one region's result and review so it can be regenerated without discarding other completed work.

## Seam blending and important regions

Tiles assemble in row-major order. In each actual overlap, the helper computes a continuous minimum-cost seam using color difference, a small edge penalty, and a weak center preference. It applies a smooth alpha transition around this seam. This is different from assigning fixed rectangular fade bands to every tile.

The default feather is 48 destination pixels, clamped to the available overlap. Make it narrower where thin lines otherwise double, or broader for gradual texture transitions. Wider feathering cannot repair incorrect geometry. Review the exact join on grids, repeated tiles, hair, ribbons, straight edges, and structured fabric. `seams.jpg` displays the selected routes.

For a portrait or important object, plan a context-rich crop and an independent **grayscale mask** at that crop's destination size. White means use the refined region, black means keep the assembled canvas. Use a soft shaped contour; an arbitrary rectangle can introduce a visible border. Register detail regions against the same base as the tiles. The helper applies them after grid assembly in manifest order. Inspect expression, gaze, teeth, finger count, boundaries, and continuity with the neck or surrounding objects.

## Optional authorized removal edits

Removal is not part of default enlargement. When it is requested, identify the exact overlay and distinguish it from signs, decorative symbols, labels, or text that belong to the scene.

For this helper, make a separately reviewed clean source **before** `prepare`:

1. Crop the requested edit with surrounding context and use the host image editor to reconstruct the background.
2. Align using unchanged surrounding pixels. Exclude the removal mask from registration and color estimation; do not force erased lettering to match the original.
3. Composite only through the explicit removal mask. Compare original and cleaned decoded pixels outside the mask to verify locality, and save the clean source losslessly without overwriting the original.
4. Use that clean source for the refinement job. This prevents hidden original signatures or lettering from returning through the SVG's reference layer, overlap blend, or color correction.

The current CLI does not automate removal-mask registration/exclusion. Do not use its ordinary `align` command as an inpainting-mask aligner. Use host-supported editing/compositing or a suitably adapted script, then enter the standard pipeline. Keep the edit prompt and comparison in the delivery records. Do not describe a retained region or rejected edit as successfully redrawn.

## Job ownership and resumability

`manifest.json` describes the complete queue, and `records/<id>.json` describes one region's state. Each worker owns disjoint IDs. Planning operations happen before import; assembly and final delivery have one owner. Per-region records are written through a temporary file and rename. This is not a distributed lock service: two workers must never process the same ID.

Use `status` to find unfinished work. Use `reset` for a failed visual result and `retain` for a declared source-based fallback. The assembly gate requires complete grid membership, every region's visual acceptance, and unchanged inputs/results/masks. It checks file hashes again; the existence of an old aligned PNG alone is insufficient.

For partial progress, show the contact sheet or individual QA crops. The helper intentionally has no "ignore missing tiles" final-export option. If a requested batch is incomplete, say which images or regions remain instead of counting a preview as a deliverable.

## Validation and packaging

Use two separate acceptance tracks:

- **Visual:** overall composition, meaningful local improvements, identity and anatomy, seam crossings, no invented text, intentional style/blur, edit-mask edges.
- **Mechanical:** dimensions, complete records, generated/retained counts, native generation size, standalone SVG data, full-size SVG rasterization versus PNG, and copied-file hashes.

The SVG embeds PNGs in individual Inkscape-compatible layer groups. Large embedded PNGs are losslessly subdivided to avoid very large data attributes. This retains editability at the layer level, not at individual hair-strand or path level. Files may be hundreds of megabytes; publish smaller examples to documentation rather than committing production renders by default.

The helper runs one processing job per process and limits libvips worker concurrency. Full-canvas buffers, OpenCV WASM, and SVG rasterization can still consume several gigabytes. Start one full-size assembly/render at a time, measure memory, and increase independent-image concurrency only when resources support it. Avoid launching all large render jobs at once simply because generation was parallel.

If copying deliverables to another directory, compare SHA-256 values after copying. Include the report and verification result alongside the user's requested formats. Explain that generated detail is an interpretation and that interpolation is still part of placement.
