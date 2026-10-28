# Rururu character assets

Date: 2026-10-21. Mode: built-in image_gen, two reference-guided generations. The original reference sheet is excluded from public source. No runtime dependency or model-provider call was added to the platform. Exported to WebP quality 90 with lossless alpha; generated PNG originals are retained outside the repository. Captions remain live HTML.

## Portrait prompt

Use case: production transparent character portrait for a team-agent web app. Use the attached sheet only as character identity reference. Create ONE new high-quality studio fleece-plush portrait of the same round buttery pale-yellow little alien, two short antennae with round tips, tiny glossy black bead eyes, a small W-shaped smile, pudgy arms, and its powder/periwinkle-blue circular crossbody pouch with softly quilted concentric arcs and a simple white clasp. Show complete antennae, head, short body and pouch. Front-facing, friendly slight wave, no laptop, no other props. Match the reference's adorable premium tactile plush material and proportions. Single square composition, central 75% of frame, generous transparent margins and full silhouette. GENUINELY TRANSPARENT BACKGROUND, no white rectangle, no painted checkerboard, no frame, no text, no writing, no logo, no heading, no vehicles, no brands. This is a clean production avatar asset.

## Twelve-scene diary prompt

Use case: production transparent twelve-scene character sprite atlas for a developer's work diary in a web app. Use attached sheet as identity reference only. Same buttery pale-yellow plush alien in EVERY scene: round body, two short antennae with round tips, glossy black bead eyes, small W-shaped mouth, pudgy limbs, powder/periwinkle-blue round crossbody pouch with concentric quilted arcs and simple white clasp. Premium soft fleece plush studio look, navy laptops, blue pouch, warm yellow highlights. EXACTLY THREE columns and FOUR rows, overall 3:4 ratio, twelve separate equal square cells. All character parts and props must stay within the central 76% width and height of their own cell, leaving completely transparent outer 12% margins. No overlapping or neighboring scenes, consistent character scale. Row1 left-to-right: ready waving beside open laptop; focused typing at laptop; inspecting a tiny red ladybug with magnifier. Row2: checking a clipboard with ONLY EMPTY CHECKBOXES and pencil, NO green ticks or success symbols; holding a plain code-review paper with simple short navy lines; arms up celebrating beside laptop. Row3: thoughtful question with hand near chin, no question-mark text; writing an open notebook with pencil; asleep waiting on closed laptop. Row4: inspired with small glowing lightbulb; relaxed coffee break holding a white mug; concerned beside laptop and disconnected cable. Keep faces expressive and gentle, complete antennae in every scene. GENUINELY TRANSPARENT background INCLUDING all gutters, no white blocks, no painted checkerboard. No captions, letters, numbers, words, brands, logos, vehicles, grid lines or frames. Production asset only.

## Production files

- `rururu-portrait-v1.webp`: 1254 × 1254 RGBA, one portrait.
- `rururu-diary-v1.webp`: 1086 × 1448 RGBA, twelve scenes.
- Measured CSS viewports in `src/plush-sprites.js` and `src/work-diary.js` isolate artwork without repainting or distorting the bitmap. Existing portraits, saved choices and the otter diary remain available.
- The checklist is unchecked. Only current Task/Run/artifact records select an execution state; the illustration never proves that a test passed.
