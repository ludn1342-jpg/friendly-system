const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Servir index.html y estáticos desde la raíz del proyecto
app.use(express.static(path.join(__dirname)));

// ============================================================
// MOBILIZE FINANCIAL SERVICES - Configuración
// (extraída del bundle Angular: main.342933d549d312c4.js)
// ============================================================

const MOBILIZE = {
  baseUrl: "https://pmz.mfs.bank4us.co",
  tenantId: "1111111",
  endpoints: {
    getUserInfo: "oracle/get-user-info",
    otpRequest: "otp/request",
    otpVerify: "otp/verify",
    generatePaymentLink: "paymentez/generate-link-to-pay",
  },
  headers: {
    wafToken: "x-aws-waf-token",
    stepUpToken: "X-Step-Up-Token",
  },
};

function mobilizeUrl(endpoint) {
  return `${MOBILIZE.baseUrl}/${MOBILIZE.tenantId}/${endpoint}`;
}

function mobilizeHeaders(wafToken, stepUpToken) {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (wafToken) h[MOBILIZE.headers.wafToken] = wafToken;
  if (stepUpToken) h[MOBILIZE.headers.stepUpToken] = stepUpToken;
  return h;
}

// ============================================================
// MOBILIZE ENDPOINTS
// ============================================================

// POST /api/mobilize/credit-info
app.post("/api/mobilize/credit-info", async (req, res) => {
  try {
    const { creditNumber, wafToken } = req.body;
    if (!creditNumber) return res.status(400).json({ error: "creditNumber es requerido" });
    if (!wafToken) return res.status(400).json({ error: "wafToken es requerido" });

    const resp = await axios.post(
      mobilizeUrl(MOBILIZE.endpoints.getUserInfo),
      { creditNumber, forceRequest: true, chanel: "test" },
      { headers: mobilizeHeaders(wafToken) }
    );
    res.json(resp.data);
  } catch (err) {
    console.error("Error /credit-info:", err.message);
    res.status(err.response?.status || 500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// POST /api/mobilize/otp/request
app.post("/api/mobilize/otp/request", async (req, res) => {
  try {
    const { creditNumber, wafToken, medium } = req.body;
    if (!creditNumber || !wafToken) return res.status(400).json({ error: "creditNumber y wafToken son requeridos" });

    const resp = await axios.post(
      mobilizeUrl(MOBILIZE.endpoints.otpRequest),
      { creditNumber, medium: medium || "sms", type: "payment" },
      { headers: mobilizeHeaders(wafToken) }
    );
    res.json(resp.data);
  } catch (err) {
    console.error("Error /otp/request:", err.message);
    res.status(err.response?.status || 500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// POST /api/mobilize/otp/verify
app.post("/api/mobilize/otp/verify", async (req, res) => {
  try {
    const { creditNumber, code, wafToken } = req.body;
    if (!creditNumber || !code || !wafToken) return res.status(400).json({ error: "creditNumber, code y wafToken son requeridos" });

    const resp = await axios.post(
      mobilizeUrl(MOBILIZE.endpoints.otpVerify),
      { creditNumber, code },
      { headers: mobilizeHeaders(wafToken) }
    );
    res.json(resp.data);
  } catch (err) {
    console.error("Error /otp/verify:", err.message);
    res.status(err.response?.status || 500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// POST /api/mobilize/payment-link
app.post("/api/mobilize/payment-link", async (req, res) => {
  try {
    const { paymentData, wafToken, stepUpToken } = req.body;
    if (!paymentData || !wafToken) return res.status(400).json({ error: "paymentData y wafToken son requeridos" });

    const resp = await axios.post(
      mobilizeUrl(MOBILIZE.endpoints.generatePaymentLink),
      paymentData,
      { headers: mobilizeHeaders(wafToken, stepUpToken) }
    );
    res.json(resp.data);
  } catch (err) {
    console.error("Error /payment-link:", err.message);
    res.status(err.response?.status || 500).json({
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mobilize API Proxy → http://localhost:${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /api/mobilize/credit-info`);
  console.log(`  POST /api/mobilize/otp/request`);
  console.log(`  POST /api/mobilize/otp/verify`);
  console.log(`  POST /api/mobilize/payment-link`);
});