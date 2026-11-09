/**
 * Resolvedor de CAPTCHA local usando MobileNet (clasificación de imágenes)
 * Sin servicios externos — todo corre en el servidor.
 */
const sharp = require("sharp");
let pipeline = null;
let classifier = null;

// Mapeo: texto del CAPTCHA en español → clases ImageNet que MobileNet reconoce
const CAPTCHA_MAP = {
  cama: ["bed", "studio_couch", "four-poster", "cradle"],
  camas: ["bed", "studio_couch", "four-poster", "cradle"],
  autobus: ["bus", "school_bus", "trolleybus", "minibus"],
  autobuses: ["bus", "school_bus", "trolleybus", "minibus"],
  bus: ["bus", "school_bus", "trolleybus", "minibus"],
  buses: ["bus", "school_bus", "trolleybus", "minibus"],
  semaforo: ["traffic_light"],
  semaforos: ["traffic_light"],
  bicicleta: ["bicycle-built-for-two", "mountain_bike"],
  bicicletas: ["bicycle-built-for-two", "mountain_bike"],
  moto: ["motorcycle", "moped"],
  motos: ["motorcycle", "moped"],
  motocicleta: ["motorcycle", "moped"],
  motocicletas: ["motorcycle", "moped"],
  auto: ["car_wheel", "sports_car", "convertible", "limousine", "minivan", "cab"],
  autos: ["car_wheel", "sports_car", "convertible", "limousine", "minivan", "cab"],
  carro: ["car_wheel", "sports_car", "convertible", "limousine", "minivan", "cab"],
  carros: ["car_wheel", "sports_car", "convertible", "limousine", "minivan", "cab"],
  vehiculo: ["car_wheel", "sports_car", "convertible", "minivan", "cab"],
  camion: ["trailer_truck", "moving_van", "tow_truck", "garbage_truck"],
  camiones: ["trailer_truck", "moving_van", "tow_truck", "garbage_truck"],
  avion: ["airliner", "warplane"],
  aviones: ["airliner", "warplane"],
  barco: ["speedboat", "sailboat", "catamaran", "liner"],
  barcos: ["speedboat", "sailboat", "catamaran", "liner"],
  puente: ["bridge", "viaduct", "steel_arch_bridge", "suspension_bridge"],
  puentes: ["bridge", "viaduct", "steel_arch_bridge", "suspension_bridge"],
  escalera: ["stairway"],
  escaleras: ["stairway"],
  chimenea: ["chimney"],
  chimeneas: ["chimney"],
  hidrante: ["fire_hydrant"],
  hidrantes: ["fire_hydrant"],
  palmera: ["coconut", "date"],
  palmeras: ["coconut", "date"],
  montana: ["alp", "volcano"],
  montanas: ["alp", "volcano"],
  taxi: ["cab"],
  taxis: ["cab"],
  tren: ["electric_locomotive", "steam_locomotive", "bullet_train"],
  trenes: ["electric_locomotive", "steam_locomotive", "bullet_train"],
  barco: ["liner", "speedboat", "sailboat", "canoe"],
  crucero: ["liner"],
  helicoptero: ["helicopter"],
};

// Cargar modelo (se cachea después de la primera carga)
async function getClassifier() {
  if (!classifier) {
    console.log("[SOLVER] Cargando modelo MobileNet...");
    const { pipeline: pipelineFn } = await import("@xenova/transformers");
    pipeline = pipelineFn;
    classifier = await pipeline("image-classification", "Xenova/mobilenet_v2_1.0_224", {
      quantized: true, // Usa versión cuantizada (más ligera)
    });
    console.log("[SOLVER] Modelo cargado ✓");
  }
  return classifier;
}

// Pre-cargar modelo al iniciar
async function preloadModel() {
  try {
    await getClassifier();
  } catch (e) {
    console.error("[SOLVER] Error precargando modelo:", e.message);
  }
}

/**
 * Extraer la categoría objetivo del texto del CAPTCHA
 * "Elija todo las camas" → "camas" → ["bed", "studio_couch", ...]
 */
