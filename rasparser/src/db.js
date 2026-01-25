const { Client } = require("pg");

function createDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL
  });
}

async function getLatestSearchResult(client) {
  const sql = `
    SELECT id, city, issue_link
    FROM search_results
    WHERE issue_link IS NOT NULL AND issue_link <> ''
    ORDER BY id ASC
    LIMIT 1
  `;
  const res = await client.query(sql);
  return res.rows[0] || null;
}

async function getAllSearchResults(client) {
  const sql = `
    SELECT id, city, issue_link
    FROM search_results
    WHERE issue_link IS NOT NULL AND issue_link <> ''
    ORDER BY id ASC
  `;
  const res = await client.query(sql);
  return res.rows;
}

async function upsertAd(client, ad) {
  const preview = ad.preview_image_url || "";
  const selectSql = `
    SELECT id
    FROM ads
    WHERE (avito_id = $1 AND $1 IS NOT NULL)
       OR (url = $2 AND $2 IS NOT NULL)
    ORDER BY id DESC
    LIMIT 1
  `;
  const selectRes = await client.query(selectSql, [ad.avito_id, ad.url]);
  const existingId = selectRes.rows[0] ? selectRes.rows[0].id : null;

  if (existingId) {
    const updateSql = `
      UPDATE ads
      SET title = COALESCE(NULLIF($2, ''), title),
          description = COALESCE(NULLIF($3, ''), description),
          preview_img_url = COALESCE(NULLIF($4, ''), preview_img_url),
          published_at = COALESCE($5, published_at),
          url = COALESCE(NULLIF($6, ''), url),
          account_name = COALESCE(NULLIF($7, ''), account_name),
          account_url = COALESCE(NULLIF($8, ''), account_url),
          city = COALESCE(NULLIF($9, ''), city),
          city_ad = COALESCE(NULLIF($10, ''), city_ad),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `;
    const updateRes = await client.query(updateSql, [
      existingId,
      ad.title,
      ad.description,
      preview,
      ad.published_at,
      ad.url,
      ad.account_name,
      ad.account_url,
      ad.city,
      ad.city
    ]);
    return updateRes.rows[0].id;
  }

  const insertSql = `
    INSERT INTO ads (
      avito_id,
      title,
      description,
      preview_img_url,
      published_at,
      url,
      account_name,
      account_url,
      city,
      city_ad,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
    RETURNING id
  `;
  const insertRes = await client.query(insertSql, [
    ad.avito_id,
    ad.title,
    ad.description,
    preview,
    ad.published_at,
    ad.url,
    ad.account_name,
    ad.account_url,
    ad.city,
    ad.city
  ]);
  return insertRes.rows[0].id;
}

async function insertParseStats(client, stats) {
  const sql = `
    INSERT INTO ad_parse_stats (
      search_result_id,
      ad_id,
      parsed_at,
      position,
      price,
      views_total,
      views_today,
      rating,
      reviews_count
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `;
  await client.query(sql, [
    stats.search_result_id,
    stats.ad_id,
    stats.parsed_at,
    stats.position,
    stats.price,
    stats.views_total,
    stats.views_today,
    stats.rating,
    stats.reviews_count
  ]);
}

module.exports = {
  createDbClient,
  getLatestSearchResult,
  getAllSearchResults,
  upsertAd,
  insertParseStats
};
