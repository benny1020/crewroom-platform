import { icons } from "lucide";

export const palette = {
  service: { ink: "#5855ad", fill: "#f4f3fc", border: "#cfceeb" },
  data: { ink: "#267d69", fill: "#eff8f4", border: "#c5e1d6" },
  external: { ink: "#3576a8", fill: "#f0f6fc", border: "#cbdeed" },
  job: { ink: "#a96b21", fill: "#fff7e9", border: "#ead6b3" },
  neutral: { ink: "#586579", fill: "#f7f8fb", border: "#d8dfe8" },
};
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const attributes = (value) =>
  Object.entries(value)
    .map(([key, content]) => `${key}="${escape(content)}"`)
    .join(" ");
const text = (value, x, y, size = 20, options = {}) =>
  `<text ${attributes({ x, y, "font-size": size, ...options })}>${escape(value)}</text>`;
const rectangle = (
  x,
  y,
  width,
  height,
  fill,
  stroke,
  radius = 10,
  extra = {},
) =>
  `<rect ${attributes({ x, y, width, height, rx: radius, fill, stroke, ...extra })}/>`;
const icon = (name, x, y, size, color) => {
  if (!icons[name]) throw new Error("Unknown Lucide icon: " + name);
  return `<g data-icon="${escape(name)}" transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name].map(([tag, attrs]) => `<${tag} ${attributes(attrs)}/>`).join("")}</g>`;
};

function group(item) {
  const color = palette[item.color || "neutral"];
  return (
    rectangle(item.x, item.y, item.w, item.h, color.fill, color.border, 14, {
      "stroke-dasharray": item.dashed ? "6 5" : "none",
    }) +
    icon(item.icon || "Layers", item.x + 20, item.y + 19, 24, color.ink) +
    text(item.title, item.x + 56, item.y + 39, 22, {
      "font-weight": 650,
      fill: color.ink,
    }) +
    (item.note
      ? text(item.note, item.x + 20, item.y + 65, 17, { fill: "#657287" })
      : "")
  );
}

function node(item) {
  const color = palette[item.color || "service"],
    { x, y, w, h } = item;
  let content = rectangle(x, y, w, h, "#ffffff", color.border, 9, {
    "stroke-width": 1.4,
  });
  if (item.mini) {
    content +=
      icon(item.icon, x + w / 2 - 15, y + 17, 30, color.ink) +
      text(item.title, x + w / 2, y + 77, 20, {
        "font-weight": 650,
        "text-anchor": "middle",
      });
  } else {
    content +=
      icon(item.icon, x + 18, y + 20, 30, color.ink) +
      text(item.title, x + 62, y + 42, item.titleSize || 22, {
        "font-weight": 650,
      });
    if (item.tech)
      content += text(item.tech, x + 20, y + 69, 16, { fill: "#778296" });
    (item.lines || []).forEach((line, index) => {
      content += text(
        line,
        x + 20,
        y + (item.tech ? 99 : 82) + index * 27,
        20,
        { fill: "#4b586d" },
      );
    });
    if (item.step)
      content +=
        `<circle cx="${x + w - 23}" cy="${y + 22}" r="13" fill="${color.ink}"/>` +
        text(item.step, x + w - 23, y + 28, 16, {
          fill: "#fff",
          "text-anchor": "middle",
          "font-weight": 650,
        });
  }
  return `<g data-node="${escape(item.id)}" data-bounds="${[x, y, w, h].join(" ")}">${content}</g>`;
}

function edge(item) {
  const color = item.color ? palette[item.color].ink : "#8996a9",
    points = item.points.map((point) => point.join(",")).join(" ");
  let content = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" ${item.dashed ? 'stroke-dasharray="6 5"' : ""} ${item.arrow === false ? "" : 'marker-end="url(#arrow-' + (item.color || "default") + ')"'}/>`;
  if (item.label) {
    const label = item.label,
      size = label.size || 17,
      width = [...label.text].reduce(
        (sum, character) =>
          sum + (character.charCodeAt(0) > 0x2e80 ? size : size * 0.55),
        14,
      );
    content +=
      rectangle(
        label.x - width / 2,
        label.y - size + 1,
        width,
        size + 8,
        "#ffffff",
        "none",
        4,
      ) +
      text(label.text, label.x, label.y, size, {
        "text-anchor": "middle",
        fill: "#617087",
      });
  }
  return content;
}

export function drawIllustration(spec, license) {
  const { width, height } = spec;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="#29364b" role="img" aria-labelledby="diagram-title diagram-description"><title id="diagram-title">${escape(spec.title)}</title><desc id="diagram-description">${escape(spec.subtitle)}</desc><metadata>${escape(license)}</metadata><defs>`;
  for (const [id, color] of [
    ["default", "#8996a9"],
    ...Object.entries(palette).map(([name, value]) => [name, value.ink]),
  ]) {
    svg += `<marker id="arrow-${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/></marker>`;
  }
  svg +=
    `</defs><style>text{font-family:"Apple SD Gothic Neo","Noto Sans KR",Arial,sans-serif}svg{background:#fff}</style>` +
    rectangle(0, 0, width, height, "#ffffff", "none", 0) +
    text(spec.title, 40, 53, 32, { "font-weight": 720 }) +
    text(spec.subtitle, 40, 87, 20, { fill: "#718095" });
  svg += (spec.groups || []).map(group).join("");
  svg += (spec.edges || []).map(edge).join("");
  svg += spec.nodes.map(node).join("");
  for (const note of spec.notes || []) {
    const color = palette[note.color || "neutral"];
    svg +=
      rectangle(note.x, note.y, note.w, note.h, color.fill, color.border, 8) +
      icon(note.icon || "Info", note.x + 18, note.y + 18, 24, color.ink);
    note.lines.forEach((line, index) => {
      svg += text(
        line,
        note.x + 56,
        note.y + 38 + index * 27,
        note.size || 20,
        { fill: color.ink },
      );
    });
  }
  let left = 40;
  for (const item of spec.legend || []) {
    svg +=
      rectangle(left, height - 43, 13, 13, palette[item.color].ink, "none", 3) +
      text(item.label, left + 23, height - 31, 17, { fill: "#718095" });
    left += item.space || 225;
  }
  if (spec.footer)
    svg += text(spec.footer, width - 40, height - 31, 17, {
      "text-anchor": "end",
      fill: "#718095",
    });
  return svg + "</svg>\n";
}
