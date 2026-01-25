import http from 'http';
import { URL } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Подключаем плагин stealth для обхода детекции ботов
puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3100;
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 120000);
const SIMULATION_TIMEOUT_MS = Number(process.env.SIMULATION_TIMEOUT_MS || 8000);
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'domcontentloaded';

// Глобальная переменная для хранения экземпляра браузера
// Это позволяет переиспользовать браузер между запросами и сохранять авторизацию
let browserInstance = null;
const MAX_PAGES = Number(process.env.MAX_PAGES || 3);
const pagePool = [];
const busyPages = new Set();
const waitQueue = [];
const knownPages = new WeakSet();

/**
 * Функция для получения или создания экземпляра браузера
 * Возвращает существующий браузер если он активен, или создает новый
 */
async function getBrowser() {
  // Проверяем, есть ли уже запущенный браузер и подключен ли он
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  // Создаем новый экземпляр браузера с настройками для обхода детекции
  browserInstance = await puppeteer.launch({
    // ВАЖНО: Не headless режим - выглядит как реальный браузер
    headless: false,
    
    // userDataDir - папка для сохранения cookies, localStorage и авторизации
    // Благодаря этому авторизация сохраняется между запусками
    userDataDir: './browser-data',
    
    // Отключаем флаг автоматизации
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
    
    // Аргументы Chrome для максимального обхода детекции
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--exclude-switches=enable-automation',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--start-maximized',
      '--lang=ru-RU,ru,en-US,en',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-ipc-flooding-protection',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--no-default-browser-check',
      '--no-first-run',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-gpu',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--mute-audio',
    ],
  });

  return browserInstance;
}

async function simulateHumanBehavior(page) {
  // Имитация поведения реального пользователя
  const initialDelay = 2000 + Math.floor(Math.random() * 2000);
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  // Случайные движения мышью (имитация чтения страницы)
  for (let i = 0; i < 3; i++) {
    const randomX = 200 + Math.floor(Math.random() * 800);
    const randomY = 200 + Math.floor(Math.random() * 400);
    await page.mouse.move(randomX, randomY, { steps: 10 });
    await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 500));
  }

  // Плавная прокрутка страницы (как человек) с ограничением по времени
  await page.evaluate(async () => {
    const maxSteps = 40;
    const maxTimeMs = 5000;
    const start = Date.now();
    let totalHeight = 0;
    const distance = 100;
    let steps = 0;

    await new Promise(resolve => {
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        steps += 1;

        if (steps >= maxSteps || totalHeight >= scrollHeight / 2 || Date.now() - start > maxTimeMs) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });

  // Пауза после прокрутки
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

  // Еще одно движение мышью
  const finalX = 300 + Math.floor(Math.random() * 600);
  const finalY = 300 + Math.floor(Math.random() * 400);
  await page.mouse.move(finalX, finalY, { steps: 15 });

  // Финальная задержка
  await new Promise(resolve => setTimeout(resolve, 500));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function configurePage(page) {
  if (page.__codexConfigured) {
    return;
  }

  // Устанавливаем viewport как у реального пользователя
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    isLandscape: true,
  });

  // Устанавливаем реалистичный User-Agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  );

  // Устанавливаем HTTP заголовки как у реального браузера
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Sec-CH-UA': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Cache-Control': 'max-age=0',
    'Priority': 'u=0, i',
  });

  // Расширенная защита от детекции - выполняется ДО загрузки страницы
  await page.evaluateOnNewDocument(() => {
    // Скрываем webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    // Переопределяем navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ru-RU', 'ru', 'en-US', 'en'],
    });

    // Переопределяем плагины
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });

    // Chrome runtime
    window.chrome = {
      runtime: {},
    };

    // Permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Переопределяем getBattery для имитации реального устройства
    if (navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      });
    }

    // WebGL vendor
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel(R) UHD Graphics';
      }
      return getParameter.apply(this, [parameter]);
    };

    // Connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // Hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });

    // Device memory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });
  });

  page.__codexConfigured = true;
}

async function syncExistingPages() {
  const browser = await getBrowser();
  const pages = await browser.pages();

  for (const page of pages) {
    if (knownPages.has(page) || page.isClosed()) {
      continue;
    }
    knownPages.add(page);
    await configurePage(page);
    pagePool.push(page);
  }

  return browser;
}

async function acquirePage() {
  const browser = await syncExistingPages();

  if (pagePool.length > 0) {
    const page = pagePool.shift();
    busyPages.add(page);
    return page;
  }

  if (busyPages.size < MAX_PAGES) {
    const page = await browser.newPage();
    knownPages.add(page);
    await configurePage(page);
    busyPages.add(page);
    return page;
  }

  return new Promise(resolve => {
    waitQueue.push(resolve);
  });
}

function releasePage(page) {
  if (page.isClosed()) {
    busyPages.delete(page);
    return;
  }

  if (waitQueue.length > 0) {
    const resolve = waitQueue.shift();
    resolve(page);
    return;
  }

  busyPages.delete(page);
  pagePool.push(page);
}

