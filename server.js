const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
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
// POOL DE NAVEGADORES PRE-CALENTADOS
// ============================================================
const warmPool = [];
const POOL_SIZE = 2;
const sessions = new Map();

async function launchBrowser() {
  console.log("[POOL] Lanzando navegador...");
  return await puppeteer.launch({
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
    await page.waitForSelector("#otp-contract", { timeout: 30000 });
    console.log("[POOL] Página lista.");
    warmPool.push({ browser, page, createdAt: Date.now() });
    console.log(`[POOL] Pool: ${warmPool.length}/${POOL_SIZE}`);
  } catch (err) {
    console.error("[POOL] Error pre-calentando:", err.message);
  }
}

async function fillPool() {
  while (warmPool.length < POOL_SIZE) await warmUp();
}

async function takeFromPool() {
  if (warmPool.length > 0) {
    const w = warmPool.shift();
    console.log(`[POOL] Tomado. Quedan: ${warmPool.length}`);
    fillPool().catch(() => {});
    return w;
  }
  console.log("[POOL] Pool vacío, creando...");
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
    console.log(`[${sessionId}] Cerrada.`);
  }
}

// Limpiar sesiones viejas (>15 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > 15 * 60 * 1000) destroySession(id);
  }
}, 60000);

// Limpiar pool viejo
setInterval(() => {
  const now = Date.now();
  while (warmPool.length > 0 && now - warmPool[0].createdAt > 10 * 60 * 1000) {
    const old = warmPool.shift();
    old.browser.close().catch(() => {});
  }
  fillPool().catch(() => {});
}, 60000);

