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

module.exports = {
  fetchBatchHtmls
};
