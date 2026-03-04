const dotenv = require("dotenv");
const {
  createDbClient,
  ensureParseJobsTable,
  ensureAccountIdColumn,
  getActiveAds,
  updateDescription,
  updateParseJobStatus,
  updateParseJobProgress,
} = require("./db");
const { fetchBatchHtmls } = require("./fetcher");
const { extractDescription } = require("./parser");

dotenv.config({ path: require("path").resolve(__dirname, "../.env") });

// Получаем fetch
let fetch = global.fetch;
if (!fetch) {
  try {
    fetch = require("node-fetch");
  } catch (err) {
    fetch = null;
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForParser(parserBase, maxRetries = 30) {
  console.log("Ожидание запуска Puppeteer сервера...");

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(
        parserBase.replace(/\/$/, "") + "/?url=about:blank"
      );
      if (response.ok || response.status === 400) {
        console.log("✓ Puppeteer сервер готов!\n");
        return true;
      }
    } catch (error) {
      // Сервер еще не запущен
    }

    process.stdout.write(`\r  ⏱  Попытка ${i + 1}/${maxRetries}... `);
    await sleep(1000);
  }

  throw new Error("Puppeteer сервер не запустился за отведенное время");
}

// Парсим CLI аргументы
function parseCliArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

async function runParsing(options = {}) {
  const { accountId = null, jobId = null } = options;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const parserBase = process.env.PARSER_BASE_URL || "http://localhost:3300";
  const batchSize = Number(process.env.BATCH_SIZE || 3);
  const batchDelay = Number(process.env.BATCH_DELAY_MS || 2000);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("Detail Parser - Получение описаний объявлений из БД");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`База данных: ${databaseUrl.replace(/\/\/[^@]+@/, "//***@")}`);
  console.log(`Puppeteer парсер: ${parserBase}`);
  console.log(`Размер батча: ${batchSize}`);
  console.log(`Задержка между батчами: ${batchDelay}ms`);
  if (accountId) console.log(`Account ID: ${accountId}`);
  if (jobId) console.log(`Job ID: ${jobId}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Ждем пока Puppeteer запустится
  await waitForParser(parserBase);

  const client = createDbClient();
  await client.connect();
  console.log("✓ Подключено к БД\n");

  // Убеждаемся что таблицы существуют
  await ensureParseJobsTable(client);
  await ensureAccountIdColumn(client);

  // Засекаем время старта
  const startTime = Date.now();

  try {
    // Обновляем статус job если он есть
    if (jobId) {
      await updateParseJobStatus(client, jobId, "parsing");
    }

    console.log("Получаю список активных объявлений...");
    const ads = await getActiveAds(client, accountId);

    if (!ads.length) {
      console.log("✓ Нет активных объявлений для обработки");
      if (jobId) {
        await updateParseJobProgress(client, jobId, 0, 0);
        await updateParseJobStatus(client, jobId, "completed");
      }
      return;
    }

    console.log(`✓ Найдено объявлений: ${ads.length}\n`);

    // Записываем total в job
    if (jobId) {
      await updateParseJobProgress(client, jobId, ads.length, 0);
    }

    const batches = chunkArray(ads, batchSize);
    console.log(`Будет обработано ${batches.length} батч(ей)\n`);

    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const urls = batch.map((ad) => ad.url);

      console.log(`\n[${"=".repeat(60)}]`);
      console.log(
        `Батч ${b + 1}/${batches.length}: обработка ${urls.length} объявлений`
      );
      console.log(`[${"=".repeat(60)}]\n`);

      try {
        console.log(`  → Запрос HTML для ${urls.length} URL...`);
        const htmls = await fetchBatchHtmls(parserBase, urls);
        console.log(`  ✓ Получено ответов: ${htmls.length}\n`);

        for (let i = 0; i < batch.length; i++) {
          const ad = batch[i];
          const html = htmls[i];
          totalProcessed++;

          console.log(`  [${totalProcessed}/${ads.length}] ID: ${ad.avito_item_id}`);
          console.log(`    URL: ${ad.url}`);

          if (!html) {
            console.log(`    ✗ Пустой HTML, пропускаю\n`);
            totalSkipped++;
            continue;
          }

          try {
            const description = extractDescription(html);

            if (!description) {
              console.log(`    ✗ Описание не найдено, пропускаю\n`);
              totalSkipped++;
              continue;
            }

            console.log(
              `    ✓ Найдено описание (${description.length} символов)`
            );

            await updateDescription(client, ad.avito_item_id, description);
            console.log(`    ✓ Описание обновлено в БД\n`);
            totalUpdated++;
          } catch (error) {
            console.error(`    ✗ Ошибка при обработке: ${error.message}\n`);
            totalErrors++;
          }
        }

        // Обновляем прогресс в job
        if (jobId) {
          await updateParseJobProgress(client, jobId, ads.length, totalProcessed);
        }
      } catch (error) {
        console.error(
          `\n✗ Ошибка при обработке батча ${b + 1}: ${error.message}\n`
        );
        totalErrors += batch.length;
      }

      if (batchDelay > 0 && b < batches.length - 1) {
        console.log(`\n⏱  Пауза ${batchDelay}ms перед следующим батчем...`);
        await sleep(batchDelay);
      }
    }

    // Вычисляем затраченное время
    const endTime = Date.now();
    const totalSeconds = Math.floor((endTime - startTime) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const timeStr =
      minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;

    console.log(
      "\n\n═══════════════════════════════════════════════════════════"
    );
    console.log("ИТОГИ");
    console.log(
      "═══════════════════════════════════════════════════════════"
    );
    console.log(`Всего объявлений:     ${ads.length}`);
    console.log(`Обработано:           ${totalProcessed}`);
    console.log(`Обновлено в БД:       ${totalUpdated}`);
    console.log(`Пропущено:            ${totalSkipped}`);
    console.log(`Ошибок:               ${totalErrors}`);
    console.log(`Время выполнения:     ${timeStr}`);
    console.log(
      "═══════════════════════════════════════════════════════════\n"
    );

    // Завершаем job
    if (jobId) {
      if (totalErrors > 0 && totalUpdated === 0) {
        await updateParseJobStatus(
          client,
          jobId,
          "error",
          `Все ${totalErrors} объявлений завершились с ошибкой`
        );
      } else {
        await updateParseJobStatus(client, jobId, "completed");
      }
    }

    if (totalUpdated > 0) {
      console.log("✓ Парсинг успешно завершен!");
    } else {
      console.log("⚠ Ни одно описание не было обновлено");
    }
  } catch (error) {
    console.error("\n✗ Критическая ошибка:", error);
    if (jobId) {
      try {
        await updateParseJobStatus(client, jobId, "error", error.message);
      } catch (_) {
        // ignore
      }
    }
    throw error;
  } finally {
    await client.end();
    console.log("\n✓ Соединение с БД закрыто");
  }
}

// Запуск из CLI
if (require.main === module) {
  const args = parseCliArgs();
  const accountId = args["account-id"] ? Number(args["account-id"]) : null;
  const jobId = args["job-id"] ? Number(args["job-id"]) : null;

  runParsing({ accountId, jobId }).catch((err) => {
    console.error("\n✗ Парсер завершился с ошибкой:", err);
    process.exitCode = 1;
  });
}

module.exports = { runParsing };
