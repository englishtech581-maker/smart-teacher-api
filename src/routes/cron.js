const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { runAuto } = require("../feeauto");

const router = express.Router();

// A free scheduler (such as cron-job.org) opens this address once a day. It also wakes the sleeping server.
//   https://YOUR-SERVER/cron/daily?key=THE_SECRET        (the secret is CRON_SECRET in Render)
router.get("/daily", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET is not set on the server" });
  const a = Buffer.from(String(req.query.key || "")), b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong key" });
  const schools = (await pool.query("SELECT school_id FROM fee_settings WHERE auto_on = true")).rows;
  let ok = 0, failed = 0;
  const total = { charged: 0, vouchers: 0, reminders: 0, emailed: 0 };
  for (const s of schools) {
    try { const r = await runAuto(s.school_id); ok++; for (const k of Object.keys(total)) total[k] += r[k]; }
    catch (e) { failed++; console.error("Auto fees failed for a school:", e.message); }
  }
  res.json({ schools: ok, failed, ...total });
});

module.exports = router;