function parseTargetFromText(text) {
  const clean = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Quitar acentos
    .trim();

  console.log("[SOLVER] Texto CAPTCHA:", clean);

  // Buscar la última palabra significativa del texto
  for (const [key, classes] of Object.entries(CAPTCHA_MAP)) {
    if (clean.includes(key)) {
      console.log("[SOLVER] Categoría detectada:", key, "→", classes);
      return { keyword: key, classes };
    }
  }

  // Fallback: extraer última palabra
  const words = clean.split(/\s+/);
  const lastWord = words[words.length - 1];
  if (CAPTCHA_MAP[lastWord]) {
    return { keyword: lastWord, classes: CAPTCHA_MAP[lastWord] };
  }

  console.log("[SOLVER] No se reconoció la categoría del CAPTCHA");
  return null;
}

/**
 * Clasificar una imagen de tile
 * Retorna true si el tile contiene el objeto buscado
 */
async function classifyTile(imageBuffer, targetClasses) {
  const clf = await getClassifier();

  // Redimensionar a 224x224 para MobileNet
  const resized = await sharp(imageBuffer)
    .resize(224, 224, { fit: "cover" })
    .png()
    .toBuffer();

  // Crear blob-like para transformers.js
  const blob = new Blob([resized], { type: "image/png" });

  const results = await clf(blob, { topk: 10 });

  // Verificar si alguna de las predicciones top coincide con las clases objetivo
  for (const pred of results) {
    const predLabel = pred.label.toLowerCase().replace(/[\s,]+/g, "_");
    for (const target of targetClasses) {
      if (
        predLabel.includes(target.toLowerCase()) ||
        target.toLowerCase().includes(predLabel)
      ) {
        console.log(
          `[SOLVER] ✓ Match: "${pred.label}" (${(pred.score * 100).toFixed(1)}%) ≈ "${target}"`
        );
        return { match: true, score: pred.score, label: pred.label };
      }
    }
  }

  console.log(`[SOLVER] ✗ No match. Top: "${results[0]?.label}" (${(results[0]?.score * 100).toFixed(1)}%)`);
  return { match: false, score: 0, label: results[0]?.label || "unknown" };
}

/**
 * Resolver CAPTCHA en una página de Puppeteer
 * @param {Page} page - Puppeteer page
 * @returns {boolean} true si se resolvió
 */
