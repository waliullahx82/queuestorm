// Local development server for the QueueStorm backend.
//
// Reuses the REAL Vercel serverless functions in api/ (which call the real
// lib/ pipeline: classify -> handle -> gemini -> safety). No dependencies — it
// shims the small bit of the Vercel req/res contract the handlers rely on
// (req.body, res.status().json()) on top of Node's built-in http module.
//
// Routes mirror vercel.json:  GET /health  ·  POST /sort-ticket
//
//   node server.local.js                  # rules-only (no LLM)
//   GEMINI_API_KEY=xxx node server.local.js   # enables Gemini escalation
//
// Pair it with the frontend in web/ (which proxies these routes in dev).

const http = require("http");
const health = require("../api/health");
const sortTicket = require("../api/sort-ticket");

const PORT = process.env.PORT || 3001;

// Give the response object the tiny Express-like surface the handlers use.
function enhance(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer((req, res) => {
  // Permissive CORS so the frontend works even without the dev proxy.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  enhance(res);
  const url = (req.url || "").split("?")[0];

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    // Parse a JSON body the way Vercel populates req.body.
    if (body) { try { req.body = JSON.parse(body); } catch { req.body = body; } }
    try {
      if (url === "/health") return health(req, res);
      if (url === "/sort-ticket") return sortTicket(req, res);
      res.status(404).json({ error: "not_found" });
    } catch (err) {
      res.status(500).json({ error: "server_error", message: String(err && err.message) });
    }
  });
});

server.listen(PORT, () => {
  const llm = process.env.USE_LLM !== "false" && !!process.env.GEMINI_API_KEY;
  console.log(`\nQueueStorm backend (local)  →  http://localhost:${PORT}`);
  console.log(`   GET  /health`);
  console.log(`   POST /sort-ticket`);
  console.log(`   LLM: ${llm ? "enabled (Gemini escalation active)" : "disabled — rules-only (set GEMINI_API_KEY to enable)"}\n`);
});
