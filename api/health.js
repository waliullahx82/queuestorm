// GET /health  -> simple, fast health response (spec section 1, < 10s).
// Vercel serverless function. No LLM call, no dependencies.

module.exports = (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "queuestorm-ticket-sorter",
    time: new Date().toISOString(),
  });
};
