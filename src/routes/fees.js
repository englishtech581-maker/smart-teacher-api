const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));

// Put a fee on every student (or one section) for a month, e.g. "Tuition fee" 3000 for 2026-11.
// Running it twice for the same fee and month does not charge anybody twice.
router.post("/generate", async (req, res) => {
  const { month, sectionId } = req.body;
  const title = String(req.body.title || "Tuition fee").trim();
  const amount = Number(req.body.amount);
  if (!isMonth(month)) return res.status(400).json({ error: "Choose the month" });
  if (!(amount > 0)) return res.status(400).json({ error: "Enter the fee amount" });
  try {
    const r = await pool.query(
      `INSERT INTO fee_charges (school_id, student_id, title, month, amount)
       SELECT $1, s.id, $2, $3, $4 FROM students s WHERE s.school_id = $1 AND ($5::uuid IS NULL OR s.section_id = $5::uuid)
       ON CONFLICT (student_id, title, month) DO NOTHING`,
      [req.user.schoolId, title, month, amount, sectionId || null]
    );
    res.json({ created: r.rowCount });
  } catch { res.status(500).json({ error: "Could not create the fees" }); }
});

// Fee ledger for a month with what is paid and what is left.
router.get("/ledger", async (req, res) => {
  const { month, sectionId, status, q } = req.query;
  const params = [req.user.schoolId];
  let where = "c.school_id = $1";
  if (isMonth(month)) { params.push(month); where += ` AND c.month = $${params.length}`; }
  if (sectionId) { params.push(sectionId); where += ` AND s.section_id = $${params.length}`; }
  if (q) { params.push(`%${q}%`); where += ` AND (s.name ILIKE $${params.length} OR s.admission_no ILIKE $${params.length})`; }
  try {
    const r = await pool.query(
      `SELECT c.id, c.title, c.month, c.amount::float AS amount, s.id AS student_id, s.name, s.admission_no, sec.grade, sec.name AS section,
              COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id), 0)::float AS paid
       FROM fee_charges c JOIN students s ON s.id = c.student_id LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE ${where} ORDER BY sec.grade, sec.name, s.name LIMIT 1000`,
      params
    );
    let rows = r.rows.map((x) => ({ ...x, balance: x.amount - x.paid }));
    if (status === "unpaid") rows = rows.filter((x) => x.balance > 0);
    if (status === "paid") rows = rows.filter((x) => x.balance <= 0);
    res.json(rows);
  } catch { res.status(500).json({ error: "Could not load the fee ledger" }); }
});

router.get("/summary", async (req, res) => {
  const { month } = req.query;
  const params = [req.user.schoolId];
  let where = "c.school_id = $1";
  if (isMonth(month)) { params.push(month); where += ` AND c.month = $2`; }
  try {
    const t = await pool.query(
      `SELECT COALESCE(SUM(c.amount),0)::float AS due,
              COALESCE(SUM((SELECT COALESCE(SUM(p.amount),0) FROM fee_payments p WHERE p.charge_id = c.id)),0)::float AS collected,
              COUNT(*) AS charges
       FROM fee_charges c WHERE ${where}`, params);
    const top = await pool.query(
      `SELECT s.name, sec.grade, sec.name AS section, (c.amount - COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id),0))::float AS balance
       FROM fee_charges c JOIN students s ON s.id = c.student_id LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE ${where} ORDER BY balance DESC LIMIT 10`, params);
    const x = t.rows[0];
    res.json({ due: x.due, collected: x.collected, outstanding: x.due - x.collected, charges: Number(x.charges), topUnpaid: top.rows.filter((r) => r.balance > 0) });
  } catch { res.status(500).json({ error: "Could not load the summary" }); }
});

router.post("/payments", async (req, res) => {
  const { chargeId, method, note } = req.body;
  const amount = Number(req.body.amount);
  if (!chargeId || !(amount > 0)) return res.status(400).json({ error: "Enter the amount received" });
  try {
    const c = await pool.query(
      `SELECT c.amount::float AS amount, COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id),0)::float AS paid
       FROM fee_charges c WHERE c.id = $1 AND c.school_id = $2`, [chargeId, req.user.schoolId]);
    if (c.rowCount === 0) return res.status(404).json({ error: "Fee not found" });
    const left = c.rows[0].amount - c.rows[0].paid;
    if (amount > left + 0.001) return res.status(400).json({ error: `Only ${left} is left to pay on this fee` });
    await pool.query("INSERT INTO fee_payments (charge_id, amount, method, note, paid_on) VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE))",
      [chargeId, amount, method || null, note || null, req.body.paidOn || null]);
    res.status(201).json({ balance: left - amount });
  } catch { res.status(500).json({ error: "Could not record the payment" }); }
});

router.delete("/charges/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM fee_charges WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not delete the fee" }); }
});

module.exports = router;