// ============================================================
// HELPER: Encontrar CAPTCHA (puede estar en iframe)
// ============================================================
async function findCaptchaElement(page) {
  // 1) Buscar en la página principal
  const mainResult = await page.evaluate(() => {
    const sels = [".waf-captcha__stage", "#captcha-container", "[class*='waf-captcha']", ".amzn-captcha-img-cell-container"];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 30) {
        const r = el.getBoundingClientRect();
        return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, inIframe: false };
      }
    }
    // Buscar por texto
    for (const d of document.querySelectorAll("div, section, form")) {
      const t = d.innerText?.toLowerCase() || "";
      if ((t.includes("elija todo") || t.includes("seleccione") || t.includes("confirma que eres")) && d.offsetHeight > 100) {
        const r = d.getBoundingClientRect();
        if (r.width > 200) return { found: true, x: r.x, y: r.y, width: r.width, height: r.height, inIframe: false };
      }
    }
    return { found: false };
  });

  if (mainResult.found) return mainResult;

  // 2) Buscar en iframes
  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      const iframeResult = await frame.evaluate(() => {
        const sels = [".waf-captcha__stage", "#captcha-container", "[class*='waf-captcha']", "[class*='captcha']", ".amzn-captcha-img-cell-container"];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el && el.offsetHeight > 30) {
            const r = el.getBoundingClientRect();
            return { found: true, x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        for (const d of document.querySelectorAll("div, section, form")) {
          const t = d.innerText?.toLowerCase() || "";
          if ((t.includes("elija todo") || t.includes("seleccione") || t.includes("select all")) && d.offsetHeight > 100) {
            const r = d.getBoundingClientRect();
            if (r.width > 200) return { found: true, x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        return { found: false };
      });

      if (iframeResult.found) {
        // Obtener posición del iframe en la página principal
        const iframeHandle = await page.evaluateHandle((url) => {
          for (const f of document.querySelectorAll("iframe")) {
            try { if (f.contentWindow && f.src.includes("captcha")) return f; } catch(e) {}
          }
          // Si no encuentra por src, buscar todos
          for (const f of document.querySelectorAll("iframe")) {
            if (f.offsetHeight > 100) return f;
          }
          return null;
        });

        const iframeBounds = await page.evaluate((el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }, iframeHandle);

        if (iframeBounds) {
          return {
            found: true,
            x: iframeBounds.x + iframeResult.x,
            y: iframeBounds.y + iframeResult.y,
            width: iframeResult.width,
            height: iframeResult.height,
            inIframe: true,
            iframeBounds,
          };
        }
      }
    } catch (e) {}
  }

  return { found: false };
}

// Screenshot solo del CAPTCHA
async function screenshotCaptcha(page) {
  const info = await findCaptchaElement(page);
  if (!info.found) return { found: false, screenshot: null, bounds: null };

  const pad = 10;
  const clipX = Math.max(0, info.x - pad);
  const clipY = Math.max(0, info.y - pad);
  const screenshot = await page.screenshot({
    encoding: "base64",
    clip: {
      x: clipX,
      y: clipY,
      width: Math.min(info.width + pad * 2, 1366 - clipX),
      height: Math.min(info.height + pad * 2, 768 - clipY),
    },
  });

  return {
    found: true,
    screenshot: `data:image/png;base64,${screenshot}`,
    bounds: { x: info.x, y: info.y, width: info.width, height: info.height },
  };
}

// ============================================================
// ENDPOINTS
// ============================================================

// 0. PRE-SESSION — crear sesión lista sin llenar crédito
app.post("/api/pre-session", async (req, res) => {
  const sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  try {
    const { browser, page } = await takeFromPool();
    sessions.set(sessionId, { browser, page, id: sessionId, createdAt: Date.now() });
    console.log(`[${sessionId}] Pre-session lista.`);
    res.json({ sessionId });
  } catch (err) {
    console.error(`[${sessionId}] Error pre-session:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 1. INICIAR — Llena crédito, clic Continuar, detecta CAPTCHA/OTP
app.post("/api/start", async (req, res) => {
  const { creditNumber, sessionId: existingSessionId } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  let sessionId = existingSessionId;
  let session = sessionId ? sessions.get(sessionId) : null;

  try {
    if (!session) {
      sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const { browser, page } = await takeFromPool();
      session = { browser, page, id: sessionId, createdAt: Date.now() };
      sessions.set(sessionId, session);
    }

    const page = session.page;

    // Llenar crédito
    console.log(`[${sessionId}] Llenando crédito: ${creditNumber}`);
    const input = await page.$("#otp-contract");
    if (!input) {
      // Intentar con selector alternativo
      await page.waitForSelector('input[formcontrolname="idProcess"]', { timeout: 5000 });
      const alt = await page.$('input[formcontrolname="idProcess"]');
      if (alt) { await alt.click({ clickCount: 3 }); await alt.type(creditNumber, { delay: 30 }); }
    } else {
      await input.click({ clickCount: 3 });
      await input.type(creditNumber, { delay: 30 });
    }
    await new Promise((r) => setTimeout(r, 500));

    // Clic en CONTINUAR
    console.log(`[${sessionId}] Clic Continuar...`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.otp-form__primary, .mat-flat-button")];
      const b = btns.find((el) => el.innerText.toLowerCase().includes("continuar"));
      if (b) b.click();
    });

    // Esperar a que cargue CAPTCHA o OTP (esperar menos tiempo, responder rápido)
    await new Promise((r) => setTimeout(r, 3000));

    // Detectar CAPTCHA
    const captchaResult = await screenshotCaptcha(page);

    // Detectar OTP
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
              txt.includes("celular") || txt.includes("mensaje") || txt.includes("teléfono") || txt.includes("mail") || txt.includes("enviar")) {
            options.push({ type: "button", index: i, label: el.innerText.trim(), value: el.innerText.trim() });
          }
        });
      }
      return options;
    });

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));

    console.log(`[${sessionId}] OTP: ${otpOptions.length}, CAPTCHA: ${captchaResult.found}`);

    res.json({
      sessionId,
      otpOptions,
      bodyText,
      hasCaptcha: captchaResult.found,
      screenshot: captchaResult.screenshot,
      captchaBounds: captchaResult.bounds,
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
    console.log(`[${sessionId}] OTP: ${optionType} idx=${optionIndex}`);

    if (optionType === "radio") {
      await page.evaluate((idx) => {
        const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
        if (radios[idx]) radios[idx].click();
      }, optionIndex);
    } else {
      await page.evaluate((val) => {
        const all = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option, .mat-selection-list mat-list-option");
        const m = [...all].find((el) => el.innerText.trim() === val);
        if (m) m.click();
      }, optionValue);
    }

    await new Promise((r) => setTimeout(r, 1500));

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.mat-flat-button, .mat-flat-button")];
      const b = btns.find((el) => {
        const t = el.innerText.toLowerCase();
        return t.includes("enviar") || t.includes("continuar") || t.includes("siguiente");
      });
      if (b && !b.disabled) b.click();
    });

    await new Promise((r) => setTimeout(r, 3000));

    const captchaResult = await screenshotCaptcha(page);
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));

    res.json({
      success: true,
      hasCaptcha: captchaResult.found,
      screenshot: captchaResult.screenshot,
      captchaBounds: captchaResult.bounds,
      bodyText,
    });
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
        const all = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option");
        all.forEach((el, i) => {
          const t = el.innerText.toLowerCase();
          if (t.includes("sms") || t.includes("correo") || t.includes("email") || t.includes("celular") || t.includes("mensaje") || t.includes("teléfono")) {
            options.push({ type: "button", index: i, label: el.innerText.trim(), value: el.innerText.trim() });
          }
        });
      }
      return options;
    });

    const captchaResult = await screenshotCaptcha(page);
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));

    res.json({ otpOptions, hasCaptcha: captchaResult.found, screenshot: captchaResult.screenshot, captchaBounds: captchaResult.bounds, bodyText });
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
    const captchaResult = await screenshotCaptcha(session.page);
    if (captchaResult.found) {
      res.json({ screenshot: captchaResult.screenshot, captchaBounds: captchaResult.bounds });
    } else {
      const screenshot = await session.page.screenshot({ encoding: "base64", fullPage: false });
      res.json({ screenshot: `data:image/png;base64,${screenshot}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. CLICK en CAPTCHA (coordenadas absolutas de viewport)
app.post("/api/click", async (req, res) => {
  const { sessionId, x, y, captchaBounds } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    let absX = x, absY = y;
    if (captchaBounds) {
      absX = captchaBounds.x + x;
      absY = captchaBounds.y + y;
    }
    console.log(`[${sessionId}] Click: rel(${x},${y}) → abs(${absX},${absY})`);
    await session.page.mouse.click(absX, absY);
    await new Promise((r) => setTimeout(r, 300));

    const captchaResult = await screenshotCaptcha(session.page);
    res.json({
      screenshot: captchaResult.screenshot || null,
      captchaBounds: captchaResult.bounds,
      captchaStillVisible: captchaResult.found,
    });
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
    const clicked = await session.page.evaluate((btnText) => {
      const btns = [...document.querySelectorAll("button, a, [role='button'], .mat-flat-button")];
      const b = btns.find((el) => el.innerText.toLowerCase().includes(btnText.toLowerCase()));
      if (b) { b.click(); return true; }
      return false;
    }, text);
    await new Promise((r) => setTimeout(r, 2000));
    res.json({ clicked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ESCRIBIR (OTP)
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
    res.json({ ok: true });
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

// 7. CERRAR
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
// WEBSOCKET MIRROR — espejo CAPTCHA en tiempo real
// ============================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let mirrorInterval = null;
  let wsSessionId = null;
  let clickLock = false; // evitar clicks simultáneos

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === "start-mirror") {
        wsSessionId = msg.sessionId;
        const session = sessions.get(wsSessionId);
        if (!session) { ws.send(JSON.stringify({ type: "error", msg: "Sesión no encontrada" })); return; }

        // Frame inicial
        const initial = await screenshotCaptcha(session.page);
        if (initial.found && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "frame", screenshot: initial.screenshot, bounds: initial.bounds }));
        }

        // Limpiar interval anterior si existe
        if (mirrorInterval) clearInterval(mirrorInterval);

        // Loop cada 200ms
        mirrorInterval = setInterval(async () => {
          if (clickLock) return; // no enviar frame durante click
          try {
            const s = sessions.get(wsSessionId);
            if (!s || ws.readyState !== 1) { clearInterval(mirrorInterval); return; }
            const frame = await screenshotCaptcha(s.page);
            if (frame.found) {
              ws.send(JSON.stringify({ type: "frame", screenshot: frame.screenshot, bounds: frame.bounds }));
            } else {
              ws.send(JSON.stringify({ type: "captcha-gone" }));
              clearInterval(mirrorInterval);
              mirrorInterval = null;
            }
          } catch (e) {}
        }, 200);
      }

      // CLICK — clic del usuario en el CAPTCHA
      if (msg.type === "click") {
        const sid = wsSessionId || msg.sessionId;
        const session = sessions.get(sid);
        if (!session || clickLock) return;

        clickLock = true;

        let absX = msg.x, absY = msg.y;
        if (msg.bounds) {
          absX = msg.bounds.x + msg.x;
          absY = msg.bounds.y + msg.y;
        }

        console.log(`[WS] Click: (${msg.x},${msg.y}) → abs(${absX},${absY})`);
        await session.page.mouse.click(absX, absY);

        // Esperar que la UI del CAPTCHA reaccione y enviar frame inmediato
        await new Promise((r) => setTimeout(r, 150));
        const frame = await screenshotCaptcha(session.page);
        if (ws.readyState === 1) {
          if (frame.found) {
            ws.send(JSON.stringify({ type: "frame", screenshot: frame.screenshot, bounds: frame.bounds }));
          } else {
            ws.send(JSON.stringify({ type: "captcha-gone" }));
            if (mirrorInterval) { clearInterval(mirrorInterval); mirrorInterval = null; }
          }
        }

        clickLock = false;
      }

      if (msg.type === "stop-mirror") {
        if (mirrorInterval) { clearInterval(mirrorInterval); mirrorInterval = null; }
      }

    } catch (e) { console.error("[WS] Error:", e.message); }
  });

  ws.on("close", () => {
    if (mirrorInterval) { clearInterval(mirrorInterval); mirrorInterval = null; }
  });
});

// ============================================================
// ARRANQUE
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`Mobilize Puppeteer + WS → http://localhost:${PORT}`);
  console.log("[POOL] Pre-calentando...");
  fillPool().catch((e) => console.error("[POOL]", e.message));
});
