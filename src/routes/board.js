const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { toDate } = require("../text");

const router = express.Router();
router.use(requireAuth);
const admin = requireRole("admin");
const KINDS = ["holiday", "exam", "activity", "meeting", "other"];
const AUDIENCES = ["all", "teachers", "parents"];

// ---- announcements: everyone sees the ones meant for them ----
router.get("/announcements", async (req, res) => {
  const role = req.user.role;
  try {
    const r = await pool.query(
      `SELECT id, title, body, audience, pinned, to_char(created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS posted_on
       FROM announcements WHERE school_id = $1 AND ($2 = 'admin' OR audience = 'all' OR audience = $3)
       ORDER BY pinned DESC, created_at DESC LIMIT 60`,
      [req.user.schoolId, role, role === "teacher" ? "teachers" : role === "parent" ? "parents" : "all"]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the notices" }); }
});

router.post("/announcements", admin, async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Write a title" });
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : "all";
  try {
    const r = await pool.query(
      "INSERT INTO announcements (school_id, title, body, audience, pinned, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.user.schoolId, title.slice(0, 200), String(req.body.body || "").slice(0, 4000) || null, audience, !!req.body.pinned, req.user.id]);
    res.status(201).json({ id: r.rows[0].id });
  } catch { res.status(500).json({ error: "Could not post the notice" }); }
});

router.patch("/announcements/:id", admin, async (req, res) => {
  try {
    await pool.query("UPDATE announcements SET pinned = $1 WHERE id = $2 AND school_id = $3", [!!req.body.pinned, req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not update the notice" }); }
});

router.delete("/announcements/:id", admin, async (req, res) => {
  try { await pool.query("DELETE FROM announcements WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]); res.status(204).end(); }
  catch { res.status(500).json({ error: "Could not delete the notice" }); }
});

// ---- the school calendar (holidays, exams, activities): everyone in the school can read it ----
router.get("/calendar", async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  try {
    const r = await pool.query(
      `SELECT id, title, kind, details, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date
       FROM calendar_events WHERE school_id = $1 AND start_date <= $3::date AND end_date >= $2::date ORDER BY start_date, title`,
      [req.user.schoolId, `${year}-01-01`, `${year}-12-31`]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the calendar" }); }
});

router.post("/calendar", admin, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const start = toDate(req.body.startDate), end = toDate(req.body.endDate || req.body.startDate);
  if (!title) return res.status(400).json({ error: "Write what the event is" });
  if (!start || !end || end < start) return res.status(400).json({ error: "Check the dates: the last day cannot be before the first day" });
  try {
    const r = await pool.query(
      "INSERT INTO calendar_events (school_id, title, kind, start_date, end_date, details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.user.schoolId, title.slice(0, 200), KINDS.includes(req.body.kind) ? req.body.kind : "other", start, end, String(req.body.details || "").slice(0, 1000) || null]);
    res.status(201).json({ id: r.rows[0].id });
  } catch { res.status(500).json({ error: "Could not save the event" }); }
});

router.delete("/calendar/:id", admin, async (req, res) => {
  try { await pool.query("DELETE FROM calendar_events WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]); res.status(204).end(); }
  catch { res.status(500).json({ error: "Could not delete the event" }); }
});

module.exports = router;