async function solveCaptcha(page) {
  console.log("[SOLVER] Buscando CAPTCHA en la página...");

  // Buscar el CAPTCHA frame (puede estar en un iframe)
  let captchaFrame = page;

  // Buscar en iframes
  for (const frame of page.frames()) {
    const url = frame.url();
    if (url.includes("captcha") || url.includes("challenge") || url.includes("waf")) {
      captchaFrame = frame;
      console.log("[SOLVER] CAPTCHA encontrado en iframe:", url);
      break;
    }
  }

  // Intentar hasta 3 veces
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[SOLVER] Intento ${attempt}/3`);

    try {
      const solved = await attemptSolve(captchaFrame, page);
      if (solved) {
        console.log("[SOLVER] ¡CAPTCHA resuelto! ✓");
        return true;
      }
    } catch (err) {
      console.error(`[SOLVER] Error intento ${attempt}:`, err.message);
    }

    // Esperar antes de reintentar
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log("[SOLVER] No se pudo resolver el CAPTCHA después de 3 intentos");
  return false;
}

async function attemptSolve(frame, page) {
  // 1. Extraer el texto de instrucción del CAPTCHA
  const instructionText = await frame.evaluate(() => {
    // Buscar el texto de instrucción
    const selectors = [
      ".waf-captcha-instructions",
      "[class*='instruction']",
      "[class*='prompt']",
      "[class*='captcha'] h2",
      "[class*='captcha'] p",
      "[class*='captcha'] span",
      "[class*='challenge'] h2",
      "[class*='challenge'] p",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 5) {
        return el.innerText.trim();
      }
    }

    // Buscar cualquier texto que contenga "elija" o "seleccione"
    const allText = document.body.innerText.toLowerCase();
    const match = allText.match(/(elija|seleccione|select|choose)[^\n.]+/i);
    return match ? match[0] : null;
  });

  if (!instructionText) {
    console.log("[SOLVER] No se encontró texto de instrucción");
    return false;
  }

  // 2. Parsear la categoría objetivo
  const target = parseTargetFromText(instructionText);
  if (!target) {
    console.log("[SOLVER] Categoría no reconocida");
    return false;
  }

  // 3. Encontrar los tiles del CAPTCHA
  const tiles = await frame.evaluate(() => {
    const tileElements = document.querySelectorAll(
      "[class*='tile'] img, [class*='grid'] img, [class*='captcha'] img, [class*='challenge'] img, .task-image img"
    );

    if (tileElements.length === 0) {
      // Fallback: buscar todas las imágenes en el contenedor del CAPTCHA
      const container =
        document.querySelector("[class*='captcha']") ||
        document.querySelector("[class*='challenge']") ||
        document.querySelector("[class*='grid']");

      if (container) {
        const imgs = container.querySelectorAll("img");
        return Array.from(imgs).map((img, i) => ({
          index: i,
          x: img.getBoundingClientRect().x + img.getBoundingClientRect().width / 2,
          y: img.getBoundingClientRect().y + img.getBoundingClientRect().height / 2,
          width: img.getBoundingClientRect().width,
          height: img.getBoundingClientRect().height,
          src: img.src,
        }));
      }
      return [];
    }

    return Array.from(tileElements).map((img, i) => ({
      index: i,
      x: img.getBoundingClientRect().x + img.getBoundingClientRect().width / 2,
      y: img.getBoundingClientRect().y + img.getBoundingClientRect().height / 2,
      width: img.getBoundingClientRect().width,
      height: img.getBoundingClientRect().height,
      src: img.src,
    }));
  });

  if (tiles.length === 0) {
    console.log("[SOLVER] No se encontraron tiles");
    return false;
  }

  console.log(`[SOLVER] ${tiles.length} tiles encontrados`);

  // 4. Clasificar cada tile
  const matchingTiles = [];

  for (const tile of tiles) {
    try {
      // Descargar la imagen del tile
      let imageBuffer;

      if (tile.src.startsWith("data:")) {
        // Data URL
        const base64 = tile.src.split(",")[1];
        imageBuffer = Buffer.from(base64, "base64");
      } else {
        // URL normal — screenshot del tile
        const screenshot = await frame.screenshot({
          clip: {
            x: tile.x - tile.width / 2,
            y: tile.y - tile.height / 2,
            width: tile.width,
            height: tile.height,
          },
          type: "png",
        });
        imageBuffer = screenshot;
      }

      const result = await classifyTile(imageBuffer, target.classes);
      if (result.match) {
        matchingTiles.push(tile);
      }
    } catch (err) {
      console.log(`[SOLVER] Error clasificando tile ${tile.index}:`, err.message);
    }
  }

  console.log(`[SOLVER] ${matchingTiles.length}/${tiles.length} tiles coinciden con "${target.keyword}"`);

  if (matchingTiles.length === 0) {
    console.log("[SOLVER] Ningún tile coincide — seleccionando por probabilidad");
    return false;
  }

  // 5. Click en los tiles que coinciden
  for (const tile of matchingTiles) {
    await frame.mouse.click(tile.x, tile.y);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 200));
  }

  // 6. Click en el botón de submit/verify del CAPTCHA
  await new Promise((r) => setTimeout(r, 500));

  const submitted = await frame.evaluate(() => {
    const btns = document.querySelectorAll(
      "button[type='submit'], [class*='submit'], [class*='verify'], [class*='next'], [class*='continue']"
    );
    for (const btn of btns) {
      if (btn.offsetHeight > 0) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!submitted) {
    // Intentar presionar Enter
    await frame.keyboard.press("Enter");
  }

  // 7. Esperar a ver si el CAPTCHA desaparece
  await new Promise((r) => setTimeout(r, 3000));

  // Verificar si el CAPTCHA sigue presente
  const stillHasCaptcha = await page.evaluate(() => {
    const c = document.querySelector(
      "[class*='captcha'], [class*='challenge'], iframe[src*='captcha']"
    );
    return c && c.offsetHeight > 0;
  });

  return !stillHasCaptcha;
}

module.exports = { solveCaptcha, preloadModel, parseTargetFromText };
