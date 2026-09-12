# Prompt patterns

These are editable scaffolds, not exact tool arguments. Replace bracketed content with observations of the actual crop. Store the final filled prompt verbatim in a UTF-8 text file for `ingest`.

Use the actual capped crop from `inputs/` as the edit target. Every target and its destination fit within 1024×1024, including overlap. For a split detail group, edit each child separately; the full-object thumbnail in `references/` is context only. If the host supports separate references, clearly label the capped crop as the target and the overview as composition/style context. Do not ask the editor to output the overview instead of the crop.

## Shared tile instruction

```text
Use case: precise local image edit.
Input image: the edit target, one crop of an existing [illustration/photo].
Reconstruct finer detail within the visible forms while preserving the same
composition and image boundaries. Preserve [identity, palette, medium,
material treatment, intentional grain/softness, important objects].

Keep every object's normalized position, silhouette, pose and overlap order.
Keep partially cropped objects cut off at the same boundary. Preserve the
outer border band's geometry and color closely so neighboring crops can join.
Do not zoom, reframe, rotate, move features, add objects, invent lettering,
change clothing coverage or anatomy, or replace the original art style.
Avoid halos, plastic smoothing and uniformly sharpened background blur.

Visible local content: [precise observations specific to this crop].
Useful improvements: [existing strands, iris contours, fabric seams,
metal engravings, etc., supported by the source].
Return the same crop and aspect ratio with carefully reconstructed detail.
```

## Independent face/object region

```text
Input image is the edit target: a context-rich crop of [subject].
Refine the existing [eyes, lashes, hair, painted contours] while keeping the
same identity, facial proportions, gaze, expression and head angle.
Preserve [specific visible colors and distinguishing features].
Keep the surrounding [hat, neck, hands, objects] in the same positions.
Maintain the source's medium and natural texture. Do not beautify into a
different face, change the mouth or teeth, add anatomy, zoom or reframe.
Return only the same crop with finer resolved detail.
```

## Optional removal edit

```text
Input image is the edit target. Remove only [the exact requested overlay]
inside [specified region/mask]. Reconstruct that area using the surrounding
[background texture and lighting]. Keep all scene objects and other text
unchanged. Preserve crop framing and unchanged edge geometry.
```

Use a real mask when supported, and a local compositing mask afterward. Prompt wording alone is not proof of pixel-local editing. For removal, use the separate cleanup stage described in [the operating guide](workflow.md).

## Examples of useful specificity

- Flat illustration: preserve solid color regions and the existing line weight; do not add thick painted texture.
- Silver hair: refine strands inside each existing hair bundle; do not create new bundles across the silhouette.
- Mechanical surfaces: preserve lens ellipses, straight panel edges and spacing of existing marks; do not invent readable numbers.
- Textured paper: retain paper grain as surface texture; do not confuse it with compression noise.
- Depth-of-field: retain deliberate blur behind the subject; do not make all planes equally sharp.

If the tool supports exact size controls, use only its documented current options. Otherwise request the aspect ratio and desired detail, then record the actual output dimensions. Do not report the requested size as the returned size.
