const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { createDbClient, getAllSearchResults, upsertAd, insertParseStats } = require("./db");
const { parseListingHtml } = require("./parsers/listing");
const { parseDetailHtml } = require("./parsers/detail");

dotenv.config();

let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
  } catch (err) {
    fetchFn = null;
  }
}

if (!fetchFn) {
  throw new Error("Fetch API is not available. Use Node 18+ or install node-fetch.");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeParserBase(base) {
  return base.replace(/\/+$/, "");
}

function getFallbackBase(base) {
  if (!base) return null;
  if (base.includes("host.docker.internal")) {
    return base.replace("host.docker.internal", "localhost");
  }
  return null;
}

async function withParserFallback(base, task) {
  try {
    return await task(base);
  } catch (error) {
    const fallback = getFallbackBase(base);
    if (!fallback || fallback === base) throw error;
    console.warn(`Parser base ${base} failed, retrying with ${fallback}.`);
    return task(fallback);
  }
}

function buildParserUrl(base, targetUrl) {
  const trimmed = normalizeParserBase(base);
  return `${trimmed}/?url=${encodeURIComponent(targetUrl)}`;
}

async function fetchHtml(baseUrl, targetUrl) {
  return withParserFallback(baseUrl, async activeBase => {
    const url = buildParserUrl(activeBase, targetUrl);
    const res = await fetchFn(url, { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Parser request failed ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    return res.text();
  });
}

async function fetchBatchHtmls(baseUrl, urls) {
  return withParserFallback(baseUrl, async activeBase => {
    const endpoint = normalizeParserBase(activeBase) + "/batch";
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Batch request failed ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }

    const payload = await res.json();
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.results)
        ? payload.results
        : Array.isArray(payload.data)
          ? payload.data
          : [];

    if (!list.length) {
      return urls.map(() => null);
    }

    const byUrl = new Map();
    for (const item of list) {
      if (item && typeof item === "object") {
        const html = item.html || item.data || item.body || null;
        if (item.url && typeof item.url === "string") {
          byUrl.set(item.url, html);
        }
      }
    }

    return urls.map((u, idx) => {
      if (byUrl.has(u)) return byUrl.get(u);
      const item = list[idx];
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.html || item.data || item.body || null;
      }
      return null;
    });
  });
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function run() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const parserBase = normalizeParserBase(
    process.env.PARSER_BASE_URL || "http://localhost:3100"
  );
  const listLimit = Number(process.env.LIST_LIMIT || 50);
  const includeClosed = process.env.INCLUDE_CLOSED === "1";
  const stopAfterListing = process.env.STOP_AFTER_LISTING === "1";
  const detailDelay = Number(process.env.DETAIL_DELAY_MS || 0);
  const batchSize = Number(process.env.BATCH_SIZE || 10);

  const client = createDbClient();
  await client.connect();

  try {
    const searchResults = await getAllSearchResults(client);
    if (!searchResults.length) {
      console.log("Нет search_results с issue_link.");
      return;
    }

    console.log(`Найдено выдач: ${searchResults.length}. Начинаю обработку...`);

    for (let s = 0; s < searchResults.length; s += 1) {
      const sr = searchResults[s];
      const listUrl = buildParserUrl(parserBase, sr.issue_link);
      console.log(`Выдача ${s + 1}/${searchResults.length}: запрашиваю ${listUrl}`);
      const listHtml = await fetchHtml(parserBase, sr.issue_link);
      const listDir = path.join(process.cwd(), "listing-pages");
      fs.mkdirSync(listDir, { recursive: true });
      const listBase = String(sr.id || "sr") + "_" + String(s + 1);
      const listSafe = listBase.replace(/[^\w.-]+/g, "_");
      const listPath = path.join(listDir, listSafe + "_" + Date.now() + ".html");
      fs.writeFileSync(listPath, listHtml, "utf8");
      console.log(`Saved listing HTML: ${listPath}`);
      const parsed = parseListingHtml(listHtml, sr.id, {
        limit: listLimit,
        includeClosed
      });
      const cards = parsed.cards;

      if (!cards.length) {
        console.log(`Выдача ${s + 1}/${searchResults.length}: объявлений не найдено.`);
        console.log(
          `Выдача ${s + 1}/${searchResults.length}: всего карточек ${parsed.stats.total}, ` +
            `без заголовка ${parsed.stats.skipped_no_title}, закрытых ${parsed.stats.skipped_closed}.`
        );
        continue;
      }

      console.log(
        `Выдача ${s + 1}/${searchResults.length}: найдено ${cards.length} карточек. ` +
          `Всего карточек ${parsed.stats.total}, без заголовка ${parsed.stats.skipped_no_title}, ` +
          `закрытых ${parsed.stats.skipped_closed}.`
      );

      if (stopAfterListing) {
        console.log("Остановка после парсинга выдачи по настройке STOP_AFTER_LISTING=1.");
        return;
      }

      const batches = chunkArray(cards, batchSize);
      let processed = 0;

      for (let b = 0; b < batches.length; b += 1) {
        const batch = batches[b];
        const urls = batch.map(card => card.url);
        console.log(
          `Пакет ${b + 1}/${batches.length}: запрашиваю ${urls.length} объявлений`
        );
        const htmls = await fetchBatchHtmls(parserBase, urls);

        for (let i = 0; i < batch.length; i += 1) {
          const card = batch[i];
          const detailHtml = htmls[i];
          processed += 1;
          if (!detailHtml) {
            console.log(`Объявление ${processed}/${cards.length}: пустой HTML, пропускаю`);
            continue;
          }

          console.log(`Объявление ${processed}/${cards.length}: объединяю данные`);
          const merged = parseDetailHtml(detailHtml, card);

          console.log(`Объявление ${processed}/${cards.length}: записываю в БД`);
          const adId = await upsertAd(client, merged);
          await insertParseStats(client, {
            search_result_id: merged.search_result_id,
            ad_id: adId,
            parsed_at: merged.parsed_at,
            position: merged.position,
            price: merged.price,
            views_total: merged.views_total,
            views_today: merged.views_today,
            rating: merged.rating,
            reviews_count: merged.reviews_count
          });

          if (detailDelay > 0) {
            await sleep(detailDelay);
          }
        }
      }
    }

    console.log("Готово: обработка всех выдач завершена.");
  } finally {
    await client.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

