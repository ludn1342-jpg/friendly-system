process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const cors = require("cors");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { solveCaptcha, preloadModel } = require("./captcha-solver");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

// ── Configuración ──
const PORT = process.env.PORT || 3000;
const MOBILIZE_URL = "https://www.mobilize-fs.com.co/portal-pagos/";
const PROXY_USER = "geonode_PKlL1yvoTG-country-co";
const PROXY_PASS = "605d224e-19b6-4baa-8107-296ee7d836f5";
const PROXY_HOST = "proxy.geonode.io";
const PROXY_PORT = 9000;

// ── Sesiones activas (sessionId → { browser, page }) ──
const sessions = new Map();

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Lanzar navegador con proxy ──
async function launchBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-web-security",
    "--disable-features=IsolateOrigins,site-per-process",
    `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
  ];

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: execPath,
    args,
    ignoreHTTPSErrors: true,
  });

  return browser;
}

// ── Archivos estáticos ──
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════
// POST /api/start  { creditNumber }
// ══════════════════════════════════════════
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) {
    return res.status(400).json({ error: "creditNumber requerido" });
  }

  const sessionId = generateId();
  console.log(`[${sessionId}] Iniciando sesión para crédito: ${creditNumber}`);

  let browser, page;

  try {
    browser = await launchBrowser();
    page = await browser.newPage();

    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    sessions.set(sessionId, { browser, page, creditNumber, createdAt: Date.now() });

    console.log(`[${sessionId}] Navegando a Mobilize...`);
    await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    console.log(`[${sessionId}] Página cargada`);

    await new Promise((r) => setTimeout(r, 3000));

    // Verificar CAPTCHA
    const hasCaptcha = await page.evaluate(() => {
      return !!(
        document.querySelector("[class*='captcha']") ||
        document.querySelector("[class*='waf']") ||
        document.querySelector("iframe[src*='captcha']") ||
        document.querySelector("#captcha-container")
      );
    });

    if (hasCaptcha) {
      console.log(`[${sessionId}] CAPTCHA detectado — resolviendo...`);
      const solved = await solveCaptcha(page);
      if (!solved) {
        throw new Error("No se pudo resolver el CAPTCHA automáticamente");
      }
      console.log(`[${sessionId}] CAPTCHA resuelto ✓`);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.log(`[${sessionId}] No se detectó CAPTCHA`);
    }

    // Buscar campo de crédito
    console.log(`[${sessionId}] Buscando campo de crédito...`);
    const creditSelector = await page.evaluate(() => {
      const selectors = [
        "#otp-contract",
        "input[formcontrolname='idProcess']",
        "input[placeholder*='crédito']",
        "input[placeholder*='Crédito']",
        "input[placeholder*='contrato']",
        "input[type='text']",
        "input[type='number']",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetHeight > 0) return sel;
      }
      return null;
    });

    if (!creditSelector) {
      throw new Error("No se encontró el campo de crédito");
    }

    console.log(`[${sessionId}] Campo encontrado: ${creditSelector}`);

    // Llenar crédito (Angular compatible)
    await page.evaluate(
      (sel, val) => {
        const input = document.querySelector(sel);
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      creditSelector,
      creditNumber
    );

    console.log(`[${sessionId}] Crédito ingresado`);
    await new Promise((r) => setTimeout(r, 500));

    // Click CONTINUAR
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.innerText.trim().toUpperCase();
        if (
          (text.includes("CONTINUAR") || text.includes("SIGUIENTE") || text.includes("ENVIAR")) &&
          !btn.disabled
        ) {
          btn.click();
          return true;
        }
      }
      const submit = document.querySelector("button[type='submit']");
      if (submit && !submit.disabled) {
        submit.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      throw new Error("No se encontró el botón CONTINUAR");
    }

    console.log(`[${sessionId}] Botón CONTINUAR clickeado`);
    await new Promise((r) => setTimeout(r, 5000));

    // Verificar errores
    const pageError = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(
        ".error, .alert-danger, [class*='error'], [class*='alert'], mat-error, .mat-error"
      );
      for (const el of errorEls) {
        if (el.offsetHeight > 0 && el.innerText.trim().length > 3) {
          return el.innerText.trim();
        }
      }
      return null;
    });

    if (pageError) {
      throw new Error(`Error de Mobilize: ${pageError}`);
    }

    // Extraer opciones OTP
    const otpOptions = await page.evaluate(() => {
      const options = [];
      const radios = document.querySelectorAll("mat-radio-button");
      radios.forEach((radio, i) => {
        const label = radio.innerText.trim();
        if (label) {
          options.push({ index: i, label, type: label.toLowerCase().includes("sms") ? "sms" : "email" });
        }
      });
      if (options.length === 0) {
        const inputs = document.querySelectorAll("input[type='radio']");
        inputs.forEach((input, i) => {
          const label =
            input.closest("label")?.innerText.trim() ||
            document.querySelector(`label[for='${input.id}']`)?.innerText.trim() ||
            `Opción ${i + 1}`;
          options.push({ index: i, label, type: label.toLowerCase().includes("sms") ? "sms" : "email" });
        });
      }
      return options;
    });

    console.log(`[${sessionId}] Opciones OTP:`, otpOptions);
    res.json({ sessionId, otpOptions, success: true });
  } catch (err) {
    console.error(`[${sessionId}] Error:`, err.message);
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ══════════════════════════════════════════
// POST /api/select-otp  { sessionId, optionIndex }
// ══════════════════════════════════════════
app.post("/api/select-otp", async (req, res) => {
  const { sessionId, optionIndex } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const { page } = session;

    await page.evaluate((idx) => {
      const radios = document.querySelectorAll("mat-radio-button");
      if (radios[idx]) { radios[idx].click(); return; }
      const inputs = document.querySelectorAll("input[type='radio']");
      if (inputs[idx]) inputs[idx].click();
    }, optionIndex);

    await new Promise((r) => setTimeout(r, 500));

    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.innerText.trim().toUpperCase();
        if ((text.includes("ENVIAR") || text.includes("CONTINUAR") || text.includes("SIGUIENTE") || text.includes("SOLICITAR")) && !btn.disabled) {
          btn.click(); return;
        }
      }
      const submit = document.querySelector("button[type='submit']");
      if (submit && !submit.disabled) submit.click();
    });

    await new Promise((r) => setTimeout(r, 3000));
    res.json({ success: true, message: "OTP enviado" });
  } catch (err) {
    console.error(`[${sessionId}] Error select-otp:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/verify-otp  { sessionId, code }