/**
 * Функция для парсинга страницы
 * Имитирует поведение реального пользователя
 */
async function scrapePage(url) {
  const page = await acquirePage();

  try {
    await configurePage(page);

    console.log(`  → Переход на: ${url}`);

    let navError = null;
    try {
      await page.goto(url, {
        waitUntil: WAIT_UNTIL,
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (error) {
      navError = error;
      console.warn(`  ! Navigation error, continuing with current content: ${error.message}`);
    }

    console.log(`  → Страница загружена, имитация поведения пользователя...`);

    try {
      await Promise.race([
        simulateHumanBehavior(page),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Simulation timeout')), SIMULATION_TIMEOUT_MS)),
      ]);
    } catch (error) {
      console.warn(`  ! Имитация поведения прервана: ${error.message}`);
    }

    console.log(`  → Получение контента страницы...`);

    if (navError) {
      await delay(1500);
    }

    // Получаем HTML контент страницы
    const content = await page.content();

    return content;
  } catch (error) {
    console.error(`  ✗ Ошибка при парсинге: ${error.message}`);
    throw error;
  } finally {
    releasePage(page);
  }
  // ВАЖНО: НЕ закрываем вкладку! Оставляем её открытой для следующих запросов
  // Это сохраняет авторизацию и cookies
}

/**
 * Валидация URL
 */
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw);
}

/**
 * HTTP сервер
 */
const server = http.createServer(async (req, res) => {
  // Обработка OPTIONS для CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Парсим URL запроса
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const targetUrl = parsedUrl.searchParams.get('url');
  const isBatch = parsedUrl.pathname === '/batch';

  if (isBatch && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Метод не разрешен. Используйте POST.' });
    return;
  }

  if (!isBatch && req.method !== 'GET') {
    sendJson(res, 405, { error: 'Метод не разрешен. Используйте GET.' });
    return;
  }

  if (isBatch) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { error: 'Некорректный JSON в теле запроса.' });
      return;
    }

    const urls = body && Array.isArray(body.urls) ? body.urls : null;
    if (!urls || urls.length === 0) {
      sendJson(res, 400, { error: 'Параметр urls обязателен. Пример: { "urls": ["https://example.com"] }' });
      return;
    }

    const invalid = urls.filter(u => !isValidUrl(u));
    if (invalid.length > 0) {
      sendJson(res, 400, { error: 'Некорректный URL. Используйте http:// или https://', invalid });
      return;
    }

    try {
      console.log(`\nBatch парсинг: ${urls.length} URL(ов)`);
      const settled = await Promise.allSettled(urls.map(url => scrapePage(url)));
      const results = urls.map((url, idx) => {
        const item = settled[idx];
        if (item.status === 'fulfilled') {
          return { url, html: item.value || null };
        }
        console.error(`  ✗ Batch ошибка для ${url}: ${item.reason?.message || item.reason}`);
        return { url, html: null };
      });
      sendJson(res, 200, { results });
      console.log(`✓ Batch успешно завершен`);
    } catch (error) {
      console.error('Ошибка при batch парсинге:', error.message);
      sendJson(res, 500, { error: 'Ошибка при batch загрузке страниц', details: error.message });
    }

    return;
  }

  // Валидация входящего URL
  if (!targetUrl) {
    sendJson(res, 400, { error: 'Параметр url обязателен. Пример: ?url=https://example.com' });
    return;
  }

  if (!isValidUrl(targetUrl)) {
    sendJson(res, 400, { error: 'Некорректный URL. Используйте http:// или https://' });
    return;
  }

  try {
    console.log(`\nПарсинг страницы: ${targetUrl}`);
    
    // Парсим страницу
    const htmlContent = await scrapePage(targetUrl);

    // Возвращаем HTML контент с CORS заголовками
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(htmlContent);
    
    console.log(`✓ Страница успешно загружена`);
  } catch (error) {
    console.error('Ошибка при парсинге:', error.message);
    
    sendJson(res, 500, {
      error: 'Ошибка при загрузке страницы',
      details: error.message,
    });
  }
});

// Запуск сервера
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
  console.log(`📖 Использование: http://localhost:${PORT}?url=https://example.com`);
  console.log(`💾 Данные авторизации сохраняются в папке: browser-data`);
  console.log(`🌐 Браузер остается открытым между запросами для сохранения сессии`);
  console.log('═══════════════════════════════════════════════════════════');
});

/**
 * Обработка сигналов завершения для корректного закрытия браузера
 */
async function gracefulShutdown(signal) {
  console.log(`\n\n${signal} получен. Закрытие браузера...`);
  
  if (browserInstance && browserInstance.isConnected()) {
    await browserInstance.close();
    console.log('✓ Браузер закрыт');
  }
  
  server.close(() => {
    console.log('✓ Сервер остановлен');
    process.exit(0);
  });
}

// Обработка SIGINT (Ctrl+C) и SIGTERM
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));


