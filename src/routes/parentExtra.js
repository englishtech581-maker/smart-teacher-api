const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { parentOwns } = require("../access");
const { buildVoucher, monthPK } = require("../voucher");

const router = express.Router();
router.use(requireAuth, requireRole("parent"));

router.use("/child/:id", async (req, res, next) => {
  try {
    if (!(await parentOwns(req.user, req.params.id))) return res.status(403).json({ error: "This child is not linked to your account" });
    next();
  } catch { res.status(500).json({ error: "Could not check access" }); }
});

router.get("/child/:id/homework", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT h.id, h.subject, h.title, h.details, to_char(h.due_date,'YYYY-MM-DD') AS due_date, to_char(h.created_at,'YYYY-MM-DD') AS given_on
       FROM homework h JOIN students s ON s.section_id = h.section_id WHERE s.id = $1
       ORDER BY h.created_at DESC LIMIT 30`, [req.params.id]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load homework" }); }
});

router.get("/child/:id/fees", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.title, c.month, c.amount::float AS amount,
              COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id),0)::float AS paid
       FROM fee_charges c WHERE c.student_id = $1 ORDER BY c.month DESC, c.title`, [req.params.id]);
    const rows = r.rows.map((x) => ({ ...x, balance: x.amount - x.paid }));
    res.json({ rows, outstanding: rows.reduce((a, x) => a + x.balance, 0) });
  } catch { res.status(500).json({ error: "Could not load fees" }); }
});

router.get("/child/:id/timetable", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.day, t.period, t.subject, u.name AS teacher FROM timetable_slots t JOIN students s ON s.section_id = t.section_id
       LEFT JOIN users u ON u.id = t.teacher_id WHERE s.id = $1 ORDER BY t.day, t.period`, [req.params.id]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the timetable" }); }
});

router.get("/child/:id/voucher", async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : monthPK();
  try { res.json(await buildVoucher(req.params.id, month)); } catch { res.status(500).json({ error: "Could not build the voucher" }); }
});

// Months that have fees, and any reminder that has been sent for them.
router.get("/child/:id/vouchers", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.month, SUM(c.amount)::float AS amount,
              SUM(c.amount - COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id),0))::float AS balance,
              EXISTS (SELECT 1 FROM fee_notices n WHERE n.student_id = c.student_id AND n.month = c.month AND n.kind = 'reminder') AS reminded
       FROM fee_charges c WHERE c.student_id = $1 GROUP BY c.month, c.student_id ORDER BY c.month DESC LIMIT 12`, [req.params.id]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load vouchers" }); }
});

module.exports = router;
