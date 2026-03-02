const dotenv = require("dotenv");
const { createDbClient, getActiveAds, updateDescription } = require("./db");
const { fetchBatchHtmls } = require("./fetcher");
const { extractDescription } = require("./parser");

dotenv.config();

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForParser(parserBase, maxRetries = 30) {
  console.log("Ожидание запуска Puppeteer сервера...");
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(parserBase.replace(/\/$/, '') + '/?url=about:blank');
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

async function run() {
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
  console.log(`База данных: ${databaseUrl.replace(/\/\/[^@]+@/, '//***@')}`);
  console.log(`Puppeteer парсер: ${parserBase}`);
  console.log(`Размер батча: ${batchSize}`);
  console.log(`Задержка между батчами: ${batchDelay}ms`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Ждем пока Puppeteer запустится
  await waitForParser(parserBase);

  const client = createDbClient();
  await client.connect();
  console.log("✓ Подключено к БД\n");

  // Засекаем время старта
  const startTime = Date.now();

  try {
    console.log("Получаю список активных объявлений...");
    const ads = await getActiveAds(client);
    
    if (!ads.length) {
      console.log("✓ Нет активных объявлений для обработки");
      return;
    }

    console.log(`✓ Найдено объявлений: ${ads.length}\n`);

    const batches = chunkArray(ads, batchSize);
    console.log(`Будет обработано ${batches.length} батч(ей)\n`);

    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const urls = batch.map(ad => ad.url);

      console.log(`\n[${"=".repeat(60)}]`);
      console.log(`Батч ${b + 1}/${batches.length}: обработка ${urls.length} объявлений`);
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

            console.log(`    ✓ Найдено описание (${description.length} символов)`);

            await updateDescription(client, ad.avito_item_id, description);
            console.log(`    ✓ Описание обновлено в БД\n`);
            totalUpdated++;

          } catch (error) {
            console.error(`    ✗ Ошибка при обработке: ${error.message}\n`);
            totalErrors++;
          }
        }

      } catch (error) {
        console.error(`\n✗ Ошибка при обработке батча ${b + 1}: ${error.message}\n`);
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
    const timeStr = minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;

    console.log("\n\n═══════════════════════════════════════════════════════════");
    console.log("ИТОГИ");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`Всего объявлений:     ${ads.length}`);
    console.log(`Обработано:           ${totalProcessed}`);
    console.log(`Обновлено в БД:       ${totalUpdated}`);
    console.log(`Пропущено:            ${totalSkipped}`);
    console.log(`Ошибок:               ${totalErrors}`);
    console.log(`Время выполнения:     ${timeStr}`);
    console.log("═══════════════════════════════════════════════════════════\n");

    if (totalUpdated > 0) {
      console.log("✓ Парсинг успешно завершен!");
    } else {
      console.log("⚠ Ни одно описание не было обновлено");
    }

  } catch (error) {
    console.error("\n✗ Критическая ошибка:", error);
    throw error;
  } finally {
    await client.end();
    console.log("\n✓ Соединение с БД закрыто");
  }
}

run().catch(err => {
  console.error("\n✗ Парсер завершился с ошибкой:", err);
  process.exitCode = 1;
});
