# Plush character asset prompts

Date: 2026-10-21
Mode: built-in image_gen (not CLI/API fallback).

The supplied reference sheets guided the soft fleece texture, cream/navy/teal palette and animal identities. Their original files are not included in this repository. Missing specialist portraits were generated in the same family. Captions are live HTML, not part of the bitmaps. No brand names, cars, logos or reference-sheet headings are included in the production images.

## Initial portrait specification

Create a transparent ten-character portrait atlas in five columns and two rows. Top row: cream/mint cloud friend, cream/navy fennec, cream/navy otter, cream/mint turtle, sandy capybara with teal headset. Bottom row: corgi with navy cap, penguin, hedgehog with teal scarf, orange fox with teal scarf, cream rabbit with lavender accent. Use a consistent premium fleece-plush studio style, friendly glossy eyes, blush, readable small heads and upper torsos. No lettering, logos, frames, vehicles or background.

## Final portrait refinement prompt

Use case: stylized-concept, production sprite-atlas spacing refinement.
Edit target: attached plush character atlas. Preserve the ten identities, order, materials, colors, expressions and consistent head proportions.
Make one targeted layout correction: give EVERY character generous fully transparent gutters inside its own equal square cell. Exactly 5 columns by 2 rows, overall 5:2 aspect ratio. Character including ears, tail and clothes must fit within the central 72% of its cell width and height, never within the outer 14% margins. No neighbor may enter another cell. Each character is independently centered. Keep the complete ears and visible upper torso, do not crop the forehead or feet inconsistently.
Top row left to right: cream mint cloud friend, cream fennec navy ear tips, cream otter navy ears striped tail, cream mint turtle, sandy capybara teal headset.
Bottom row: corgi navy cap, navy penguin, cream hedgehog teal scarf, orange fox teal scarf, cream rabbit lavender.
Premium soft fleece plush photography, clean detailed edges, simple glossy black eyes and blush. GENUINELY TRANSPARENT background, including gutters. No colored edge residue, no white blocks, no artifacts, no checkerboard painted into image. No text, grid lines, logos, frames, props, vehicles or decoration in the gutters. Production asset only.

## Initial diary specification

Create a transparent twelve-scene developer diary of the same cream/navy plush otter, arranged in three columns and four rows: ready, typing, investigating; testing with an unchecked checklist, review, celebrating; question, writing, waiting; idea, coffee pause, blocked connection. Keep the character and material consistent. No text, branding, cars or vehicles. Do not bake a test-pass assertion into the checklist.

## Final diary refinement prompt

Use case: stylized-concept, production sprite-atlas spacing refinement.
Edit target: attached twelve-scene plush otter developer atlas. Preserve character identity, navy ears, cream fleece, striped tail, warm facial expressions, props, all twelve poses and their row order.
Make one targeted layout correction: add generous transparent gutters around every scene. Exactly 3 columns by 4 rows of equal square cells, overall 3:4 aspect ratio. All character parts and props must fit within central 72% width and height of their own cell, leaving outer 14% of each cell completely transparent. Uniform apparent scale, centered composition, no scene crosses a cell boundary.
Row 1: ready waving beside laptop; focused laptop typing; magnifier with tiny red ladybug.
Row 2: plain checklist and pencil with NO green checks; holding review paper; raised arms celebrating beside laptop.
Row 3: thinking/question; writing open notebook; eyes closed waiting on closed laptop.
Row 4: idea lightbulb; coffee pause; concerned disconnected cable beside laptop.
Premium soft plush studio photography, cream navy teal warm yellow, simple eyes, clean detailed edges. GENUINELY TRANSPARENT background and gutters. No colored residues, white blocks, artifacts or painted checkerboard. No writing, captions, letters, numbers, logos, grid lines, frames, companies, cars or vehicles. Production asset only.

## Production use

- `plush-crew-v2.webp`: 1983 x 793 RGBA, ten portraits.
- `developer-diary-v1.webp`: 1086 x 1448 RGBA, twelve scenes.
- Lossy WebP at quality 90 with lossless alpha export; original PNGs retained outside the public source.
- Generated spacing is not a mathematically exact grid. The UI uses measured CSS viewports from `src/plush-sprites.js` and `src/work-diary.js` to isolate each scene, preserve aspect ratio and prevent neighboring artwork from bleeding into the view. The bitmap is not repainted by code.
- Existing stored IDs `owl`, `red-panda`, `cat` map to `cloud`, `fennec`, `otter` without changing the saved record.

