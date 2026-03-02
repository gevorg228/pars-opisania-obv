import http from 'http';
import { URL } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Загружаем переменные окружения
dotenv.config();

// Подключаем плагин stealth для обхода детекции ботов
puppeteer.use(StealthPlugin());

const PORT = process.env.PORT || 3300;
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 120000);
const SIMULATION_SLOWDOWN = Number(process.env.SIMULATION_SLOWDOWN || 1.5);
const SIMULATION_TIMEOUT_MS = Math.round(
  Number(process.env.SIMULATION_TIMEOUT_MS || 8000) * SIMULATION_SLOWDOWN
);
const WAIT_UNTIL = process.env.WAIT_UNTIL || 'domcontentloaded';

// Массив User-Agent для ротации (разные браузеры и версии)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Глобальная переменная для хранения экземпляра браузера
// Это позволяет переиспользовать браузер между запросами и сохранять авторизацию
let browserInstance = null;
const MAX_PAGES = Number(process.env.MAX_PAGES || 5);
const pagePool = [];
const busyPages = new Set();
const waitQueue = [];
const knownPages = new WeakSet();

/**
 * Очищает данные браузера (cookies, cache)
 */
function clearBrowserData() {
  const browserDataPath = path.join(__dirname, 'browser-data');
  if (!fs.existsSync(browserDataPath)) return;
  
  try {
    // Удаляем только cookies и cache, оставляем структуру папок
    const cookiesPath = path.join(browserDataPath, 'Default', 'Cookies');
    const cachePath = path.join(browserDataPath, 'Default', 'Cache');
    
    if (fs.existsSync(cookiesPath)) fs.rmSync(cookiesPath, { force: true, recursive: true });
    if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { force: true, recursive: true });
    
    console.log('✓ Cookies и cache очищены');
  } catch (error) {
    console.warn('! Не удалось очистить browser-data:', error.message);
  }
}

/**
 * Функция для получения или создания экземпляра браузера
 * Возвращает существующий браузер если он активен, или создает новый
 */
async function getBrowser() {
  // Проверяем, есть ли уже запущенный браузер и подключен ли он
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  // Очистка данных браузера если включена
  if (process.env.CLEAR_BROWSER_DATA === '1') {
    clearBrowserData();
  }

  // Создаем новый экземпляр браузера с настройками для обхода детекции
  browserInstance = await puppeteer.launch({
    // Видимый браузер - чтобы видеть что происходит
    headless: false,
    
    // userDataDir - папка для сохранения cookies, localStorage и авторизации
    // Благодаря этому авторизация сохраняется между запусками
    userDataDir: './browser-data',
    
    // Отключаем флаг автоматизации
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
    
    // Аргументы Chrome для максимального обхода детекции
    args: [
      // Прокси (если указан)
      ...(process.env.PROXY_SERVER ? [`--proxy-server=${process.env.PROXY_SERVER}`] : []),
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
  // Имитация поведения реального пользователя с рандомизацией
  const scale = ms => Math.max(0, Math.round(ms * SIMULATION_SLOWDOWN));
  const initialDelay = scale(getRandomDelay(1500, 3500)); // Варьируем начальную задержку
  await new Promise(resolve => setTimeout(resolve, initialDelay));

  // Случайное количество движений мыши (2-5)
  const moveCount = getRandomDelay(2, 5);
  for (let i = 0; i < moveCount; i++) {
    const randomX = getRandomDelay(100, 1200);
    const randomY = getRandomDelay(100, 700);
    const steps = getRandomDelay(8, 15);
    await page.mouse.move(randomX, randomY, { steps });
    await new Promise(resolve => setTimeout(resolve, scale(getRandomDelay(200, 700))));
  }

  // Плавная прокрутка страницы (как человек) с ограничением по времени
  const scrollConfig = {
    maxSteps: 60,
    maxTimeMs: scale(8000),
    intervalMs: scale(140),
    distance: 100,
  };
  await page.evaluate(async ({ maxSteps, maxTimeMs, intervalMs, distance }) => {
    const start = Date.now();
    let totalHeight = 0;
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
      }, intervalMs);
    });
  }, scrollConfig);

  // Пауза после прокрутки
  await new Promise(resolve => setTimeout(resolve, scale(1000 + Math.random() * 1000)));

  // Еще одно движение мышью
  const finalX = 300 + Math.floor(Math.random() * 600);
  const finalY = 300 + Math.floor(Math.random() * 400);
  await page.mouse.move(finalX, finalY, { steps: 15 });

  // Финальная задержка
  await new Promise(resolve => setTimeout(resolve, scale(500)));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function configurePage(page, forceReconfigure = false) {
  if (page.__codexConfigured && !forceReconfigure) {
    // Но User-Agent меняем при каждом запросе
    await page.setUserAgent(getRandomUserAgent());
    return;
  }

  // Рандомный размер окна (имитация разных мониторов)
  const widths = [1920, 1680, 1440, 1366];
  const heights = [1080, 1050, 900, 768];
  const randomWidth = widths[Math.floor(Math.random() * widths.length)];
  const randomHeight = heights[Math.floor(Math.random() * heights.length)];

  await page.setViewport({
    width: randomWidth,
    height: randomHeight,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    isLandscape: true,
  });

  // Рандомный User-Agent
  await page.setUserAgent(getRandomUserAgent());

  // Аутентификация прокси (если нужна)
  if (process.env.PROXY_USERNAME && process.env.PROXY_PASSWORD) {
    await page.authenticate({
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD
    });
  }

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
      
      // Предварительно создаем все нужные страницы
      const browser = await getBrowser();
      const neededPages = Math.min(urls.length, MAX_PAGES);
      while (pagePool.length + busyPages.size < neededPages) {
        const page = await browser.newPage();
        knownPages.add(page);
        await configurePage(page);
        pagePool.push(page);
      }
      
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
  console.log('───────────────────────────────────────────────────────────');
  console.log('🛡️  АНТИ-БАН ЗАЩИТА:');
  console.log(`   • Ротация User-Agent: 7 вариантов`);
  console.log(`   • Рандомные размеры окна и задержки`);
  console.log(`   • Имитация поведения пользователя`);
  console.log(`   • MAX_PAGES: ${MAX_PAGES}`);
  console.log(`   • SIMULATION_SLOWDOWN: ${SIMULATION_SLOWDOWN}x`);
  console.log(`   • Очистка cookies: ${process.env.CLEAR_BROWSER_DATA === '1' ? 'ВКЛ' : 'ВЫКЛ'}`);
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


