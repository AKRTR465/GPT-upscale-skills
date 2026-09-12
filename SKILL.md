---
name: tiled-image-refinement
description: Refine an existing illustration or image to a large output canvas using overlapping AI redraws, geometric registration, seam blending, and optional layered SVG. Use for detail-aware 4K/8K enlargement, tiled repainting, or batches of such images. Not for pure vector tracing, pixel-exact restoration, or ordinary resizing.
---

# Tiled Image Refinement

Produce a visually reviewed reconstruction of the supplied image. New fine detail is interpretive. Report output dimensions separately from native dimensions returned by the image editor. A layered SVG contains raster patches; it does not confer unlimited resolution.

## Choose the scope

- Keep the user's aspect ratio, destination, output formats, identity constraints, and existing authorization. Do not add object or watermark removal to an enlargement request.
- Inspect the full image and important crops before writing content-specific prompts. Correct EXIF orientation first. Distinguish intentional blur, grain, brushwork, and flat color from damage.
- For an unspecified "8K" illustration, a reasonable default is a 7680-pixel long edge without reducing an already larger source. State this interpretation. A short-edge requirement is different. Do not silently crop a banner to 16:9.
- Use a generative image editor for reconstruction, preferably the host's built-in image edit tool. Follow its current input and viewing requirements. The bundled scripts do not generate detail and require no API credentials. If no editor is available, prepare the plan and explain the missing capability; do not label resized crops as AI redraws or silently switch to a paid API.
- Use subagents only when authorized by the user or governing instructions. Sequential execution supports the same workflow.

Read [the operating guide](references/workflow.md) for tiling, geometry, masks, and QA decisions. Read [prompt patterns](references/prompts.md) when preparing image edits. Read [the CLI guide](references/cli.md) when using the helpers.

## Execute

1. **Prepare one isolated job per source.** Run `scripts/pipeline.cjs prepare` with an explicit target and grid. It creates the normalized base, overlapping crops, a contact sheet, and a manifest. The base uses interpolation for coordinates and fallback coverage, not as the claimed improvement.
2. **Choose tile density from actual generation capacity.** Twelve tiles are a starting example, not a constant. Generate and inspect a representative tile. Record its returned pixel size. If it is much smaller than its destination, adjust the grid before spending the full batch. Account for overlap and intentional source blur.
3. **Plan semantic detail regions.** Add independent face or important-object regions before dispatch. Choose crops with context and provide a grayscale mask for final placement. No portrait is required when the image has none. Prepare authorized removal edits separately as described in the operating guide.
4. **Generate each crop as an edit.** Keep normalized composition, crop boundaries, identity, pose, garment coverage, palette, and medium. Combine shared invariants with observations specific to that crop. Preserve edge geometry so adjacent tiles can connect. Inspect returned crops before importing them with `ingest`, and save the exact prompt.
5. **Register and review.** `align` performs bounded affine ECC registration, smoothed and limited optical flow, one final remapping of native generated pixels, and low-frequency color correction. Inspect its before/after QA sheet and full-size region. Correlation checks geometry; it is not a quality or authenticity score. Use `accept --note` after visual review; this is the agent recording QA, not a request for user permission.
6. **Track all work explicitly.** `status` exposes pending, imported, aligned, and accepted regions. A failed crop stays pending. For an explicitly chosen conservative fallback, use `retain --reason` and report it separately. Never fabricate a generation record. If a tool rejects an edit, do not try to route around its safety controls.
7. **Assemble.** Require every planned tile and detail region to be accepted with current file hashes. `assemble` computes continuous low-difference seams in the actual overlap, feathers locally, applies masked detail regions, and exports PNG plus standalone layered SVG and previews. Missing or stale work must block a final export.
8. **Validate and deliver.** `verify` rasterizes the actual SVG at full dimensions and compares it with the PNG. Also inspect full composition, faces, hands, long contours, patterned regions, seam crossings, and any edited text at 100%. A matching SVG and PNG can still contain a bad redraw. Save dimensions, native crop sizes, prompts, fallback reasons, alignment statistics, QA notes, and SHA-256 hashes with the artifacts.

## Batch coordination

Use one owner for each image; the coordinator creates the manifest and aggregates results. Workers can generate and align disjoint IDs, writing only their own records. Do not let two workers edit the same region or assemble the same job concurrently. Use a manifest-derived queue, not memory or chat progress counts. When reusing an idle agent, issue a task that actually starts work, then confirm the expected files arrived. Consult `status` before export.

## Delivery language

Say what was reconstructed, the output dimensions, formats, and any retained regions or unfinished QA. Explain that fine detail is generated and SVG layers embed bitmaps. Do not claim native 8K generation, recovered original detail, pure vectors, or verified quality based only on dimensions, file hashes, or correlation. Preserve the input file and unrelated existing deliverables.
