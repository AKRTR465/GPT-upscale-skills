# Canvas admission and resources

The helper has no fixed 256 MP ceiling. It admits each task using dimensions, storage representation, the edit budget and available destination disk space. A passing plan is not an unlimited-size or fixed-memory guarantee.

## Checks retained

- Every actual edit input/destination is at most 1024 pixels per edge, including overlap. Each task has at most 1000 edit blocks including detail children.
- Dimensions are positive safe integers within signed 32-bit image coordinates. Pixel and byte arithmetic must remain exact.
- The custom RGBA8 temporary TIFF uses 32-bit file offsets. Its header plus all pixels must fit within `0xffffffff` bytes. Padded 256×256 TIFF tiles and their metadata must also fit. Larger files require BigTIFF or segmented storage, which this version does not implement. [LibTIFF's format description](https://libtiff.gitlab.io/libtiff/specification/bigtiff.html).
- Full-image reads receive the already validated pixel count explicitly. Only header inspection uses `limitInputPixels: false`; decoding retains explicit limits and other decoder protections. This avoids Sharp's default 268,402,689-pixel limit rejecting a valid larger prepared canvas. [Sharp constructor documentation](https://sharp.pixelplumbing.com/api-constructor/).

## Disk admission

`plan SOURCE --long-edge 37258 --work-dir jobs/example` inspects the nearest existing ancestor of the destination without creating it. The result records the resolved filesystem, available bytes, required bytes and check time. Without `--work-dir`, planning checks geometry and format only and reports `diskCheck.status: "not-requested"`.

Prepare checks the positional JOB destination before creating it. Detail addition checks the added workload before writing a mask or child input. Assembly checks its output filesystem before creating the export directory. Verification checks its comparison-TIFF filesystem before creating temporary files. These checks also run for existing tasks; old stored estimates cannot bypass them.

Estimates account for TIFF padding, raw-equivalent inputs/results/aligned copies, group scratch space, PNG output and SVG base64 output. Each disk check adds 20% plus 256 MiB to the estimated additional bytes. Compression depends on content. Retries, other jobs and changes in free space after the check are not reserved or guaranteed. Disk exhaustion at runtime remains an I/O error; incomplete work must not be delivered as accepted output.

The original image and job may live on different disks from the export. Admission checks each operation's destination rather than assuming the current working directory is the relevant disk. Existing paths and symlinks are resolved before checking filesystem capacity.

## Large-canvas behavior

Normalization writes a tiled TIFF directly to file. Actual crops and SVG nodes remain at most 1024×1024. The compositor reads and writes one region in a file-backed RGBA TIFF at a time, and verification renders bounded SVG windows at 1:1 scale across every pixel. Memory still includes codec buffers, scanlines, native libraries and registration; serial assembly and verification keep competing large jobs from multiplying usage.

For 37258×8640, the planner yields 42×10 = 420 base edits, a largest crop of 1016×992, and 321,909,120 output pixels. One RGBA temporary raster occupies about 1.20 GiB on disk. This number is not the process's peak RSS.

The synthetic acceptance command below runs preparation, actual export, full-pixel PNG/SVG comparison and re-planning the large exported PNG as a new source. It records process high-water memory, stage-end disk measurements and temporary-file peak estimates. It calls no generation model and does not assess redraw quality.

```sh
npm run test:stress -- --dimensions 37258x8640 --work-dir work/stress --report work/322mp-report.json
```

The test requires a single-process peak RSS no greater than 4 GiB. The separate default stress suite retains the four 16K aspect-ratio fixtures. Both run on Windows and Linux for release branches; the measured canvas coverage is not a claim of unbounded format or viewer support. Preview large deliverables using the small preview or selected original-scale crops instead of loading the entire full-resolution file into a chat tool.
