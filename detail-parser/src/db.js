const { Client } = require("pg");

function createDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL
  });
}

// Создаём таблицу parse_jobs если не существует
async function ensureParseJobsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS parse_jobs (
      id SERIAL PRIMARY KEY,
      account_id INT,
      status VARCHAR(50) DEFAULT 'pending',
      total_items INT DEFAULT 0,
      processed_items INT DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      started_at TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
}

// Добавляем колонку account_id в avito_items если не существует
async function ensureAccountIdColumn(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'avito_items' AND column_name = 'account_id'
      ) THEN
        ALTER TABLE avito_items ADD COLUMN account_id INT;
      END IF;
    END $$
  `);
}

async function getActiveAds(client, accountId) {
  let sql = `
    SELECT avito_item_id, url
    FROM avito_items
    WHERE status = 'active'
      AND url IS NOT NULL
      AND url <> ''
  `;
  const params = [];

  if (accountId) {
    sql += ` AND account_id = $1`;
    params.push(accountId);
  }

  sql += ` ORDER BY avito_item_id ASC`;

  const res = await client.query(sql, params);
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

// --- parse_jobs ---

async function createParseJob(client, accountId) {
  const res = await client.query(
    `INSERT INTO parse_jobs (account_id, status) VALUES ($1, 'pending') RETURNING id`,
    [accountId]
  );
  return res.rows[0].id;
}

async function updateParseJobStatus(client, jobId, status, errorMessage) {
  const fields = [`status = $1`];
  const params = [status, jobId];

  if (status === 'parsing') {
    fields.push(`started_at = NOW()`);
  }
  if (status === 'completed' || status === 'error') {
    fields.push(`completed_at = NOW()`);
  }
  if (errorMessage) {
    fields.push(`error_message = $${params.length + 1}`);
    params.push(errorMessage);
  }

  await client.query(
    `UPDATE parse_jobs SET ${fields.join(', ')} WHERE id = $2`,
    params
  );
}

async function updateParseJobProgress(client, jobId, totalItems, processedItems) {
  await client.query(
    `UPDATE parse_jobs SET total_items = $1, processed_items = $2 WHERE id = $3`,
    [totalItems, processedItems, jobId]
  );
}

async function getParseJob(client, jobId) {
  const res = await client.query(`SELECT * FROM parse_jobs WHERE id = $1`, [jobId]);
  return res.rows[0] || null;
}

module.exports = {
  createDbClient,
  ensureParseJobsTable,
  ensureAccountIdColumn,
  getActiveAds,
  updateDescription,
  createParseJob,
  updateParseJobStatus,
  updateParseJobProgress,
  getParseJob
};
