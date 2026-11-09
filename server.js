process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MOBILIZE_URL = "https://www.mobilize-fs.com.co/portal-pagos/";
const PROXY_USER = "geonode_PKlL1yvoTG-country-co";
const PROXY_PASS = "605d224e-19b6-4baa-8107-296ee7d836f5";
const PROXY_HOST = "proxy.geonode.io";
const PROXY_PORT = 9000;
const COOKIES_FILE = path.join(__dirname, "waf-cookies.json");

// ── Sesiones activas ──
const sessions = new Map();

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ── Cookies persistentes del WAF ──
function loadSavedCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
      console.log("[COOKIES] Cookies guardadas encontradas, edad:", Math.round((Date.now() - data.savedAt) / 1000), "seg");
      return data.cookies;
    }
  } catch (e) {
    console.log("[COOKIES] Error leyendo cookies:", e.message);
  }
  return null;
}

function saveCookies(cookies) {
  try {
    fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies, savedAt: Date.now() }));
    console.log("[COOKIES] Cookies guardadas ✓");
  } catch (e) {
    console.log("[COOKIES] Error guardando cookies:", e.message);
  }
}

// ── Lanzar navegador ──
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

  return puppeteer.launch({
    headless: "new",
    executablePath: execPath,
    args,
    ignoreHTTPSErrors: true,
  });
}

// ── Navegar con cookies guardadas (bypass rápido) ──
async function navigateWithCookies(page) {
  const saved = loadSavedCookies();

  if (saved && saved.length > 0) {
    console.log("[NAV] Inyectando cookies guardadas...");
    await page.setCookie(...saved);
  }

  console.log("[NAV] Navegando a Mobilize...");
  await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // Esperar a que cargue
  await new Promise((r) => setTimeout(r, 3000));

  // Verificar si pasó el WAF (si hay campo de crédito = pasó)
  const hasForm = await page.evaluate(() => {
    const selectors = [
      "#otp-contract",
      "input[formcontrolname='idProcess']",
      "input[placeholder*='crédito']",
      "input[placeholder*='Crédito']",
      "input[placeholder*='contrato']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetHeight > 0) return true;
    }
    return false;
  });

  if (hasForm) {
    console.log("[NAV] ✓ Pasó el WAF directo — sin CAPTCHA");
    // Guardar cookies actualizadas
    const freshCookies = await page.cookies();
    saveCookies(freshCookies);
    return true;
  }

  // Verificar si hay CAPTCHA o challenge
  const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log("[NAV] Página no tiene formulario. Contenido:", pageContent.substring(0, 200));

  // Verificar si es un challenge silencioso (JS challenge, no CAPTCHA visual)
  const hasChallenge = await page.evaluate(() => {
    return !!(
      document.querySelector("script[src*='challenge.js']") ||
      document.querySelector("script[src*='captcha.js']") ||
      document.body.innerHTML.includes("aws-waf") ||
      document.body.innerHTML.includes("challenge")
    );
  });

  if (hasChallenge) {
    console.log("[NAV] Challenge JS detectado — esperando resolución automática...");
    // Puppeteer Stealth a veces resuelve el JS challenge solo
    // Esperar hasta 15 segundos a que se resuelva
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 3000));

      const resolved = await page.evaluate(() => {
        const selectors = [
          "#otp-contract",
          "input[formcontrolname='idProcess']",
          "input[placeholder*='crédito']",
          "input[type='text']",
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetHeight > 0) return true;
        }
        return false;
      });

      if (resolved) {
        console.log("[NAV] ✓ Challenge resuelto automáticamente");
        const freshCookies = await page.cookies();
        saveCookies(freshCookies);
        return true;
      }

      // Verificar si redirigió (challenge exitoso = recarga)
      const url = page.url();
      if (url.includes("portal-pagos")) {
        // Intentar recargar
        await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // Si hay CAPTCHA visual, intentar con el solver
  const hasCaptcha = await page.evaluate(() => {
    return !!(
      document.querySelector("[class*='captcha']") ||
      document.querySelector("iframe[src*='captcha']") ||
      document.querySelector("#captcha-container") ||
      document.body.innerHTML.includes("captcha")
    );
  });

  if (hasCaptcha) {
    console.log("[NAV] CAPTCHA visual detectado — intentando resolver...");
    try {
      const { solveCaptcha } = require("./captcha-solver");
      const solved = await solveCaptcha(page);
      if (solved) {
        console.log("[NAV] ✓ CAPTCHA resuelto");
        const freshCookies = await page.cookies();
        saveCookies(freshCookies);
        return true;
      }
    } catch (e) {
      console.log("[NAV] Error con solver:", e.message);
    }
  }

  // Último intento: recargar y esperar
  console.log("[NAV] Último intento — recargando página...");
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 5000));

  const finalCheck = await page.evaluate(() => {
    const el = document.querySelector("#otp-contract") ||
      document.querySelector("input[formcontrolname='idProcess']") ||
      document.querySelector("input[type='text']");
    return el && el.offsetHeight > 0;
  });

  if (finalCheck) {
    console.log("[NAV] ✓ Pasó después de recarga");
    const freshCookies = await page.cookies();
    saveCookies(freshCookies);
    return true;
  }

  console.log("[NAV] ✗ No se pudo pasar el WAF");
  return false;
}

