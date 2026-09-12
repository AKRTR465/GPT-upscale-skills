# Operating guide

## Canvas and tile planning

The coordinate base is an oriented, sRGB TIFF resized to the target canvas. It provides a stable reference and fills narrow uncovered edges. It is not evidence of reconstructed detail. The normalization path writes directly to a file rather than first constructing a full-size PNG buffer.

Presets use these long edges: **2K/QHD = 2560, 4K = 3840, 8K = 7680, 16K = 15360**. The default is 8K. The 2K name follows the QHD display convention used by [BenQ](https://www.benq.com/en-us/knowledge-center/knowledge/why-choose-a-27-monitor-for-qhd-1440p-gaming.html); 4K/8K display dimensions are described by [ITU](https://www.itu.int/hub/2020/04/new-itu-reports-help-shape-next-tv-revolution-high-dynamic-range-hdr/), and [VESA](https://vesa.org/press/vesa-publishes-displayport-2-0-video-standard-enabling-support-for-beyond-8k-resolutions-higher-refresh-rates-for-4k-hdr-and-virtual-reality-applications/) describes a 15360×8640 16K configuration. Applying those long edges to arbitrary image aspect ratios is this project's convention, not a universal definition of K. Report exact pixels alongside the preset.

A 2:3 portrait at 8K becomes 5120×7680. A 4.31:1 banner at 7680 pixels wide is only about 1782 pixels high; a request for a 4320-pixel short edge instead requires approximately 18620 pixels of width. Calculate from oriented source dimensions and round once. Preserve a source that is already larger. One job chooses one preset or one custom edge requirement; the CLI does not generate several resolutions automatically or use successive generative passes through each preset.

Run the read-only `plan` command first. It shares its planner with `prepare`, including exact coordinates, maximum crop dimensions and resource checks. The maximum actual edit width and height are each **1024 pixels, including overlap**. `--max-tile-edge` can lower this cap. By default, adjacent tiles overlap by 128 pixels: `pad` extends each core by 64 pixels per side and clips at canvas edges.

For cap `L` and per-side padding `p`, the core limit is `L - 2p`. For each canvas dimension `D`, use one tile if `D <= L`; otherwise use `ceil(D / (L - 2p))` cores. Partition each axis into contiguous integer cores, expand them by `p`, then check every actual crop. The neighbor/seam constraints require padding below half the smallest split-axis core; invalid options fail before a job is created. An unsplit axis needs no overlap with a neighbor. Manual grid overrides must meet the same cap and geometry checks; they are not a way to bypass the limit.

With the default 1024 cap and 128 overlap:

| Preset | 16:9 destination | Grid | Base edit count |
|---|---|---|---|
| 2K/QHD | 2560×1440 | 3×2 | 6 |
| 4K | 3840×2160 | 5×3 | 15 |
| 8K | 7680×4320 | 9×5 | 45 |
| 16K | 15360×8640 | 18×10 | 180 |

These counts exclude independent detail edits and retries. Narrow images, portraits and squares derive their own grids from their actual dimensions. A larger preserved source can require more blocks than the requested preset's example.

For a tile destined for `(Tw, Th)` with actual generated size `(Gw, Gh)`, report placement factors `Tw/Gw` and `Th/Gh`. A 982×992 destination filled by 768×768 generated pixels still needs interpolation and may involve aspect-ratio differences requiring review. The helper guarantees the input/destination cap, not the editor's native output resolution. Save and report actual return dimensions rather than the size requested in a prompt.

Do one representative pilot before dispatching all edits. If the returned size is too small for the desired placement density, create a new plan with a lower cap. Overlap consumes the editor's pixel budget, while too little context can impair object recognition. Choose context-rich semantic crops around eyes, hands, lettering and repeated geometry while keeping each actual editing target within the cap.

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

For a portrait or important object, plan a context-rich region and an independent **grayscale mask** at that region's destination size. White means use the refined region, black means keep the assembled canvas. Use a soft shaped contour; an arbitrary rectangle can introduce a visible border. Register detail edits against the same base as the tiles. The helper applies independent detail layers after grid assembly in manifest order. Inspect expression, gaze, teeth, finger count, boundaries, and continuity with the neck or surrounding objects.

If the region exceeds the edit cap, `add-region` creates a logical parent group and capped child edits such as `face-r1c1`. The original region-sized mask belongs to the parent. Assemble the children within the group's canvas first, then apply that parent mask once. Applying it independently to overlapping children would strengthen the mask incorrectly in the overlap. All children must complete the normal import, alignment and visual review gates. Do not import an entire oversized generated parent instead.

The final SVG exposes that completed region as one logical editable layer, internally stored in capped raster pieces. Child edit IDs, group membership and native generation sizes remain in the report records; they are not separate adjustable SVG overlays after group stitching.

An optional `--context` image is normalized to a reference no larger than 1024 pixels on either edge and stored under `references/`. It can show the whole object or original composition when the editor supports separate references. This image is marked as context, not as the edit target: continue to edit only the supplied capped child crop. Avoid relying on a generated overview as the only structural reference.

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

New manifests retain the requested preset, actual dimensions, layout version, cap, overlap and parent/child relationships. The job limit is 1000 actual edit blocks including detail children; adding a region checks this total. Changing the source, target size or grid requires a new job. Existing legacy jobs are read without rewriting coordinates or silently migrating their layout. Existing artifacts remain processable, but a new import for a legacy region larger than 1024×1024 is rejected; start a newly planned job from the original source.

Use `status` to find unfinished work. Use `reset` for a failed visual result and `retain` for a declared source-based fallback. The assembly gate requires complete grid membership, every region's visual acceptance, and unchanged inputs/results/masks. It checks file hashes again; the existence of an old aligned PNG alone is insufficient.

For partial progress, show the contact sheet or individual QA crops. The helper intentionally has no "ignore missing tiles" final-export option. If a requested batch is incomplete, say which images or regions remain instead of counting a preview as a deliverable.

## Validation and packaging

Use two separate acceptance tracks:

- **Visual:** overall composition, meaningful local improvements, identity and anatomy, seam crossings, no invented text, intentional style/blur, edit-mask edges.
- **Mechanical:** requested versus actual dimensions, edit cap, complete records, generated/retained counts, native generation sizes and placement factors, standalone SVG data, full-pixel SVG/PNG comparison, and copied-file hashes.

The SVG embeds PNGs in individual Inkscape-compatible layer groups. The coordinate base is embedded in tiles no larger than 1024×1024; larger PNG payloads are further subdivided losslessly if required. SVG writing is incremental, with node positions and byte locations recorded for bounded verification. This retains editability at the layer level, not at individual hair-strand or path level. Files may be hundreds of megabytes; publish smaller examples to documentation rather than committing production renders by default.

Assembly uses a disk-backed RGBA canvas, reading and writing one region at a time. A fixed-layout uncompressed TIFF wraps its pixels for file-to-file PNG encoding. This avoids treating a raw pixel stream as if it guaranteed bounded-memory image encoding. Processed buffers are released between regions, and file hashes are read in chunks.

`verify` reads the actual saved SVG nodes and renders bounded windows at one destination pixel per rendered pixel. Every PNG pixel is compared; this is not a downscaled preview test. It preserves the mean-difference and outlier thresholds used by the full-render checker. Synthetic small-image tests compare the windowed method with a complete SVG render. File agreement is separate from artistic quality.

Canvas admission uses safe dimensions, temporary TIFF addressing, the 1000-edit budget and available disk space; there is no fixed megapixel ceiling. The CLI can plan and process canvases beyond 256 MP while retaining capped editing and verification windows. See [resource policy](resources.md). Keep large assembly and verification serial. The release stress suite covers four 16K aspect ratios plus an exact 37258×8640 canvas and checks a 4 GiB single-process peak-memory ceiling. That is an acceptance measurement, not a guarantee for every possible image or runtime.

If copying deliverables to another directory, compare SHA-256 values after copying. Include the report and verification result alongside the user's requested formats. Explain that generated detail is an interpretation and that interpolation is still part of placement.
