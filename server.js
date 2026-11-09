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

const MOBILIZE_URL = "https://pmz.mfs.bank4us.co/1111111/login";

// ============================================================
// SESIONES DE PUPPETEER (una por usuario/crédito)
// ============================================================
const sessions = new Map();

async function createSession(sessionId) {
  console.log(`[${sessionId}] Abriendo navegador con proxy Geonode...`);

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

  const page = await browser.newPage();

  // Autenticación del proxy
  await page.authenticate({ username: PROXY.user, password: PROXY.pass });

  // User agent real
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });

  // Navegar al sitio de Mobilize
  console.log(`[${sessionId}] Navegando a Mobilize...`);
  await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Esperar a que cargue la app Angular
  await new Promise((r) => setTimeout(r, 3000));

  const session = { browser, page, id: sessionId, createdAt: Date.now() };
  sessions.set(sessionId, session);

  console.log(`[${sessionId}] Sesión lista.`);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
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

// ============================================================
// ENDPOINTS
// ============================================================

// 1. INICIAR - Abre Mobilize, ingresa crédito, captura estado
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  const sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const session = await createSession(sessionId);
    const page = session.page;

    // Buscar el campo de crédito y llenarlo
    console.log(`[${sessionId}] Llenando crédito: ${creditNumber}`);

    const creditInput = await page.waitForSelector(
      'input[formcontrolname="creditNumber"], input[name="creditNumber"], input[type="text"]',
      { timeout: 15000 }
    );
    await creditInput.click({ clickCount: 3 });
    await creditInput.type(creditNumber, { delay: 50 });

    await new Promise((r) => setTimeout(r, 1500));

    // Captura screenshot
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

// 2. SCREENSHOT - Captura actual
app.post("/api/screenshot", async (req, res) => {
  const { sessionId } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const screenshot = await session.page.screenshot({ encoding: "base64", fullPage: false });
    res.json({ screenshot: `data:image/png;base64,${screenshot}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. CLICK - Click en coordenadas (para CAPTCHA, botones, etc.)
app.post("/api/click", async (req, res) => {
  const { sessionId, x, y } = req.body;
  const session = getSession(sessionId);
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
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    const clicked = await page.evaluate((btnText) => {
      const btns = [...document.querySelectorAll("button, a, [role='button'], .btn, input[type='submit']")];
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

// 5. ESCRIBIR - Para OTP u otros campos
app.post("/api/type", async (req, res) => {
  const { sessionId, selector, text } = req.body;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 10000 });
      await el.click({ clickCount: 3 });
      await el.type(text, { delay: 50 });
    } else {
      await page.keyboard.type(text, { delay: 50 });
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
  const session = getSession(sessionId);
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
app.get("/api/health", (req, res) => res.json({ status: "ok", sessions: sessions.size }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mobilize Puppeteer + Geonode → http://localhost:${PORT}`));
