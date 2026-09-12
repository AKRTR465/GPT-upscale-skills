# Portable helper CLI

Requires Node.js 22+ and the dependencies in `package-lock.json`. From the installed skill/repository directory:

```sh
npm ci
node scripts/pipeline.cjs help
```

Paths below are examples relative to the current working directory. Use quoted paths containing spaces. The image editor is controlled by the host agent, not by this CLI; no image-generation service or API key is bundled.

## 1. Plan, then prepare

```sh
node scripts/pipeline.cjs plan "input.png" --preset 8k --max-tile-edge 1024 --overlap 128
node scripts/pipeline.cjs prepare "input.png" "jobs/example" --preset 8k --max-tile-edge 1024 --overlap 128 --feather 48
```

`plan` is read-only: it reports a JSON plan without creating a job, raster base, crops or model calls. It includes the requested preset, oriented source and actual target dimensions, pixel count, grid, base edit count, maximum actual crop (`maxCrop`), overlap and resource checks (`resources`). `prepare` uses the same planner and coordinates.

| Option | Meaning |
|---|---|
| `--preset 2k\|4k\|8k\|16k` | Long edge 2560, 3840, 7680 or 15360 respectively; default `8k` |
| `--long-edge N` | Custom long edge; mutually exclusive with explicit `--preset` and `--short-edge` |
| `--short-edge N` | Custom short edge; useful for banners; mutually exclusive with explicit `--preset` and `--long-edge` |
| `--max-tile-edge N` | Maximum actual edit width and height, including overlap; default 1024, may be lowered but not increased |
| `--overlap N` | Total overlap between adjacent crops; default 128; must be even and less than the cap |
| `--pad N` | Compatibility option for per-side padding, so total overlap is `2 × N`; mutually exclusive with `--overlap` |
| `--cols N`, `--rows N` | Optional manual grid dimensions; the resulting grid must still satisfy cap and seam constraints |
| `--feather N` | Initial seam transition in destination pixels; default 48 |

All options take a value. Multi-tile layouts need overlap of at least 4 pixels, and padding must be below half the smallest core edge on each split axis. Dimensions preserve the original aspect ratio and do not shrink an already larger source. The report shows the actual result, which can exceed the requested preset. One job produces one target resolution; there is no automatic multi-preset generation or export.

For cap `L` and per-side padding `p`, each split axis uses `ceil(D / (L - 2p))` cores; an axis already no larger than `L` uses one core. Actual cropped integer rectangles are checked after expanding by `p` and clipping at the canvas edges. Invalid overlap, undersized manual grids, canvas sizes above 256 megapixels, or more than 1000 actual edit blocks fail before creating the job. Invalid manual grids include a suggested automatic layout; they are not silently changed.

Default examples, assuming a 16:9 source no larger than the target:

| Preset | Actual target | Grid | Base edits |
|---|---|---|---|
| `2k` | 2560×1440 | 3×2 | 6 |
| `4k` | 3840×2160 | 5×3 | 15 |
| `8k` | 7680×4320 | 9×5 | 45 |
| `16k` | 15360×8640 | 18×10 | 180 |

`prepare` creates `base.tiff`, `inputs/*.png`, `qa/plan.jpg`, and `manifest.json`. The source file is read only and the job path must be new. Normalization corrects EXIF direction, uses sRGB and writes directly to file. Helpers support opaque still images. Use the resource estimate to reserve temporary disk space, and run large assembly/verification operations serially.

## 2. Optional detail region, before importing any results

```sh
node scripts/pipeline.cjs add-region "jobs/example" face --left 2700 --top 1300 --width 1300 --height 1100 --mask "face-mask.png" --context "input.png"
```

Coordinates are on the target canvas. The grayscale mask must be exactly the region's width and height. White keeps the detail patch, black keeps the assembled image; soft edges should be encoded as gray. Alpha is ignored when reading a mask, so supply actual grayscale values rather than an alpha-only mask. Create the mask to match the subject; a rectangle is not a universal portrait mask.

An oversized region is a logical group: it is automatically split into capped child edits such as `face-r1c1`, using the job's cap and overlap. The parent retains the full-region mask. Children are assembled within the group before that mask is applied once to the main canvas. Read the exact child IDs from the manifest or `status`; each child needs its own import, alignment and visual acceptance. A small region retains the supplied ID, such as `face`. Added children count toward the job-wide 1000-edit limit.

