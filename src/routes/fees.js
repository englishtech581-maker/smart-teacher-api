const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { runAuto } = require("../feeauto");
const { buildVoucher, monthPK } = require("../voucher");
const mailer = require("../mailer");

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

// ---- automatic monthly vouchers and reminders ----
router.get("/auto/settings", async (req, res) => {
  try {
    await pool.query("INSERT INTO fee_settings (school_id) VALUES ($1) ON CONFLICT DO NOTHING", [req.user.schoolId]);
    const set = (await pool.query("SELECT auto_on, due_day, reminder_days FROM fee_settings WHERE school_id = $1", [req.user.schoolId])).rows[0];
    const plans = (await pool.query(
      `SELECT p.id, p.title, p.amount::float AS amount, sec.grade, sec.name AS section FROM fee_plans p LEFT JOIN sections sec ON sec.id = p.section_id
       WHERE p.school_id = $1 ORDER BY p.title`, [req.user.schoolId])).rows;
    res.json({ settings: { autoOn: set.auto_on, dueDay: set.due_day, reminderDays: set.reminder_days }, plans, emailReady: mailer.configured() });
  } catch { res.status(500).json({ error: "Could not load the settings" }); }
});

router.put("/auto/settings", async (req, res) => {
  const dueDay = Number(req.body.dueDay), reminderDays = Number(req.body.reminderDays);
  if (!(dueDay >= 1 && dueDay <= 28)) return res.status(400).json({ error: "The due day must be from 1 to 28" });
  if (!(reminderDays >= 1 && reminderDays <= 30)) return res.status(400).json({ error: "Reminder days must be from 1 to 30" });
  try {
    await pool.query(
      `INSERT INTO fee_settings (school_id, auto_on, due_day, reminder_days) VALUES ($1,$2,$3,$4)
       ON CONFLICT (school_id) DO UPDATE SET auto_on = EXCLUDED.auto_on, due_day = EXCLUDED.due_day, reminder_days = EXCLUDED.reminder_days`,
      [req.user.schoolId, !!req.body.autoOn, dueDay, reminderDays]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not save the settings" }); }
});

router.post("/auto/plans", async (req, res) => {
  const title = String(req.body.title || "").trim(), amount = Number(req.body.amount);
  if (!title || !(amount > 0)) return res.status(400).json({ error: "Enter the fee name and amount" });
  try {
    if (req.body.sectionId) {
      const ok = await pool.query("SELECT 1 FROM sections WHERE id = $1 AND school_id = $2", [req.body.sectionId, req.user.schoolId]);
      if (ok.rowCount === 0) return res.status(400).json({ error: "That class is not in your school" });
    }
    await pool.query("INSERT INTO fee_plans (school_id, title, amount, section_id) VALUES ($1,$2,$3,$4)", [req.user.schoolId, title, amount, req.body.sectionId || null]);
    res.status(201).json({ ok: true });
  } catch { res.status(500).json({ error: "Could not save the fee" }); }
});

router.delete("/auto/plans/:id", async (req, res) => {
  try { await pool.query("DELETE FROM fee_plans WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]); res.status(204).end(); }
  catch { res.status(500).json({ error: "Could not remove it" }); }
});

// "Run now": does today's work immediately instead of waiting for the daily check.
router.post("/auto/run", async (req, res) => {
  try { res.json(await runAuto(req.user.schoolId)); } catch (e) { console.error(e); res.status(500).json({ error: "Could not run the fee system" }); }
});

// The messages the system has made. Ones with a phone number can be sent by WhatsApp with one tap.
router.get("/auto/notices", async (req, res) => {
  const params = [req.user.schoolId];
  let where = "n.school_id = $1";
  if (req.query.pending === "1") where += " AND n.wa_done = false";
  try {
    const r = await pool.query(
      `SELECT n.id, n.kind, n.month, n.message, n.phone, n.email, n.emailed, n.wa_done, s.name, sec.grade, sec.name AS section
       FROM fee_notices n JOIN students s ON s.id = n.student_id LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE ${where} ORDER BY n.created_at DESC, s.name LIMIT 300`, params);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the messages" }); }
});

router.patch("/auto/notices/:id", async (req, res) => {
  try {
    await pool.query("UPDATE fee_notices SET wa_done = $1 WHERE id = $2 AND school_id = $3", [!!req.body.waDone, req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not update it" }); }
});

// ---- printable vouchers ----
router.get("/voucher", async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : monthPK();
  try {
    const own = await pool.query("SELECT 1 FROM students WHERE id = $1 AND school_id = $2", [req.query.studentId, req.user.schoolId]);
    if (own.rowCount === 0) return res.status(404).json({ error: "Student not found" });
    res.json(await buildVoucher(req.query.studentId, month));
  } catch { res.status(500).json({ error: "Could not build the voucher" }); }
});

router.get("/vouchers", async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : monthPK();
  const params = [req.user.schoolId, month];
  let where = "c.school_id = $1 AND c.month = $2";
  if (req.query.sectionId) { params.push(req.query.sectionId); where += ` AND s.section_id = $${params.length}`; }
  try {
    const ids = (await pool.query(
      `SELECT DISTINCT s.id, s.name, sec.grade, sec.name AS section FROM fee_charges c JOIN students s ON s.id = c.student_id LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE ${where} ORDER BY sec.grade, sec.name, s.name LIMIT 300`, params)).rows;
    const out = [];
    for (const s of ids) out.push(await buildVoucher(s.id, month));
    res.json(out);
  } catch { res.status(500).json({ error: "Could not build the vouchers" }); }
});

module.exports = router;
