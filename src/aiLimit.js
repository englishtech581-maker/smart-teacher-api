const pool = require("./db");

// Each person gets a daily number of AI requests, so a single user cannot run up the bill.
// Change the limit with AI_DAILY_LIMIT on the server (default 30).
async function spend(req, res) {
  const limit = Number(process.env.AI_DAILY_LIMIT) || 30;
  const r = await pool.query(
    `INSERT INTO ai_usage (user_id, day, count) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET count = ai_usage.count + 1
     RETURNING count`,
    [req.user.id]
  );
  if (r.rows[0].count > limit) {
    res.status(429).json({ error: `You have used today's ${limit} AI requests. Please try again tomorrow.` });
    return false;
  }
  return true;
}

module.exports = { spend };