The exported SVG keeps a completed group as one logical layer made of embedded raster pieces. Child IDs and native sizes remain in `report.json` records with their `groupId`, rather than becoming independently composited SVG layers.

`--context` is optional. It saves an oriented reference thumbnail no larger than 1024×1024 to `references/face-context.png` and records its role separately. When the host supports separate references, supply it as context alongside the actual child crop. It does not replace that crop or permit a larger edit target. The same capped-region mechanism can be used for planned repair overlays.

The CLI does not implement a specialized removal-mask registration step; use a reviewed clean source for requested removal work.

## 3. Generate with the host image editor, then import

Inspect `jobs/example/inputs/r1c1.png`, edit it with the available image tool, inspect the result, and save the exact prompt to `r1c1-prompt.txt`.

```sh
node scripts/pipeline.cjs ingest "jobs/example" r1c1 "returned-image.png" --prompt-file "r1c1-prompt.txt"
node scripts/pipeline.cjs align "jobs/example" r1c1
```

Import checks the prepared input and destination geometry, then records actual generated dimensions and the prompt. The 1024 cap applies to actual input/destination regions; it does not assert what native dimensions the editor returns. Reports distinguish those dimensions and the final placement factors. A result is imported only once until reset. `align` writes `aligned/r1c1.png`, `qa/r1c1.jpg` (reference left, aligned result right), and a statistics record. `--registration-width` defaults to 640 and may be lowered for small test fixtures. Review any ECC or transform warnings, the QA sheet, and the actual full-size crop.

```sh
node scripts/pipeline.cjs accept "jobs/example" r1c1 --note "Checked face shape and the hair-to-panel boundary at 100%; no visible double edges."
node scripts/pipeline.cjs status "jobs/example"
```

`accept` records the operator/agent's visual review. It is not a request for additional user authorization and is never an automatic quality score. Do not copy the example note without doing the review.

Repeat for every grid tile, independent detail region and detail-group child edit.

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
| `verification.json` | Full-pixel SVG/PNG comparison, created by `verify` |

Assembly uses a file-backed RGBA canvas and TIFF-to-PNG encoding, writes the standalone SVG incrementally, and embeds the base in capped raster pieces. It does not keep the whole canvas or SVG string in a JavaScript buffer. Retain sufficient temporary disk space until the command finishes.

`verify` checks the saved SVG via Sharp/libvips SVG rendering. It reads actual embedded nodes and renders bounded windows at 1:1 pixel scale, covering every pixel of the exported PNG. Default acceptance is mean channel difference ≤0.5/255 and the fraction of channels differing by more than 10/255 ≤0.001. Renderer tolerances can be changed explicitly with `--max-mean-difference` and `--max-outlier-fraction`; investigate a mismatch before loosening them. A failed check exits nonzero and writes the measured report. Verification includes file hashes; an index is not a substitute for reading the delivered SVG.

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

Legacy manifests are read without changing their original coordinates or rewriting their format. Existing artifacts remain processable. New imports into legacy regions larger than 1024×1024 are refused: prepare a fresh job from the original source instead. New manifests store the preset, actual geometry, layout version, edit cap, overlap and group relationships.

## Development checks

```sh
npm run check
npm test
```

Tests use synthetic geometry, not image-generation calls. They exercise preset planning, cap/coverage checks, option conflicts, grouped masks, legacy records, complete assembly/rendering, missing work, review gates, stale records, orientation, affine recovery, seam routing and lossless embedded-image splitting. Small fixtures exercise the file-backed path and compare windowed verification with full SVG rendering. Windows and Linux CI run the functional suite.

The separate release stress suite exports and verifies 16K landscape, 4:3, square and portrait fixtures, recording peak memory and temporary disk use. Its single-process peak-memory acceptance threshold is 4 GiB. Synthetic verification measures pipeline behavior, not image-generation quality; the repository's example images remain unchanged historical workflow outputs.

```sh
npm run test:stress
```

Run the stress suite separately from routine development checks. It performs real full-resolution exports and needs the disk space and execution time associated with those canvases.

Pushes to `release/*` branches also run the full stress suite on Windows and Linux. The same suite can be requested with the workflow's `stress` input; JSON acceptance reports are uploaded as CI artifacts.
