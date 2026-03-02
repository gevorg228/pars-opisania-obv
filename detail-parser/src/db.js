const { Client } = require("pg");

function createDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL
  });
}

async function getActiveAds(client) {
  const sql = `
    SELECT avito_item_id, url
    FROM avito_items
    WHERE status = 'active'
      AND url IS NOT NULL
      AND url <> ''
    ORDER BY avito_item_id ASC
  `;
  const res = await client.query(sql);
  return res.rows;
}

async function updateDescription(client, avitoItemId, description) {
  const sql = `
    UPDATE avito_items
    SET description = $1,
        updated_at = NOW()
    WHERE avito_item_id = $2
  `;
  await client.query(sql, [description, avitoItemId]);
}

module.exports = {
  createDbClient,
  getActiveAds,
  updateDescription
};