// ══════════════════════════════════════════
app.post("/api/verify-otp", async (req, res) => {
  const { sessionId, code } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const { page } = session;

    const otpField = await page.evaluate(() => {
      const selectors = [
        "input[formcontrolname='otp']",
        "input[formcontrolname='code']",
        "input[formcontrolname='otpCode']",
        "input[placeholder*='código']",
        "input[placeholder*='OTP']",
        "input[type='text']",
        "input[type='number']",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetHeight > 0) return sel;
      }
      return null;
    });

    if (!otpField) throw new Error("No se encontró el campo de código OTP");

    await page.evaluate((sel, val) => {
      const input = document.querySelector(sel);
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }, otpField, code);

    await new Promise((r) => setTimeout(r, 500));

    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.innerText.trim().toUpperCase();
        if ((text.includes("VERIFICAR") || text.includes("VALIDAR") || text.includes("CONFIRMAR") || text.includes("CONTINUAR")) && !btn.disabled) {
          btn.click(); return;
        }
      }
      const submit = document.querySelector("button[type='submit']");
      if (submit && !submit.disabled) submit.click();
    });

    await new Promise((r) => setTimeout(r, 5000));

    const pageError = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(".error, .alert-danger, [class*='error'], mat-error");
      for (const el of errorEls) {
        if (el.offsetHeight > 0 && el.innerText.trim().length > 3) return el.innerText.trim();
      }
      return null;
    });

    if (pageError) throw new Error(`Error OTP: ${pageError}`);
    res.json({ success: true, message: "OTP verificado" });
  } catch (err) {
    console.error(`[${sessionId}] Error verify-otp:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/extract  { sessionId }
// ══════════════════════════════════════════
app.post("/api/extract", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const { page } = session;

    const data = await page.evaluate(() => {
      const result = { fields: [] };
      const labels = document.querySelectorAll("label, .label, dt, th, span, p, h3, h4");
      labels.forEach((el) => {
        const text = el.innerText.trim();
        if (text.length > 0 && text.length < 200) {
          const next = el.nextElementSibling;
          const parent = el.parentElement;
          let value = "";
          if (next && next.innerText.trim()) {
            value = next.innerText.trim();
          } else if (parent) {
            const children = parent.querySelectorAll("span, dd, td, p, div");
            for (const child of children) {
              if (child !== el && child.innerText.trim()) { value = child.innerText.trim(); break; }
            }
          }
          if (value) result.fields.push({ label: text, value });
        }
      });
      const main = document.querySelector("mat-card") || document.querySelector(".card") || document.querySelector("[class*='payment']") || document.querySelector("main") || document.body;
      result.html = main.innerHTML;
      result.text = main.innerText;
      return result;
    });

    console.log(`[${sessionId}] Datos extraídos: ${data.fields?.length || 0} campos`);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[${sessionId}] Error extract:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/close  { sessionId }
// ══════════════════════════════════════════
app.post("/api/close", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    try { await session.browser.close(); } catch (_) {}
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

// Limpieza cada 10 min
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.createdAt && now - session.createdAt > 15 * 60 * 1000) {
      console.log(`[CLEANUP] Cerrando sesión ${id}`);
      try { session.browser.close(); } catch (_) {}
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ── Iniciar ──
app.listen(PORT, () => {
  console.log(`✓ Servidor en puerto ${PORT}`);
  console.log("  Precargando modelo MobileNet...");
  preloadModel();
});
