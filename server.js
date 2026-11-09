const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
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

const MOBILIZE_URL = "https://www.mobilize-fs.com.co/portal-pagos/";

// ============================================================
// POOL
// ============================================================
const warmPool = [];
const POOL_SIZE = 2;
const sessions = new Map();

async function launchBrowser() {
  console.log("[POOL] Lanzando navegador...");
  return puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      `--proxy-server=http://${PROXY.host}:${PROXY.port}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1366,768",
    ],
  });
}

async function preparePage(page) {
  await page.authenticate({ username: PROXY.user, password: PROXY.pass });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });
}

async function warmUp() {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    await preparePage(page);

    console.log("[POOL] Navegando a Mobilize...");
    await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector("#otp-contract", { timeout: 30000 });
    console.log("[POOL] Página lista.");

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
    fillPool().catch(() => {});
    return warm;
  }
  console.log("[POOL] Pool vacío, creando nuevo...");
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await preparePage(page);
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

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 20 * 60 * 1000) destroySession(id);
  }
}, 60000);

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
// ENDPOINTS (los tuyos intactos)
// ============================================================

// 1. INICIAR — Llena crédito, clic Continuar, extrae opciones OTP
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  const sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const { browser, page } = await takeFromPool();
    sessions.set(sessionId, { browser, page, id: sessionId, createdAt: Date.now() });

    console.log(`[${sessionId}] Llenando crédito: ${creditNumber}`);
    const input = await page.$("#otp-contract");
    await input.click({ clickCount: 3 });
    await input.type(creditNumber, { delay: 40 });
    await new Promise((r) => setTimeout(r, 800));

    console.log(`[${sessionId}] Clic en Continuar...`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.otp-form__primary, .mat-flat-button")];
      const b = btns.find((el) => el.innerText.toLowerCase().includes("continuar"));
      if (b) b.click();
    });

    await new Promise((r) => setTimeout(r, 4000));

    const otpOptions = await page.evaluate(() => {
      const options = [];
      const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
      radios.forEach((r, i) => {
        const label = r.innerText || r.getAttribute("aria-label") || r.closest("label")?.innerText || "";
        const value = r.querySelector("input")?.value || r.getAttribute("value") || i.toString();
        if (label.trim()) options.push({ type: "radio", index: i, label: label.trim(), value });
      });
      if (options.length === 0) {
        const allClickable = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option, .mat-selection-list mat-list-option");
        allClickable.forEach((el, i) => {
          const txt = el.innerText.toLowerCase();
          if (txt.includes("sms") || txt.includes("correo") || txt.includes("email") ||
              txt.includes("celular") || txt.includes("mensaje") || txt.includes("teléfono") ||
              txt.includes("mail") || txt.includes("enviar")) {
            options.push({ type: "button", index: i, label: el.innerText.trim(), value: el.innerText.trim() });
          }
        });
      }
      const bodyText = document.body.innerText.substring(0, 2000);
      return { options, bodyText, url: window.location.href };
    });

    // Detección de CAPTCHA dinámico (múltiples selectores)
    const hasCaptcha = await page.evaluate(() => {
      const sels = [
        ".waf-captcha__stage",
        "#captcha-container",
        "iframe[src*='recaptcha' i]",
        "iframe[src*='hcaptcha' i]",
        "iframe[title*='reCAPTCHA' i]",
        "div.g-recaptcha",
        "div.h-captcha",
        "[class*='captcha' i]",
        "canvas[class*='captcha' i]",
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
      }
      return false;
    });

    let screenshot = null;
    if (hasCaptcha) {
      const buf = await page.screenshot({ encoding: "base64", fullPage: false });
      screenshot = `data:image/png;base64,${buf}`;
    }

    console.log(`[${sessionId}] OTP: ${otpOptions.options.length}, CAPTCHA: ${hasCaptcha}`);

    res.json({
      sessionId,
      otpOptions: otpOptions.options,
      bodyText: otpOptions.bodyText,
      url: otpOptions.url,
      hasCaptcha,
      screenshot,
    });
  } catch (err) {
    console.error(`[${sessionId}] Error start:`, err.message);
    await destroySession(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// 1b. SELECCIONAR MÉTODO OTP
app.post("/api/select-otp", async (req, res) => {
  const { sessionId, optionIndex, optionType, optionValue } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    console.log(`[${sessionId}] Seleccionando OTP: ${optionType} index=${optionIndex} val=${optionValue}`);

    if (optionType === "radio") {
      await page.evaluate((idx) => {
        const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
        if (radios[idx]) radios[idx].click();
      }, optionIndex);
    } else {
      await page.evaluate((val) => {
        const allClickable = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option, .mat-selection-list mat-list-option");
        const match = [...allClickable].find((el) => el.innerText.trim() === val);
        if (match) match.click();
      }, optionValue);
    }

    await new Promise((r) => setTimeout(r, 1500));

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.mat-flat-button, .mat-flat-button")];
      const b = btns.find((el) => {
        const txt = el.innerText.toLowerCase();
        return txt.includes("enviar") || txt.includes("continuar") || txt.includes("siguiente");
      });
      if (b && !b.disabled) b.click();
    });

    await new Promise((r) => setTimeout(r, 3000));

    const hasCaptcha = await page.evaluate(() => {
      const sels = [".waf-captcha__stage", "#captcha-container", "iframe[src*='recaptcha' i]",
        "iframe[src*='hcaptcha' i]", "div.g-recaptcha", "div.h-captcha", "[class*='captcha' i]"];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
      }
      return false;
    });

    let screenshot = null;
    if (hasCaptcha) {
      const buf = await page.screenshot({ encoding: "base64", fullPage: false });
      screenshot = `data:image/png;base64,${buf}`;
    }

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.log(`[${sessionId}] OTP seleccionado. CAPTCHA: ${hasCaptcha}`);

    res.json({ success: true, hasCaptcha, screenshot, bodyText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1c. DETECTAR ESTADO
app.post("/api/detect-state", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;
    const otpOptions = await page.evaluate(() => {
      const options = [];
      const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
      radios.forEach((r, i) => {
        const label = r.innerText || r.getAttribute("aria-label") || r.closest("label")?.innerText || "";
        const value = r.querySelector("input")?.value || r.getAttribute("value") || i.toString();
        if (label.trim()) options.push({ type: "radio", index: i, label: label.trim(), value });
      });
      if (options.length === 0) {
        const allClickable = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option");
        allClickable.forEach((el, i) => {
          const txt = el.innerText.toLowerCase();
          if (txt.includes("sms") || txt.includes("correo") || txt.includes("email") ||
              txt.includes("celular") || txt.includes("mensaje") || txt.includes("teléfono")) {
            options.push({ type: "button", index: i, label: el.innerText.trim(), value: el.innerText.trim() });
          }
        });
      }
      return options;
    });

    const hasCaptcha = await page.evaluate(() => {
      const sels = [".waf-captcha__stage", "#captcha-container", "iframe[src*='recaptcha' i]",
        "iframe[src*='hcaptcha' i]", "div.g-recaptcha", "div.h-captcha", "[class*='captcha' i]"];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetHeight > 0 && el.offsetWidth > 0) return true;
      }
      return false;
    });

    let screenshot = null;
    if (hasCaptcha) {
      const buf = await page.screenshot({ encoding: "base64", fullPage: false });
      screenshot = `data:image/png;base64,${buf}`;
    }

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    res.json({ otpOptions, hasCaptcha, screenshot, bodyText });
  } catch (err) {
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

// 3. CLICK en coordenadas (fallback — usado solo si el espejo falla)
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

// 6. EXTRAER DATOS
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
// HTTP + WEBSOCKET ESPEJO EN VIVO
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/ws/mirror")) return;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://x");
  const sessionId = url.searchParams.get("sessionId");
  const session = sessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "Sesión no encontrada" }));
    return ws.close(4004, "no session");
  }

  const { page } = session;
  console.log(`[${sessionId}] Espejo conectado.`);

  let cdp;
  try {
    cdp = await page.target().createCDPSession();
    await cdp.send("Page.enable");
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: 1100,
      maxHeight: 800,
      everyNthFrame: 2,
    });

    cdp.on("Page.screencastFrame", async (frame) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(Buffer.from(frame.data, "base64"), { binary: true });
      }
      try { await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }); } catch {}
    });
  } catch (e) {
    console.error(`[${sessionId}] Error CDP:`, e.message);
    ws.close();
    return;
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.t) {
        case "move":
          await page.mouse.move(msg.x, msg.y);
          break;
        case "click":
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.down();
          await new Promise((r) => setTimeout(r, 50));
          await page.mouse.up();
          break;
        case "dblclick":
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.down({ clickCount: 1 });
          await page.mouse.up({ clickCount: 1 });
          await new Promise((r) => setTimeout(r, 30));
          await page.mouse.down({ clickCount: 2 });
          await page.mouse.up({ clickCount: 2 });
          break;
        case "wheel":
          await page.mouse.wheel({ deltaY: msg.d });
          break;
        case "press":
          await page.keyboard.press(msg.k);
          break;
        case "type":
          await page.keyboard.type(msg.s, { delay: 20 });
          break;
        case "backspace":
          await page.keyboard.press("Backspace");
          break;
        case "selectall":
          await page.keyboard.down("Control");
          await page.keyboard.press("KeyA");
          await page.keyboard.up("Control");
          break;
      }
    } catch (e) { /* silencioso */ }
  });

  ws.on("close", async () => {
    try { await cdp.send("Page.stopScreencast"); } catch {}
    try { await cdp.detach(); } catch {}
    console.log(`[${sessionId}] Espejo desconectado.`);
  });
});

// ============================================================
// ARRANQUE
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Mobilize Puppeteer + Geonode → http://localhost:${PORT}`);
  console.log("[POOL] Pre-calentando navegadores...");
  fillPool().catch((e) => console.error("[POOL] Error inicial:", e.message));
});
