# Portable helper CLI

Requires Node.js 22+ and the dependencies in `package-lock.json`. From the installed skill/repository directory:

```sh
npm ci
node scripts/pipeline.cjs help
```

Paths below are examples relative to the current working directory. Use quoted paths containing spaces. The image editor is controlled by the host agent, not by this CLI; no image-generation service or API key is bundled.

## 1. Prepare

```sh
node scripts/pipeline.cjs prepare "input.png" "jobs/example" --long-edge 7680 --cols 4 --rows 3 --pad 224 --feather 48
```

- `--long-edge`: default 7680. Preserves a source that is already larger.
- `--short-edge`: alternative to `--long-edge`; useful for very wide banners.
- `--cols`, `--rows`: defaults based on aspect ratio, not on the editor's native capacity. Adapt after a pilot.
- `--pad`: extension per side; default 224, so ordinary overlap is 448 pixels.
- `--feather`: initial seam transition in destination pixels; default 48.

Creates `base.png`, `inputs/*.png`, `qa/plan.jpg`, and `manifest.json`. The source file is read only. The job path must be new. Normalization corrects EXIF direction and uses sRGB; helpers support opaque still images. The maximum canvas is 150 megapixels and the maximum grid has 1000 tiles. Large jobs require sufficient memory.

## 2. Optional detail region, before importing any results

```sh
node scripts/pipeline.cjs add-region "jobs/example" face --left 2700 --top 1300 --width 1300 --height 1100 --mask "face-mask.png"
```

Coordinates are on the target canvas. The grayscale mask must be exactly the region's width and height. White keeps the detail patch, black keeps the assembled image; soft edges should be encoded as gray. Alpha is ignored when reading a mask, so supply actual grayscale values rather than an alpha-only mask. Create the mask to match the subject; a rectangle is not a universal portrait mask.

The CLI supports independent detail overlays. It does not implement a specialized removal-mask registration step; use a reviewed clean source for requested removal work.

## 3. Generate with the host image editor, then import

Inspect `jobs/example/inputs/r1c1.png`, edit it with the available image tool, inspect the result, and save the exact prompt to `r1c1-prompt.txt`.

```sh
node scripts/pipeline.cjs ingest "jobs/example" r1c1 "returned-image.png" --prompt-file "r1c1-prompt.txt"
node scripts/pipeline.cjs align "jobs/example" r1c1
```

Import records actual generated dimensions and the prompt. A result is imported only once until reset. `align` writes `aligned/r1c1.png`, `qa/r1c1.jpg` (reference left, aligned result right), and a statistics record. `--registration-width` defaults to 640 and may be lowered for small test fixtures. Review any ECC or transform warnings, the QA sheet, and the actual full-size crop.

```sh
node scripts/pipeline.cjs accept "jobs/example" r1c1 --note "Checked face shape and the hair-to-panel boundary at 100%; no visible double edges."
node scripts/pipeline.cjs status "jobs/example"
```

`accept` records the operator/agent's visual review. It is not a request for additional user authorization and is never an automatic quality score. Do not copy the example note without doing the review.

Repeat for every grid tile and independent detail region.

## Retry or declared fallback

```sh
node scripts/pipeline.cjs reset "jobs/example" r1c1 --reason "Regenerate: eye position drifted."
```

Reset archives that region's result, alignment, QA image and record under `history/`, then returns it to pending. Other regions remain intact. Only the region's assigned owner should reset it. Re-import, align and review the replacement.

If a region is deliberately left at source-based quality:

```sh
node scripts/pipeline.cjs retain "jobs/example" r1c1 --reason "Editor rejected this crop; retain existing content."
node scripts/pipeline.cjs align "jobs/example" r1c1
node scripts/pipeline.cjs accept "jobs/example" r1c1 --note "Source-based fallback reviewed; no generated detail claimed."
```

`retain` copies the prepared crop and performs identity placement. It is not a neural super-resolution model, denoiser, or generative edit. Reports keep it separate from generated regions. Do not use it to silently complete a request for all-region redraws.

## 4. Assemble and verify

```sh
node scripts/pipeline.cjs status "jobs/example"
node scripts/pipeline.cjs assemble "jobs/example" "deliveries/example-v1"
node scripts/pipeline.cjs verify "deliveries/example-v1"
```

Assembly refuses incomplete, unreviewed, or stale jobs. The output directory must be new. It contains:

| File | Purpose |
|---|---|
| `refined.png` | Full-resolution composite |
| `refined.svg` | Standalone SVG with embedded raster layers |
| `preview.jpg` | Small overall preview |
| `seams.jpg` | Overlay of computed seam paths |
| `report.json` | Native sizes, destination scale, prompts, methods, QA and hashes |
| `verification.json` | Full-size SVG render comparison, created by `verify` |

`verify` checks the actual SVG via Sharp/libvips SVG rendering. Default acceptance is mean channel difference ≤0.5/255 and the fraction of channels differing by more than 10/255 ≤0.001. Renderer tolerances can be changed explicitly with `--max-mean-difference` and `--max-outlier-fraction`; investigate a mismatch before loosening them. A failed check exits nonzero and writes the measured report.

No separate SVG renderer or browser is required for this check. Browser/editor appearance should still be inspected when it is a delivery requirement. This comparison checks file consistency, not visual quality or historical accuracy of generated detail.

## Resume and concurrency

Run `status` and act on actual states:

```text
pending -> imported -> aligned -> accepted
                     reset -> pending (previous files archived)
file/geometry/prompt/mask change after alignment -> stale
```

Use one worker per region ID and one final assembler per job. The manifest belongs to the coordinator; plan all detail regions before dispatch. Different IDs use separate record files. This avoids a shared mutable "completed tiles" counter, but does not provide locking against duplicate workers.

Changing canvas size, grid or source requires a new job. Before generation you may set a per-tile `feather` value in the manifest when a particular boundary needs a different transition. Do not change core/region coordinates after crops have been created. The helper records content signatures so old accepted results cannot be reused silently after changes.

## Development checks

```sh
npm run check
npm test
```

Tests use synthetic geometry, not image-generation calls. They exercise complete assembly/rendering, missing work, review gates, stale records, orientation and sizing, affine recovery, seam routing and lossless embedded-image splitting. They do not measure image-generation quality. Windows and Linux CI run the same suite.
