function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMarkerInnerHtml(html, marker) {
  const mk = escapeRegExp(marker);
  const re = new RegExp(
    `<([a-zA-Z0-9]+)[^>]*data-marker=["']${mk}["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    "i"
  );
  const m = html.match(re);
  return m && m[2] ? m[2] : null;
}

function extractDescription(html) {
  if (!html || typeof html !== "string") {
    return null;
  }

  let description = getMarkerInnerHtml(html, "item-view/item-description");
  
  if (!description) {
    description = getMarkerInnerHtml(html, "item-view/item-description-text");
  }

  return description ? description.trim() : null;
}

module.exports = {
  extractDescription
};