// ── Archivos estáticos ──
app.use(express.static(path.join(__dirname)));

// ══════════════════════════════════════════
// POST /api/start  { creditNumber }
// ══════════════════════════════════════════
app.post("/api/start", async (req, res) => {
  const { creditNumber } = req.body;
  if (!creditNumber) return res.status(400).json({ error: "creditNumber requerido" });

  const sessionId = generateId();
  console.log(`\n[${sessionId}] ═══ Nueva sesión — crédito: ${creditNumber} ═══`);

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

    // ═══ INTERCEPTAR AwsWafCaptcha ANTES de navegar ═══
    // Esto captura el callback onSuccess que Angular registra cuando renderiza el captcha
    await page.evaluateOnNewDocument(() => {
      window.__wafCaptchaIntercepted = false;
      window.__wafOnSuccess = null;
      window.__wafOnError = null;

      // Interceptar cuando AwsWafCaptcha se carga
      let _awsWafCaptcha = undefined;
      Object.defineProperty(window, "AwsWafCaptcha", {
        configurable: true,
        enumerable: true,
        get() { return _awsWafCaptcha; },
        set(val) {
          _awsWafCaptcha = val;
          if (val && typeof val.renderCaptcha === "function") {
            const originalRender = val.renderCaptcha.bind(val);
            val.renderCaptcha = function(container, config) {
              console.log("[INTERCEPT] renderCaptcha called, config keys:", Object.keys(config || {}));
              // Guardar callbacks
              if (config) {
                if (config.onSuccess) window.__wafOnSuccess = config.onSuccess;
                if (config.onError) window.__wafOnError = config.onError;
                window.__wafCaptchaIntercepted = true;
                window.__wafCaptchaConfig = config;
              }
              // Ejecutar el original para que Angular no detecte error
              return originalRender(container, config);
            };
          }
        }
      });
    });
    console.log(`[${sessionId}] Interceptor WAF instalado`);

    // Navegar con bypass de cookies
    const passed = await navigateWithCookies(page);
    if (!passed) {
      throw new Error("No se pudo acceder a Mobilize. Intenta de nuevo en unos minutos.");
    }

    // Buscar campo de crédito
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

    if (!creditSelector) throw new Error("No se encontró el campo de crédito");
    console.log(`[${sessionId}] Campo: ${creditSelector}`);

    // Llenar crédito (Angular compatible — click + focus + type)
    await page.click(creditSelector);
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      if (input) { input.value = ""; input.focus(); }
    }, creditSelector);
    await page.type(creditSelector, creditNumber, { delay: 50 });
    // Disparar eventos Angular
    await page.evaluate((sel) => {
      const input = document.querySelector(sel);
      if (!input) return;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, creditSelector);

    console.log(`[${sessionId}] Crédito ingresado con page.type()`);
    await new Promise((r) => setTimeout(r, 2000));



    // Verificar estado del formulario
    const formState = await page.evaluate(() => {
      const form = document.querySelector("form");
      const btn = document.querySelector("button[type='submit']");
      return {
        formClass: form?.className || "no-form",
        btnDisabled: btn?.disabled,
        inputValue: document.querySelector("#otp-contract")?.value,
        intercepted: window.__wafCaptchaIntercepted,
        hasOnSuccess: typeof window.__wafOnSuccess === "function"
      };
    });
    console.log(`[${sessionId}] Estado formulario:`, JSON.stringify(formState));

    // ═══ RESOLVER CAPTCHA: Llamar onSuccess interceptado con token WAF ═══
    const captchaResult = await page.evaluate(async () => {
      const result = { method: "none", success: false };

      // ── Método 1: Callback interceptado ──
      if (window.__wafOnSuccess) {
        try {
          const token = await window.AwsWafIntegration.getToken();
          if (token) {
            window.__wafOnSuccess(token);
            result.method = "intercepted-onSuccess";
            result.success = true;
            result.tokenPreview = token.substring(0, 30);
            console.log("[CAPTCHA] ✓ onSuccess interceptado llamado con token");
            return result;
          }
        } catch (e) { result.error1 = e.message; }
      }

      // ── Método 2: Escanear componente Angular para FormControl/EventEmitter ──
      try {
        const captchaEl = document.querySelector("app-waf-captcha");
        if (captchaEl) {
          const scanEl = (el) => {
            if (!el.__ngContext__ || !Array.isArray(el.__ngContext__)) return;
            for (const item of el.__ngContext__) {
              if (!item || typeof item !== "object" || Array.isArray(item)) continue;
              const proto = Object.getPrototypeOf(item);
              if (!proto || proto.constructor === Object) continue;

              const keys = Object.keys(item);
              result.componentProps = keys.slice(0, 20);
              result.componentMethods = Object.getOwnPropertyNames(proto).filter(m => m !== "constructor").slice(0, 15);

              // Buscar FormControls
              for (const key of keys) {
                const val = item[key];
                if (val && typeof val === "object" && typeof val.setValue === "function" && typeof val.setErrors === "function") {
                  const token = "waf-bypass-token";
                  val.setValue(token);
                  val.setErrors(null);
                  if (val.markAsTouched) val.markAsTouched();
                  if (val.markAsDirty) val.markAsDirty();
                  result.method = `FormControl-${key}`;
                  result.success = true;
                  console.log(`[CAPTCHA] ✓ FormControl '${key}' forzado a válido`);
                }
              }

              // Buscar EventEmitters (outputs Angular)
              for (const key of keys) {
                const val = item[key];
                if (val && typeof val === "object" && typeof val.emit === "function" && typeof val.subscribe === "function") {
                  result.emitters = result.emitters || [];
                  result.emitters.push(key);
                }
              }
            }
          };
          scanEl(captchaEl);
          for (const child of captchaEl.children) scanEl(child);

          // Si encontramos emitters, disparar el de éxito con token
          if (result.emitters && result.emitters.length > 0 && !result.success) {
            for (const item of captchaEl.__ngContext__ || []) {
              if (!item || typeof item !== "object") continue;
              for (const emName of result.emitters) {
                if (item[emName] && typeof item[emName].emit === "function") {
                  try {
                    const token = await window.AwsWafIntegration.getToken();
                    item[emName].emit(token || true);
                    result.method = `emitter-${emName}`;
                    result.success = true;
                    console.log(`[CAPTCHA] ✓ EventEmitter '${emName}' disparado`);
                  } catch (e) {}
                }
              }
            }
          }
        }
      } catch (e) { result.error2 = e.message; }

      // ── Método 3: Forzar FormGroup padre ──
      if (!result.success) {
        try {
          const formEl = document.querySelector("form");
          if (formEl) {
            const scanForm = (el) => {
              if (!el.__ngContext__ || !Array.isArray(el.__ngContext__)) return;
              for (const item of el.__ngContext__) {
                if (item && typeof item === "object" && item.controls && typeof item.updateValueAndValidity === "function") {
                  Object.keys(item.controls).forEach(k => {
                    item.controls[k].setErrors(null);
                    if (item.controls[k].markAsTouched) item.controls[k].markAsTouched();
                    if (item.controls[k].markAsDirty) item.controls[k].markAsDirty();
                    if (item.controls[k].value == null || item.controls[k].value === "") {
                      item.controls[k].setValue("bypass");
                    }
                  });
                  item.updateValueAndValidity();
                  result.method = "FormGroup-nuclear";
                  result.formKeys = Object.keys(item.controls);
                  result.success = true;
                  console.log("[CAPTCHA] ✓ FormGroup limpiado, keys:", Object.keys(item.controls));
                }
              }
            };
            // Escanear form y sus ancestros
            let el = formEl;
            while (el && el !== document.body) {
              scanForm(el);
              if (result.success) break;
              el = el.parentElement;
            }
          }
        } catch (e) { result.error3 = e.message; }
      }

      return result;
    });
    console.log(`[${sessionId}] Captcha resolve:`, JSON.stringify(captchaResult));

    // Esperar a que Angular procese el cambio de validación
    await new Promise((r) => setTimeout(r, 3000));

    // Verificar si el form ahora es válido
    const formState2 = await page.evaluate(() => {
      const form = document.querySelector("form");
      const btn = document.querySelector("button[type='submit']");
      return {
        formClass: form?.className || "no-form",
        btnDisabled: btn?.disabled,
        btnText: btn?.innerText?.trim()
      };
    });
    console.log(`[${sessionId}] Form post-captcha:`, JSON.stringify(formState2));

    // Click Continuar (forzar si está disabled)
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector("button[type='submit']");
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute("disabled");
        btn.classList.remove("mat-button-disabled");
        btn.click();
      }
      const form = document.querySelector("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true }));
        form.dispatchEvent(new Event("ngSubmit", { bubbles: true }));
        try { form.requestSubmit(); } catch (e) {}
      }
      return btn ? "clicked" : false;
    });
    if (!clicked) throw new Error("No se encontró el botón Continuar");
    console.log(`[${sessionId}] Botón: ${clicked}`);

    // Esperar para que Angular procese y navegue al paso 2 (OTP)
    await new Promise((r) => setTimeout(r, 8000));

    // Verificar si la página cambió al paso OTP
    const postSubmit = await page.evaluate(() => {
      return {
        radioCount: document.querySelectorAll("mat-radio-button").length,
        hasRadioInputs: document.querySelectorAll("input[type='radio']").length,
        bodySnippet: document.body.innerText.substring(0, 500),
        url: window.location.href,
        formClass: document.querySelector("form")?.className || "no-form"
      };
    });
    console.log(`[${sessionId}] Post-submit:`, JSON.stringify(postSubmit));

    // Verificar errores
    const pageError = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(".error, .alert-danger, [class*='error'], mat-error, .mat-error");
      for (const el of errorEls) {
        if (el.offsetHeight > 0 && el.innerText.trim().length > 3) return el.innerText.trim();
      }
      return null;
    });
    if (pageError) throw new Error(`Error de Mobilize: ${pageError}`);

    // Extraer opciones OTP
    const otpOptions = await page.evaluate(() => {
      const options = [];
      // Buscar mat-radio-button (Angular Material)
      const radios = document.querySelectorAll("mat-radio-button");
      radios.forEach((radio, i) => {
        const label = radio.innerText.trim();
        if (label) {
          const lower = label.toLowerCase();
          const type = (lower.includes("celular") || lower.includes("sms") || lower.includes("móvil") || lower.includes("movil")) ? "sms" : "email";
          options.push({ index: i, label, type });
        }
      });
      // Fallback: input[type=radio]
      if (options.length === 0) {
        const inputs = document.querySelectorAll("input[type='radio']");
        inputs.forEach((input, i) => {
          const label = input.closest("label")?.innerText.trim() || document.querySelector(`label[for='${input.id}']`)?.innerText.trim() || `Opción ${i + 1}`;
          const lower = label.toLowerCase();
          const type = (lower.includes("celular") || lower.includes("sms") || lower.includes("móvil")) ? "sms" : "email";
          options.push({ index: i, label, type });
        });
      }
      // Fallback: buscar elementos con texto Correo/Celular que sean clickeables
      if (options.length === 0) {
        const allEls = document.querySelectorAll("[role='radio'], .mat-radio-button, [class*='radio'], [class*='option']");
        allEls.forEach((el, i) => {
          const label = el.innerText.trim();
          if (label && (label.includes("Correo") || label.includes("Celular") || label.includes("SMS") || label.includes("Email"))) {
            const lower = label.toLowerCase();
            const type = (lower.includes("celular") || lower.includes("sms")) ? "sms" : "email";
            options.push({ index: i, label, type });
          }
        });
      }
      return options;
    });

    console.log(`[${sessionId}] OTP options:`, otpOptions);
    res.json({ sessionId, otpOptions, success: true });
  } catch (err) {
    console.error(`[${sessionId}] Error:`, err.message);
    if (browser) try { await browser.close(); } catch (_) {}
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ══════════════════════════════════════════
// POST /api/select-otp
// ══════════════════════════════════════════
app.post("/api/select-otp", async (req, res) => {
  const { sessionId, optionIndex } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const { page } = session;
    // Click en la opción OTP seleccionada
    await page.evaluate((idx) => {
      const radios = document.querySelectorAll("mat-radio-button");
      if (radios[idx]) { radios[idx].click(); return; }
      const inputs = document.querySelectorAll("input[type='radio']");
      if (inputs[idx]) { inputs[idx].click(); return; }
      // Fallback: buscar por role o class
      const allOpts = document.querySelectorAll("[role='radio'], [class*='radio'], [class*='option']");
      if (allOpts[idx]) allOpts[idx].click();
    }, optionIndex);

    await new Promise((r) => setTimeout(r, 1000));

    // Click ENVIAR CÓDIGO (o Continuar/Siguiente)
    await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.innerText.trim().toUpperCase();
        if ((text.includes("ENVIAR") || text.includes("CONTINUAR") || text.includes("SIGUIENTE") || text.includes("SOLICITAR")) && !btn.disabled) {
          btn.click(); return;
        }
      }
      // Forzar click en submit si está disabled
      const submit = document.querySelector("button[type='submit']");
      if (submit) {
        if (submit.disabled) {
          submit.disabled = false;
          submit.classList.remove("mat-button-disabled");
          submit.removeAttribute("disabled");
        }
        submit.click();
      }
    });

    await new Promise((r) => setTimeout(r, 3000));
    res.json({ success: true, message: "OTP enviado" });
  } catch (err) {
    console.error(`[${sessionId}] Error select-otp:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/verify-otp
// ══════════════════════════════════════════
app.post("/api/verify-otp", async (req, res) => {
  const { sessionId, code } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Sesión no encontrada" });

  try {
    const { page } = session;
    const otpField = await page.evaluate(() => {
      const selectors = ["input[formcontrolname='otp']", "input[formcontrolname='code']", "input[formcontrolname='otpCode']", "input[placeholder*='código']", "input[placeholder*='OTP']", "input[type='text']", "input[type='number']"];
      for (const sel of selectors) { const el = document.querySelector(sel); if (el && el.offsetHeight > 0) return sel; }
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
        if ((text.includes("VERIFICAR") || text.includes("VALIDAR") || text.includes("CONFIRMAR") || text.includes("CONTINUAR")) && !btn.disabled) { btn.click(); return; }
      }
      const submit = document.querySelector("button[type='submit']");
      if (submit && !submit.disabled) submit.click();
    });

    await new Promise((r) => setTimeout(r, 5000));

    const pageError = await page.evaluate(() => {
      const errorEls = document.querySelectorAll(".error, .alert-danger, [class*='error'], mat-error");
      for (const el of errorEls) { if (el.offsetHeight > 0 && el.innerText.trim().length > 3) return el.innerText.trim(); }
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
// POST /api/extract
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
          if (next && next.innerText.trim()) value = next.innerText.trim();
          else if (parent) { for (const child of parent.querySelectorAll("span, dd, td, p, div")) { if (child !== el && child.innerText.trim()) { value = child.innerText.trim(); break; } } }
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
// POST /api/close
// ══════════════════════════════════════════
app.post("/api/close", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) { try { await session.browser.close(); } catch (_) {} sessions.delete(sessionId); }
  res.json({ success: true });
});

// ══════════════════════════════════════════
// POST /api/seed-cookies (llamar UNA VEZ manualmente para sembrar cookies)
// ══════════════════════════════════════════
app.post("/api/seed-cookies", async (req, res) => {
  console.log("[SEED] Sembrando cookies — abriendo Mobilize...");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 10000));

    // Esperar que el challenge JS se resuelva solo con stealth
    for (let i = 0; i < 10; i++) {
      const hasCookie = await page.evaluate(() => document.cookie.includes("aws-waf-token"));
      if (hasCookie) {
        const cookies = await page.cookies();
        saveCookies(cookies);
        await browser.close();
        return res.json({ success: true, message: "Cookies sembradas ✓", cookieCount: cookies.length });
      }
      console.log(`[SEED] Esperando token... intento ${i + 1}/10`);
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Guardar lo que haya
    const cookies = await page.cookies();
    saveCookies(cookies);
    await browser.close();
    res.json({ success: true, message: "Cookies guardadas (sin token WAF confirmado)", cookieCount: cookies.length });
  } catch (err) {
    if (browser) try { await browser.close(); } catch (_) {}
    console.error("[SEED] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
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

app.listen(PORT, () => {
  console.log(`✓ Servidor en puerto ${PORT}`);
  // Intentar sembrar cookies al iniciar
  console.log("  Sembrando cookies iniciales...");
  (async () => {
    try {
      const browser = await launchBrowser();
      const page = await browser.newPage();
      await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      await page.goto(MOBILIZE_URL, { waitUntil: "networkidle2", timeout: 60000 });
      await new Promise((r) => setTimeout(r, 8000));
      const cookies = await page.cookies();
      saveCookies(cookies);
      console.log(`  ✓ Cookies iniciales guardadas (${cookies.length})`);
      await browser.close();
    } catch (e) {
      console.log("  ⚠ No se pudieron sembrar cookies iniciales:", e.message);
    }
  })();
});
