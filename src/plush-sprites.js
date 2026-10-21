// Measured viewports prevent neighboring art from bleeding out of atlas cells.
// The source bitmaps stay untouched; each view is fitted without distortion.
export const portraitRects = {
  cloud: [12, 32, 365, 365],
  fennec: [412, 24, 405, 373],
  otter: [832, 64, 400, 333],
  turtle: [1235, 70, 386, 327],
  capybara: [1634, 65, 349, 332],
  corgi: [16, 412, 374, 371],
  penguin: [396, 407, 405, 376],
  hedgehog: [817, 427, 407, 356],
  fox: [1240, 419, 371, 364],
  rabbit: [1638, 408, 345, 375],
};

export function atlasViewport(
  [x, y, width, height],
  [atlasWidth, atlasHeight],
) {
  const scale = Math.max(width, height);
  return `<span class="g-atlas-sprite" style="width:${(width / scale) * 100}%;height:${(height / scale) * 100}%;background-size:${(atlasWidth / width) * 100}% ${(atlasHeight / height) * 100}%;background-position:${(x / (atlasWidth - width)) * 100}% ${(y / (atlasHeight - height)) * 100}%"></span>`;
}

export function characterIllustration(character) {
  if (character.id === "rururu")
    return `<span class="g-character-portrait" data-portrait-character="rururu">${atlasViewport([90, 65, 1030, 1120], [1254, 1254])}</span>`;
  const rect = Object.hasOwn(portraitRects, character.id)
    ? portraitRects[character.id]
    : portraitRects.fox;
  return `<span class="g-character-portrait">${atlasViewport(rect, [1983, 793])}</span>`;
}
