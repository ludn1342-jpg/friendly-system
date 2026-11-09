const express = require("express");
const cors = require("cors");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname)));

// ============================================================
// GEONODE PROXY RESIDENCIAL COLOMBIA
// ============================================================
const PROXY = {
  host: "proxy.geonode.io",
  port: 9000,
  user: "geonode_PKlL1yvoTG-country-co",
  pass: "605d224e-19b6-4baa-8107-296ee7d836f5",
};

// URL REAL del portal de pagos de Mobilize
const MOBILIZE_URL = "https://www.mobilize-fs.com.co/portal-pagos/";

// ============================================================
// POOL DE NAVEGADORES PRE-CALENTADOS
// ============================================================
const warmPool = [];
const POOL_SIZE = 2;
const sessions = new Map();

async function launchBrowser() {
  console.log("[POOL] Lanzando navegador...");
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      `--proxy-server=http://${PROXY.host}:${PROXY.port}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--window-size=1366,768",
    ],
  });
  return browser;
}

async function warmUp() {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();

    await page.authenticate({ username: PROXY.user, password: PROXY.pass });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1366, height: 768 });

    console.log("[POOL] Navegando a Mobilize...");
    await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // Esperar input de crédito (Angular Material)
    await page.waitForSelector("#otp-contract", { timeout: 30000 });
    console.log("[POOL] Página lista, input #otp-contract encontrado.");

    warmPool.push({ browser, page, createdAt: Date.now() });
    console.log(`[POOL] Pool: ${warmPool.length}/${POOL_SIZE} listos.`);
  } catch (err) {
    console.error("[POOL] Error pre-calentando:", err.message);
  }
}

async function fillPool() {
  while (warmPool.length < POOL_SIZE) {
    await warmUp();
  }
}

async function takeFromPool() {
  if (warmPool.length > 0) {
    const warm = warmPool.shift();
    console.log(`[POOL] Tomado del pool. Quedan: ${warmPool.length}`);
    // Rellenar en background
    fillPool().catch(() => {});
    return warm;
  }
  // Pool vacío — crear uno nuevo
  console.log("[POOL] Pool vacío, creando nuevo...");
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.authenticate({ username: PROXY.user, password: PROXY.pass });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#otp-contract", { timeout: 30000 });
  return { browser, page, createdAt: Date.now() };
}

async function destroySession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    try { await s.browser.close(); } catch (e) {}
    sessions.delete(sessionId);
    console.log(`[${sessionId}] Sesión cerrada.`);
  }
}

// Limpiar sesiones viejas (>15 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 15 * 60 * 1000) destroySession(id);
  }
}, 60000);

// Limpiar pool viejo (>10 min sin usar)
setInterval(() => {
  const now = Date.now();
  while (warmPool.length > 0 && now - warmPool[0].createdAt > 10 * 60 * 1000) {
    const old = warmPool.shift();
    old.browser.close().catch(() => {});
    console.log("[POOL] Navegador viejo descartado.");
  }
  fillPool().catch(() => {});
}, 60000);

// ============================================================
// ENDPOINTS
// ============================================================

// 1. INICIAR — Toma navegador pre-cargado, llena crédito, screenshot
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  const sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const { browser, page } = await takeFromPool();
    sessions.set(sessionId, { browser, page, id: sessionId, createdAt: Date.now() });

    // Llenar el campo de crédito (selector real: #otp-contract)
    console.log(`[${sessionId}] Llenando crédito: ${creditNumber}`);
    const input = await page.$("#otp-contract");
    await input.click({ clickCount: 3 });
    await input.type(creditNumber, { delay: 40 });

    // Pequeña pausa para que Angular procese
    await new Promise((r) => setTimeout(r, 1500));

    // Screenshot
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });

    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.substring(0, 1000),
    }));

    console.log(`[${sessionId}] Crédito llenado, screenshot listo.`);

    res.json({
      sessionId,
      screenshot: `data:image/png;base64,${screenshot}`,
      pageInfo,
    });

  } catch (err) {
    console.error(`[${sessionId}] Error start:`, err.message);
    await destroySession(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// 2. SCREENSHOT
app.post("/api/screenshot", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const screenshot = await session.page.screenshot({ encoding: "base64", fullPage: false });
    res.json({ screenshot: `data:image/png;base64,${screenshot}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. CLICK en coordenadas (para resolver CAPTCHA)
app.post("/api/click", async (req, res) => {
  const { sessionId, x, y } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    await session.page.mouse.click(x, y);
    await new Promise((r) => setTimeout(r, 1000));
    const screenshot = await session.page.screenshot({ encoding: "base64", fullPage: false });
    res.json({ screenshot: `data:image/png;base64,${screenshot}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. CLICK BOTÓN por texto
app.post("/api/click-button", async (req, res) => {
  const { sessionId, text } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    const clicked = await page.evaluate((btnText) => {
      const btns = [...document.querySelectorAll("button, a, [role='button'], .mat-flat-button")];
      const b = btns.find((el) => el.innerText.toLowerCase().includes(btnText.toLowerCase()));
      if (b) { b.click(); return true; }
      return false;
    }, text);

    await new Promise((r) => setTimeout(r, 2000));
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
    res.json({ clicked, screenshot: `data:image/png;base64,${screenshot}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ESCRIBIR en un campo (para OTP)
app.post("/api/type", async (req, res) => {
  const { sessionId, selector, text } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 10000 });
      await el.click({ clickCount: 3 });
      await el.type(text, { delay: 40 });
    } else {
      await page.keyboard.type(text, { delay: 40 });
    }
    await new Promise((r) => setTimeout(r, 1000));
    const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
    res.json({ screenshot: `data:image/png;base64,${screenshot}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. EXTRAER DATOS de la página
app.post("/api/extract", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const data = await session.page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      text: document.body.innerText,
      html: document.body.innerHTML.substring(0, 15000),
    }));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. CERRAR SESIÓN
app.post("/api/close", async (req, res) => {
  const { sessionId } = req.body;
  await destroySession(sessionId);
  res.json({ ok: true });
});

// Health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", sessions: sessions.size, pool: warmPool.length });
});

// ============================================================
// ARRANQUE
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Mobilize Puppeteer + Geonode → http://localhost:${PORT}`);
  console.log("[POOL] Pre-calentando navegadores...");
  fillPool().catch((e) => console.error("[POOL] Error inicial:", e.message));
});
