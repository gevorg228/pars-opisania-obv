const {
  decodeHtml,
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
} = require("../utils");

function parseDetailHtml(html, base) {
  if (!html || typeof html !== "string") {
    return base;
  }

  const merged = { ...base };

  const priceStr = getMeta(html, "product:price:amount");
  const sellerName = getMeta(html, "vk:seller_name");
  const sellerRating = getMeta(html, "vk:seller_rating");
  const sellerReviewCount = getMeta(html, "vk:seller_review_count");

  if (priceStr) {
    const p = toFloat(priceStr);
    if (p !== null) setIfEmpty(merged, "price", p);
  }

  if (sellerName) {
    setIfEmpty(merged, "account_name", sellerName);
  }

  if (sellerRating) {
    const r = toFloat(sellerRating);
    if (r !== null) setIfEmpty(merged, "rating", r);
  }

  if (sellerReviewCount) {
    const rc = toInt(sellerReviewCount);
    if (rc !== null) setIfEmpty(merged, "reviews_count", rc);
  }

  if (isEmpty(merged.account_url)) {
    const mm = html.match(/data-marker=["']seller-link\/link["'][^>]*href=["']([^"']+)["']/i);
    if (mm && mm[1]) {
      const u = decodeHtml(mm[1]);
      merged.account_url = u.startsWith("http") ? u : "https://www.avito.ru" + u;
    }
  }

  let picked = "";
  const galleryBlock = html.match(/<div[^>]*data-marker=["']item-view\/gallery["'][\s\S]*?<\/ul>/i);
  const galleryHtml = galleryBlock ? galleryBlock[0] : "";

  // Новый код для извлечения изображения из первого элемента слайдера
  if (galleryHtml) {
    const dataUrlMatch = galleryHtml.match(/image-frame__wrapper[^>]*data-url=["']([^"']+)["']/i);
    if (dataUrlMatch && dataUrlMatch[1]) {
      picked = decodeHtml(dataUrlMatch[1]);
    }

    if (!picked) {
      const photoBlock = galleryHtml.match(/<ul[^>]*class=["'][^"']*photo-slider-list[^"']*["'][\s\S]*?<\/ul>/i);
      const blockHtml = photoBlock ? photoBlock[0] : "";
      const firstItemMatch = blockHtml.match(/<li[^>]*class=["'][^"']*photo-slider-list-item[^"']*["'][\s\S]*?<\/li>/i);

      if (firstItemMatch) {
        const firstItemHtml = firstItemMatch[0];
        const imgRe = /<img[^>]*>/gi;
        let imgMatch;
        while (!picked && (imgMatch = imgRe.exec(firstItemHtml)) !== null) {
          const imgHtml = imgMatch[0];
          const srcsetMatch = imgHtml.match(/(?:srcset|data-srcset)=["']([^"']+)["']/i);
          if (srcsetMatch && srcsetMatch[1]) {
            const parts = srcsetMatch[1].split(",").map(p => p.trim()).filter(Boolean);
            if (parts.length) {
              const last = parts[parts.length - 1].split(/\s+/)[0];
              if (last) picked = decodeHtml(last);
            }
          } else {
            const srcMatch = imgHtml.match(/(?:src|data-src)=["']([^"']+)["']/i);
            if (srcMatch && srcMatch[1]) picked = decodeHtml(srcMatch[1]);
          }
        }
      }
    }
  }

  if (!picked) {
    const fallbackImage = galleryHtml.match(
      /image-frame__cover[^>]*style=["'][^"']*background-image:\s*url\(["']?([^"')]+)["']?\)/i
    );
    if (fallbackImage && fallbackImage[1]) {
      picked = decodeHtml(fallbackImage[1]);
    }
  }

  const isAvatarUrl = url =>
    !url ||
    /stub_avatars|avatar|seller-info\/avatar|seller-info-avatar|profile/i.test(url);

  if (!picked) {
    const imgRe = /https?:\/\/\d+\.img\.avito\.st\/[^"'\s)]+/gi;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
      const url = decodeHtml(m[0]);
      if (isAvatarUrl(url)) continue;
      const start = Math.max(0, m.index - 200);
      const end = Math.min(html.length, m.index + 200);
      const ctx = html.slice(start, end);
      if (/seller-info-avatar|seller-info\/avatar|avatarWrapper|avatar/i.test(ctx)) {
        continue;
      }
      picked = url;
      break;
    }
  }

  if (picked && !isAvatarUrl(picked)) merged.preview_image_url = picked;

  setIfEmpty(merged, "views_total", toInt(getMarkerText(html, "item-view/total-views")));
  setIfEmpty(merged, "views_today", toInt(getMarkerText(html, "item-view/today-views")));
  const publishedRaw = getMarkerText(html, "item-view/item-date");
  const publishedParsed = parseRuDateTime(publishedRaw);
  if (publishedParsed) {
    setIfEmpty(merged, "published_at", publishedParsed);
  }

  const descInner =
    getMarkerInnerHtml(html, "item-view/item-description") ||
    getMarkerInnerHtml(html, "item-view/item-description-text");
  if (descInner) {
    setIfEmpty(merged, "description", descInner.trim());
  }

  merged.parsed_at = new Date().toISOString();

  return merged;
}

module.exports = { parseDetailHtml };

