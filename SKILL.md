---
name: tiled-image-refinement
description: Refine an existing illustration or image to 2K, 4K, 8K, 16K, or a custom size using automatically planned AI edit tiles of at most 1024 pixels per edge, geometric registration, seam blending, and layered SVG. Use for detail-aware enlargement, tiled repainting, or batches of such images. Not for pure vector tracing, pixel-exact restoration, or ordinary resizing.
---

# Tiled Image Refinement

Produce a visually reviewed reconstruction of the supplied image. New fine detail is interpretive. Report output dimensions separately from native dimensions returned by the image editor. A layered SVG contains raster patches; it does not confer unlimited resolution.

## Choose the scope

- Keep the user's aspect ratio, destination, output formats, identity constraints, and existing authorization. Do not add object or watermark removal to an enlargement request.
- Inspect the full image and important crops before writing content-specific prompts. Correct EXIF orientation first. Distinguish intentional blur, grain, brushwork, and flat color from damage.
- Presets set the long edge: 2K/QHD = 2560, 4K = 3840, 8K = 7680, 16K = 15360. Default to 8K, preserve the aspect ratio and any already larger source, and report actual dimensions. Custom long-edge and short-edge requests are separate from presets; do not crop a banner to 16:9.
- Every actual edit target, including context padding, must fit within 1024×1024 destination pixels. Use the planner to derive the grid. Extra face/object and repair regions use the same limit and are split into child edits when necessary. A downscaled overview is a separate reference, not a substitute for subdividing an oversized edit target.
- Use a generative image editor for reconstruction, preferably the host's built-in image edit tool. Follow its current input and viewing requirements. The bundled scripts do not generate detail and require no API credentials. If no editor is available, prepare the plan and explain the missing capability; do not label resized crops as AI redraws or silently switch to a paid API.
- Use subagents only when authorized by the user or governing instructions. Sequential execution supports the same workflow.

Read [the operating guide](references/workflow.md) for tiling, geometry, masks, and QA decisions. Read [prompt patterns](references/prompts.md) when preparing image edits. Read [the CLI guide](references/cli.md) when using the helpers.

## Execute

1. **Plan before creating one isolated job per source.** Run `scripts/pipeline.cjs plan SOURCE --preset 8k` (or the requested size). This read-only JSON plan reports actual dimensions, grid, edit count, largest crop, overlap and resource limits. Default adjacent overlap is 128 pixels, equivalent to 64 pixels of padding per side. Check the plan, then run `prepare` with the same options. It creates a normalized TIFF base, crops no larger than the configured cap, a contact sheet, and a manifest. The base uses interpolation for coordinates and fallback coverage, not as the claimed improvement.
2. **Check actual generation capacity.** Generate and inspect a representative tile before dispatching the batch. Record its returned pixel size and placement factors. If it is too small for its destination, plan a new job with a lower `--max-tile-edge`; the cap cannot exceed 1024. Account for overlap, context and intentional source blur. One job targets one resolution; do not automatically chain successively larger generative passes.
3. **Plan semantic detail regions.** Add independent face or important-object regions before dispatch, with a destination-size grayscale mask. Oversized regions form groups of capped child edits; assemble the children first and apply the parent mask once. Use IDs and edit-target/reference roles from the manifest. A context reference must itself fit within 1024×1024. No portrait is required when the image has none. Prepare authorized removal edits separately as described in the operating guide.
4. **Generate each crop as an edit.** Keep normalized composition, crop boundaries, identity, pose, garment coverage, palette, and medium. Combine shared invariants with observations specific to that crop. Preserve edge geometry so adjacent tiles can connect. Inspect returned crops before importing them with `ingest`, and save the exact prompt.
5. **Register and review.** `align` performs bounded affine ECC registration, smoothed and limited optical flow, one final remapping of native generated pixels, and low-frequency color correction. Inspect its before/after QA sheet and full-size region. Correlation checks geometry; it is not a quality or authenticity score. Use `accept --note` after visual review; this is the agent recording QA, not a request for user permission.
6. **Track all work explicitly.** `status` exposes pending, imported, aligned, and accepted regions. A failed crop stays pending. For an explicitly chosen conservative fallback, use `retain --reason` and report it separately. Never fabricate a generation record. If a tool rejects an edit, do not try to route around its safety controls.
7. **Assemble.** Require every planned tile and detail region to be accepted with current file hashes. `assemble` computes continuous low-difference seams in the actual overlap, feathers locally, applies masked detail regions, and exports PNG plus standalone layered SVG and previews. Missing or stale work must block a final export.
8. **Validate and deliver.** `verify` reads the saved SVG and compares its 1:1 regional renders with the PNG across every pixel. This bounds render memory without downscaling the check. Also inspect full composition, faces, hands, long contours, patterned regions, seam crossings, and any edited text at 100%. A matching SVG and PNG can still contain a bad redraw. Save requested preset, actual dimensions, native crop sizes, prompts, fallback reasons, alignment statistics, QA notes, and SHA-256 hashes with the artifacts.

## Batch coordination

Use one owner for each image; the coordinator creates the manifest and aggregates results. Workers can generate and align disjoint IDs, writing only their own records. Do not let two workers edit the same region or assemble the same job concurrently. Use a manifest-derived queue, not memory or chat progress counts. When reusing an idle agent, issue a task that actually starts work, then confirm the expected files arrived. Consult `status` before export.

Keep large-image assembly and verification serial. The helper uses file-backed TIFF/RGBA processing and bounded SVG windows; it still needs substantial temporary disk space. There is no fixed megapixel ceiling. The job limit remains 1000 actual edit blocks, including child edits; dimensions, classic TIFF byte offsets and destination disk capacity must pass resource checks. Use `plan --work-dir DESTINATION` to check disk availability without creating files. Prepare, detail addition, assembly and verification check their actual destination filesystem before writing. Read [resource limits](references/resources.md) for estimates and format boundaries. Preserve old job coordinates and manifests; create a new job when changing the layout or resolution. New imports into an oversized legacy region are rejected rather than silently resized.

## Delivery language

Say what was reconstructed, the output dimensions, formats, and any retained regions or unfinished QA. Explain that fine detail is generated and SVG layers embed bitmaps. Do not claim native 8K generation, recovered original detail, pure vectors, or verified quality based only on dimensions, file hashes, or correlation. Preserve the input file and unrelated existing deliverables.
