# Optional watermark cleanup

This stage runs before the usual enlargement job and is **disabled by default**. An explicit removal request enables it for the indicated image or batch; a per-image preserve instruction overrides the batch choice. Do not infer removal from "高清", "修复", "超分", a detected signature, or the existence of this reference. Keep unrelated scene text, geometric logos used as scenery, decorative symbols and intentional glitch effects unless the user named them as removal targets. Ask only about a genuinely ambiguous target, not to repeat authorization already given.

## Method distilled from the completed image jobs

- Small corner signatures were replaced with a generated continuation of the adjacent painted surface. Only a small mask was composited back; the full generated context crop was not pasted over the original.
- Small white signatures on dark backgrounds used color offsets estimated in the unchanged band outside the mask, followed by feathered compositing. Decoded pixels outside the edit area were compared and required to remain unchanged.
- A large forest promotional logo and corner copyright text needed separate background reconstruction. The lettering was excluded from registration and color matching, and the SVG reference base was also cleaned to prevent residual text from reappearing.

The old jobs used crop-dependent feather widths (for example 14, 24 or 32 pixels). These are observations, not fixed defaults. Older crop sizes are not templates for new work: every new actual cleanup edit, including context, must fit within the current 1024×1024 cap. The new pipeline standardizes a clean-source stage instead of repeating the older mixed cleanup-and-upscale approach.

## Inspect and define the target

1. Normalize orientation and compare in the same opaque sRGB space. Retain the original file and its SHA-256. Removal-only output keeps these oriented dimensions; enlargement comes later.
2. Inspect the whole image, then each suspected overlay at 100%. Locate all strokes, antialiased fringes, shadows and glows. OCR or color selection may suggest a mask but is not sufficient to classify a mark as a removal target.
3. Draw a grayscale placement mask: white fully replaces the mark, black preserves the source, gray blends the transition. The solid white core must cover the lettering and its halos. Put the feather in clean background outside the mark; fading across a letter leaves a ghost. Use the actual mask values, not an alpha-only image interpreted as grayscale.
4. Crop enough unchanged context to identify background structure. Keep actual crop and destination width/height at most 1024. Split larger targets into overlapping edits and retain their common mask/coordinates. Do not shrink an oversized target to bypass the cap.

## Reconstruct, align and composite

Use the host's image editor after viewing the input. Ask it to remove only the named overlay and continue the specific underlying background: panel shading, grass, rocks, water reflections, fabric or other visible material. Preserve framing, perspective, nearby contours and unrelated text. Use a real edit mask when supported; still apply a deterministic placement mask afterward. Use the prompt pattern below and save the exact filled prompt and actual returned dimensions.

Align to unchanged surrounding pixels. Exclude the removal mask and a narrow guard band from **all** affine/flow estimation and color statistics. If the crop already matches closely, identity or a small translation is preferable to unnecessary warping. The ordinary pipeline `align` command does not support this exclusion and must not be used as a cleanup aligner. Use mask-aware host alignment or an adapted, inspected helper. Do not match the removed text back into the new background through optical flow or low-frequency color correction.

Estimate restrained color offsets from a clean band around the mask. Blend the registered crop into the normalized original only through the placement mask:

`clean = original × (1 − mask) + corrected_patch × mask`

For overlapping cleanup edits, stitch their background first and apply the parent placement mask once. Feather according to texture scale and available context; too wide a feather can duplicate lines or restore lettering. Avoid generic blur, a flat-color rectangle, or repeated texture cloning as a substitute for inspecting the actual background. Save a new lossless PNG/TIFF; never overwrite the source or re-encode the entire image as JPEG just to remove a small corner mark.

## Check and enter the upscale job

