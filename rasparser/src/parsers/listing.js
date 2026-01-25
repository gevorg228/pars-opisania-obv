const {
  decodeHtml,
  stripTags,
  toNumberOrNull,
  extractCityFromUrl,
  getMarkerText
} = require("../utils");

function isClosedCard(cardHtml) {
  const t = stripTags(cardHtml) || "";

  if (/снято\s+с\s+публикац/i.test(t)) return true;
  if (/объявление\s+снято/i.test(t)) return true;
  if (/объявление\s+закрыто/i.test(t)) return true;
  if (/объявление\s+завершено/i.test(t)) return true;
  if (/в\s+архив/i.test(t)) return true;
  if (/не\s+актуальн/i.test(t)) return true;

  if (/data-marker=["']item-status/i.test(cardHtml)) return true;

  return false;
}

function extractPriceFromCard(card) {
  let m = card.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
  if (m && m[1]) {
    const n = toNumberOrNull(m[1]);
    if (n !== null) return n;
  }

  m = card.match(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i);
  if (m && m[1]) {
    const n = toNumberOrNull(m[1]);
    if (n !== null) return n;
  }

  m = card.match(/(\d[\d\s]{2,})\s*₽/);
  if (m && m[1]) {
    const n = toNumberOrNull(m[1]);
    if (n !== null) return n;
  }

  return null;
}

function extractPreviewImgFromCard(card) {
  const linkMatch = card.match(
    /<a[^>]*data-marker=["']item-photo-sliderLink["'][\s\S]*?<\/a>/i
  );
  const linkHtml = linkMatch ? linkMatch[0] : "";
  if (!linkHtml) return null;

  const listMatch = linkHtml.match(
    /<ul[^>]*class=["'][^"']*photo-slider-list[^"']*["'][\s\S]*?<\/ul>/i
  );
  const listHtml = listMatch ? listMatch[0] : "";
  if (!listHtml) return null;

  const firstItemMatch = listHtml.match(/<li[^>]*>[\s\S]*?<\/li>/i);
  const firstItemHtml = firstItemMatch ? firstItemMatch[0] : "";
  if (!firstItemHtml) return null;

  const srcsetMatch = firstItemHtml.match(/<img[^>]+srcset=["']([^"']+)["']/i);
  if (!srcsetMatch || !srcsetMatch[1]) return null;

  const parts = srcsetMatch[1].split(",").map(p => p.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1].split(/\s+/)[0] : "";
  if (!last) return null;

  let u = decodeHtml(last);
  if (u && u.startsWith("//")) u = "https:" + u;
  if (u && u.startsWith("/")) u = "https://www.avito.ru" + u;
  return /^https?:\/\//i.test(u) ? u : null;
}

function extractCityFromCard(card, url) {
  const text = getMarkerText(card, "item-location");
  if (text) {
    const line = text
      .split("\n")
      .map(t => t.trim())
      .filter(Boolean)[0];
    if (line) return line;
  }
  return extractCityFromUrl(url);
}

function parseListingHtml(html, searchResultId, options) {
  if (!html || typeof html !== "string") {
    return { cards: [], stats: { total: 0, skipped_no_title: 0, skipped_closed: 0 } };
  }

  const limit = options && typeof options.limit === "number" ? options.limit : undefined;
  const includeClosed = options && options.includeClosed === true;

  const serpMatch = html.match(/data-marker=["']catalog-serp["'][\s\S]*?<\/main>/i);
  const serpHtml = serpMatch ? serpMatch[0] : html;

  const cards = [];
  const stats = {
    total: 0,
    skipped_no_title: 0,
    skipped_closed: 0,
    missing_card: 0,
    item_id_total: 0,
    missing_by_item_id: 0
  };
  const cardRe = /data-marker=["']item["'][\s\S]*?(?=data-marker=["']item["']|<\/main>)/gi;
  const byUrl = new Map();
  const byId = new Map();
  const titleList = [];
  const positionByUrl = new Map();

  const itemTitleRe =
    /data-marker=["']item-title["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m0;
  while ((m0 = itemTitleRe.exec(serpHtml)) !== null) {
    stats.total += 1;
    const href = decodeHtml(m0[1]);
    const title = stripTags(m0[2]);
    const url = href.startsWith("http") ? href : `https://www.avito.ru${href}`;
    const position = titleList.length + 1;
    titleList.push({ url, title, index: m0.index, position });
    positionByUrl.set(url, position);
  }

  let m;
  while ((m = cardRe.exec(serpHtml)) !== null) {
    const card = m[0];
    const tm = card.match(
      /data-marker=["']item-title["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
    );
    if (!tm) {
      stats.skipped_no_title += 1;
      continue;
    }
    if (!includeClosed && isClosedCard(card)) {
      stats.skipped_closed += 1;
      continue;
    }

    const href = decodeHtml(tm[1]);
    const title = stripTags(tm[2]);
    const url = href.startsWith("http") ? href : `https://www.avito.ru${href}`;

    const idMatch = url.match(/_(\d+)(?:\/)?(?:\?|$)/);
    const avito_id = idMatch ? toNumberOrNull(idMatch[1]) : null;
    const position = positionByUrl.has(url) ? positionByUrl.get(url) : cards.length + 1;

    const preview = extractPreviewImgFromCard(card);
    const cardObj = {
      search_result_id: Number(searchResultId),
      avito_id,
      title,
      description: null,
      preview_image_url: preview,
      published_at: null,
      url,
      account_name: null,
      account_url: null,
      city: extractCityFromCard(card, url),
      parsed_at: new Date().toISOString(),
      position,
      price: extractPriceFromCard(card),
      views_total: null,
      views_today: null,
      rating: null,
      reviews_count: null,
      _card_html: card
    };
    cards.push(cardObj);
    byUrl.set(url, cardObj);
    if (avito_id !== null) {
      byId.set(avito_id, cardObj);
    }

  }

  for (let i = 0; i < titleList.length; i += 1) {
    const entry = titleList[i];
    const url = entry.url;
    const title = entry.title;
    if (byUrl.has(url)) continue;

    const start = Math.max(0, entry.index - 2000);
    const end = Math.min(serpHtml.length, entry.index + 2000);
    const snippet = serpHtml.slice(start, end);
    const idMatch = url.match(/_(\d+)(?:\/)?(?:\?|$)/);
    const avito_id = idMatch ? toNumberOrNull(idMatch[1]) : null;
    const position = entry.position;

    if (!includeClosed && isClosedCard(snippet)) {
      stats.skipped_closed += 1;
      continue;
    }

    const preview = extractPreviewImgFromCard(snippet);
    const fallback = {
      search_result_id: Number(searchResultId),
      avito_id,
      title,
      description: null,
      preview_image_url: preview,
      published_at: null,
      url,
      account_name: null,
      account_url: null,
      city: extractCityFromCard(snippet, url),
      parsed_at: new Date().toISOString(),
      position,
      price: extractPriceFromCard(snippet),
      views_total: null,
      views_today: null,
      rating: null,
      reviews_count: null,
      _card_html: snippet
    };

    stats.missing_card += 1;
    cards.push(fallback);
    byUrl.set(url, fallback);
    if (avito_id !== null) {
      byId.set(avito_id, fallback);
    }

  }

  const itemIdRe = /data-item-id=["'](\d+)["']/gi;
  let m3;
  while ((m3 = itemIdRe.exec(serpHtml)) !== null) {
    stats.item_id_total += 1;
    const itemId = toNumberOrNull(m3[1]);
    if (itemId === null || byId.has(itemId)) continue;

    const start = Math.max(0, m3.index - 3000);
    const end = Math.min(serpHtml.length, m3.index + 3000);
    const snippet = serpHtml.slice(start, end);

    let linkMatch = snippet.match(new RegExp(`href=["']([^"']*_${itemId}[^"']*)["']`, "i"));
    if (!linkMatch) {
      linkMatch = snippet.match(/href=["']([^"']*?_\d+[^"']*)["']/i);
    }
    if (!linkMatch || !linkMatch[1]) continue;

    let url = decodeHtml(linkMatch[1]);
    url = url.startsWith("http") ? url : `https://www.avito.ru${url}`;
    if (byUrl.has(url)) continue;

    let title = null;
    const tm = snippet.match(
      /data-marker=["']item-title["'][^>]*href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>/i
    );
    if (tm && tm[1]) {
      title = stripTags(tm[1]);
    } else {
      const t2 = snippet.match(/title=["']([^"']+)["']/i);
      if (t2 && t2[1]) {
        title = decodeHtml(t2[1]).trim();
      }
    }

    if (!includeClosed && isClosedCard(snippet)) {
      stats.skipped_closed += 1;
      continue;
    }

    const preview = extractPreviewImgFromCard(snippet);
    const fallback = {
      search_result_id: Number(searchResultId),
      avito_id: itemId,
      title,
      description: null,
      preview_image_url: preview,
      published_at: null,
      url,
      account_name: null,
      account_url: null,
      city: extractCityFromCard(snippet, url),
      parsed_at: new Date().toISOString(),
      position: cards.length + 1,
      price: extractPriceFromCard(snippet),
      views_total: null,
      views_today: null,
      rating: null,
      reviews_count: null,
      _card_html: snippet
    };

    stats.missing_by_item_id += 1;
    cards.push(fallback);
    byUrl.set(url, fallback);
    byId.set(itemId, fallback);

  }

  if (!cards.length) return { cards: [], stats };

  if (typeof limit === "number" && limit > 0) {
    return { cards: cards.slice(0, limit), stats };
  }

  return { cards, stats };
}

module.exports = { parseListingHtml };
