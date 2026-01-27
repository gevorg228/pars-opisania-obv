function decodeHtml(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

function stripTags(s) {
  if (!s) return null;
  const t = decodeHtml(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

function toNumberOrNull(x) {
  if (x === undefined || x === null) return null;
  const n = Number(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractCityFromUrl(url) {
  if (!url) return null;
  const m = url.match(/^https?:\/\/(?:www\.)?avito\.ru\/([^\/?#]+)\//i);
  const slug = m && m[1] ? m[1].toLowerCase() : null;
  return slug || null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isEmpty(v) {
  return v === null || v === undefined || v === "";
}

function setIfEmpty(obj, key, val) {
  if (val === null || val === undefined) return;
  if (isEmpty(obj[key])) obj[key] = val;
}

function toInt(str) {
  if (str == null) return null;
  const n = String(str).replace(/[^\d]/g, "");
  return n ? Number(n) : null;
}

function toFloat(str) {
  if (str == null) return null;
  const n = String(str).replace(",", ".").replace(/[^\d.]/g, "");
  return n ? Number(n) : null;
}

function getMeta(html, key) {
  const reProp = new RegExp(
    `<meta[^>]+property=["']${escapeRegExp(key)}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  let m = html.match(reProp);
  if (m && m[1]) return decodeHtml(m[1]);

  const reName = new RegExp(
    `<meta[^>]+name=["']${escapeRegExp(key)}["'][^>]+content=["']([^"']*)["']`,
    "i"
  );
  m = html.match(reName);
  if (m && m[1]) return decodeHtml(m[1]);

  return null;
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

function htmlToTextKeepLines(innerHtml) {
  if (!innerHtml) return null;

  const withBreaks = innerHtml
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<\/\s*li\s*>/gi, "\n")
    .replace(/<\/\s*div\s*>/gi, "\n");

  const txt = decodeHtml(withBreaks)
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return txt || null;
}

function getMarkerText(html, marker) {
  const inner = getMarkerInnerHtml(html, marker);
  if (!inner) return null;
  return htmlToTextKeepLines(inner);
}

function parseRuDateTime(input, now = new Date()) {
  if (!input) return null;
  let s = String(input)
    .replace(/[•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!s) return null;

  const timeMatch = s.match(/(\d{1,2}):(\d{2})/);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;

  if (s.includes("сегодня")) {
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0
    );
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  if (s.includes("вчера")) {
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      hour,
      minute,
      0,
      0
    );
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }

  const months = {
    "января": 0,
    "янв": 0,
    "февраля": 1,
    "фев": 1,
    "марта": 2,
    "мар": 2,
    "апреля": 3,
    "апр": 3,
    "мая": 4,
    "май": 4,
    "июня": 5,
    "июн": 5,
    "июля": 6,
    "июл": 6,
    "августа": 7,
    "авг": 7,
    "сентября": 8,
    "сен": 8,
    "сент": 8,
    "октября": 9,
    "окт": 9,
    "ноября": 10,
    "ноя": 10,
    "декабря": 11,
    "дек": 11
  };

  const dateMatch = s.match(/(\d{1,2})\s+([а-яё]+)/i);
  if (!dateMatch) return null;
  const day = Number(dateMatch[1]);
  const monthName = dateMatch[2];
  const monthKey = Object.keys(months).find(key => monthName.startsWith(key));
  if (!monthKey) return null;
  const month = months[monthKey];

  const yearMatch = s.match(/(\d{4})\s*г?\.?/);
  let year = yearMatch ? Number(yearMatch[1]) : now.getFullYear();

  let candidate = new Date(year, month, day, hour, minute, 0, 0);
  if (!yearMatch) {
    const tomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      0
    );
    if (candidate > tomorrow) {
      year -= 1;
      candidate = new Date(year, month, day, hour, minute, 0, 0);
    }
  }

  return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : null;
}

module.exports = {
  decodeHtml,
  stripTags,
  toNumberOrNull,
  extractCityFromUrl,
  escapeRegExp,
  isEmpty,
  setIfEmpty,
  toInt,
  toFloat,
  getMeta,
  getMarkerInnerHtml,
  htmlToTextKeepLines,
  getMarkerText,
  parseRuDateTime
};