- Compare decoded original and clean pixels after the same orientation/color normalization. Count any changes where the union placement mask is exactly zero, including the rest of the canvas: `outsideMaskChangedPixels` must be zero. For large images, compare bounded windows rather than loading both entire rasters.
- Inspect the mask interior and boundary for remaining strokes, colored fringe, rectangular shading, smears, repeated texture and broken contours. Check full composition too. A bright-pixel count helped one white-on-dark signature; it is not a universal watermark detector and must not erase legitimate highlights.
- Inspect the final upscale's tiles, base and exported SVG in the cleaned areas. All must derive from the reviewed clean source. A clean top layer over a watermarked base is insufficient; overlaps, transparency, tuning or later layer removal could expose the mark.
- Keep originals, generated patches, masks, prompts, comparisons and hashes in the cleanup records. Distinguish original-file preservation from decoded-pixel locality. These do not prove that the hidden original background has been recovered; the replacement is inferred.

If no confirmed watermark exists, use the unchanged original and record `not-found`; make no generation call. If a cleanup edit fails or is rejected, retain that area and record `partial` with the actual reason. Do not route around safety rejection by changing tools, prompts or crops. A transient service failure can receive a bounded same-request retry. Never label a retained region as removed. The switch does not silently permit partial removal: disclose retained marks when delivering any accompanying completed enlargement.

## Switch and record contract

Off (also the behavior when the flag is omitted):

```sh
node scripts/pipeline.cjs plan "original.png" --preset 8k --watermark-removal off
node scripts/pipeline.cjs prepare "original.png" "jobs/with-marks" --preset 8k --watermark-removal off
```

On: finish the cleanup/assessment first, then pass its exact result as `SOURCE`:

```sh
node scripts/pipeline.cjs plan "cleanup/clean.png" --preset 8k --watermark-removal on --removal-record "cleanup/removal.json"
node scripts/pipeline.cjs prepare "cleanup/clean.png" "jobs/clean-upscale" --preset 8k --watermark-removal on --removal-record "cleanup/removal.json"
```

`plan` remains read-only and neither command invokes an image model. For an initial geometry estimate before cleanup, plan the original without enabling removal; the final plan/prepare must use the reviewed cleanup result and the enabled mode. For `not-found`, pass the original in both commands. Omitted/off mode rejects an attached removal record instead of silently enabling the feature.

Write a UTF-8 JSON record with these fields (fill values from actual artifacts):

```json
{
  "schemaVersion": 1,
  "status": "cleaned",
  "original": { "path": "../original.png", "sha256": "ACTUAL_ORIGINAL_SHA256" },
  "resultSha256": "ACTUAL_CLEAN_RESULT_SHA256",
  "review": {
    "note": "Background and mask boundary reviewed at 100%; no remaining overlay strokes.",
    "outsideMaskChangedPixels": 0
  },
  "edits": [
    {
      "id": "bottom-right-signature",
      "crop": { "left": 500, "top": 300, "width": 400, "height": 250 },
      "mask": "masks/bottom-right.png",
      "outcome": "removed",
      "prompt": "The exact prompt actually submitted to the image tool.",
      "nativeSize": { "width": 1024, "height": 640 }
    }
  ]
}
```

Coordinates refer to the oriented source before upscaling. `original.path` resolves relative to the record file; keep referenced masks/comparisons alongside it. `cleaned` requires at least one removed edit and none retained. `not-found` requires an empty edits array and identical original/result file hashes. `partial` requires at least one edit with `outcome: "retained"` and a nonempty `reason`; list successful edits too. Additional fields such as tool request IDs, failed attempts, mask hashes and comparison paths may be retained.

The helper verifies file hashes, equal oriented dimensions, lossless format for edited results, crop caps, and status consistency. It preserves the whole record in `manifest.watermarkRemoval` and exported `report.json`. The pixel-locality count and visual note are evidence produced by the host cleanup workflow, not recomputed or artistically certified by this provenance check. Changing modes or input sources requires a new job; metadata changes cannot reconstruct erased pixels or safely reuse old accepted tiles.

## Prompt pattern

```text
Input image is the exact edit target, a local crop from an existing image.
Remove ONLY [precisely identified overlay, color, location] inside the supplied
mask/region, including its antialiased edges, shadow and glow. Reconstruct the
continuous [observed material, texture, lighting and perspective] behind it.
Preserve [specific nearby objects, contours and unrelated text], unchanged
border geometry, framing and aspect ratio. Do not zoom, rotate, invent symbols,
add a signature or replace the art style. Return this same crop.
```
