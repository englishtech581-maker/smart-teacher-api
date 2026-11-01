const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { normPhone, toDate } = require("../text");

const router = express.Router();
router.use(requireAuth);
const admin = requireRole("admin");
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));
const STATUSES = ["present", "absent", "late", "leave"];

// ---- staff attendance ----
router.get("/attendance", admin, async (req, res) => {
  const date = toDate(req.query.date) || new Date().toISOString().slice(0, 10);
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.role, a.status FROM staff s LEFT JOIN staff_attendance a ON a.staff_id = s.id AND a.att_date = $2
       WHERE s.school_id = $1 ORDER BY s.name`, [req.user.schoolId, date]);
    res.json({ date, staff: r.rows });
  } catch { res.status(500).json({ error: "Could not load attendance" }); }
});

router.post("/attendance", admin, async (req, res) => {
  const date = toDate(req.body.date);
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  if (!date) return res.status(400).json({ error: "Choose a date" });
  try {
    const mine = (await pool.query("SELECT id FROM staff WHERE school_id = $1", [req.user.schoolId])).rows.map((r) => r.id);
    let saved = 0;
    for (const x of records) {
      if (!mine.includes(x.staffId) || !STATUSES.includes(x.status)) continue;
      await pool.query(
        `INSERT INTO staff_attendance (staff_id, att_date, status) VALUES ($1,$2,$3)
         ON CONFLICT (staff_id, att_date) DO UPDATE SET status = EXCLUDED.status`, [x.staffId, date, x.status]);
      saved++;
    }
    res.json({ saved });
  } catch { res.status(500).json({ error: "Could not save attendance" }); }
});

router.get("/attendance/summary", admin, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const r = await pool.query(
      `SELECT s.id, s.name,
         COUNT(a.*) FILTER (WHERE a.status='present') AS present, COUNT(a.*) FILTER (WHERE a.status='late') AS late,
         COUNT(a.*) FILTER (WHERE a.status='absent') AS absent, COUNT(a.*) FILTER (WHERE a.status='leave') AS leave
       FROM staff s LEFT JOIN staff_attendance a ON a.staff_id = s.id AND to_char(a.att_date,'YYYY-MM') = $2
       WHERE s.school_id = $1 GROUP BY s.id, s.name ORDER BY s.name`, [req.user.schoolId, month]);
    res.json(r.rows.map((x) => ({ ...x, present: +x.present, late: +x.late, absent: +x.absent, leave: +x.leave })));
  } catch { res.status(500).json({ error: "Could not load the summary" }); }
});

// ---- leave ----
router.get("/leave", admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT l.id, s.name, l.kind, l.reason, l.status, to_char(l.from_date,'YYYY-MM-DD') AS from_date, to_char(l.to_date,'YYYY-MM-DD') AS to_date
       FROM leave_requests l JOIN staff s ON s.id = l.staff_id WHERE l.school_id = $1 ORDER BY (l.status='pending') DESC, l.created_at DESC LIMIT 200`, [req.user.schoolId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load leave requests" }); }
});

async function addLeave(res, schoolId, staffId, b) {
  const from = toDate(b.fromDate), to = toDate(b.toDate || b.fromDate);
  if (!from || !to || to < from) return res.status(400).json({ error: "Check the leave dates" });
  const r = await pool.query(
    `INSERT INTO leave_requests (school_id, staff_id, from_date, to_date, kind, reason, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [schoolId, staffId, from, to, b.kind || "Casual", b.reason || null, b.status || "pending"]);
  return res.status(201).json({ id: r.rows[0].id });
}

router.post("/leave", admin, async (req, res) => {
  try {
    const ok = await pool.query("SELECT 1 FROM staff WHERE id = $1 AND school_id = $2", [req.body.staffId, req.user.schoolId]);
    if (ok.rowCount === 0) return res.status(400).json({ error: "Choose a staff member" });
    await addLeave(res, req.user.schoolId, req.body.staffId, { ...req.body, status: "approved" });
  } catch { res.status(500).json({ error: "Could not save the leave" }); }
});

router.patch("/leave/:id", admin, async (req, res) => {
  if (!["approved", "rejected"].includes(req.body.status)) return res.status(400).json({ error: "Approve or reject" });
  try {
    await pool.query("UPDATE leave_requests SET status = $1 WHERE id = $2 AND school_id = $3", [req.body.status, req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not update the leave" }); }
});

// A teacher asks for leave themselves. They are matched to their staff record by email or phone.
async function myStaff(user) {
  const phone = normPhone(user.email);
  const r = await pool.query(
    "SELECT id FROM staff WHERE school_id = $1 AND (user_id = $2 OR lower(email) = $3 OR ($4::text IS NOT NULL AND phone = $4::text)) LIMIT 1",
    [user.schoolId, user.id, String(user.email).toLowerCase(), phone || null]);
  return r.rows[0];
}
router.post("/my-leave", requireRole("teacher"), async (req, res) => {
  try {
    const me = await myStaff(req.user);
    if (!me) return res.status(404).json({ error: "Your login is not linked to a staff record yet. Ask the admin to add your email in the Staff list." });
    await addLeave(res, req.user.schoolId, me.id, { ...req.body, status: "pending" });
  } catch { res.status(500).json({ error: "Could not send the request" }); }
});
router.get("/my-leave", requireRole("teacher"), async (req, res) => {
  try {
    const me = await myStaff(req.user);
    if (!me) return res.json([]);
    const r = await pool.query(
      `SELECT id, kind, reason, status, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date FROM leave_requests WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 30`, [me.id]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load your requests" }); }
});

// ---- salary ----
router.put("/salary/:staffId", admin, async (req, res) => {
  const base = Number(req.body.base);
  if (!(base >= 0)) return res.status(400).json({ error: "Enter the monthly salary" });
  try {
    await pool.query("UPDATE staff SET base_salary = $1 WHERE id = $2 AND school_id = $3", [base, req.params.staffId, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not save the salary" }); }
});

// Make the month's salary sheet. Each absent day takes away 1/30 of the salary; the principal can change any figure afterwards.
router.post("/payroll/generate", admin, async (req, res) => {
  const { month } = req.body;
  if (!isMonth(month)) return res.status(400).json({ error: "Choose the month" });
  try {
    const r = await pool.query(
      `INSERT INTO payroll (school_id, staff_id, month, base, deductions)
       SELECT s.school_id, s.id, $2, s.base_salary,
              ROUND(s.base_salary / 30.0 * (SELECT COUNT(*) FROM staff_attendance a WHERE a.staff_id = s.id AND a.status = 'absent' AND to_char(a.att_date,'YYYY-MM') = $2))
       FROM staff s WHERE s.school_id = $1 AND s.base_salary > 0
       ON CONFLICT (staff_id, month) DO NOTHING`, [req.user.schoolId, month]);
    res.json({ created: r.rowCount });
  } catch { res.status(500).json({ error: "Could not make the salary sheet" }); }
});

router.get("/payroll", admin, async (req, res) => {
  const month = isMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const r = await pool.query(
      `SELECT p.id, s.name, s.role, p.base::float AS base, p.allowances::float AS allowances, p.deductions::float AS deductions,
              (p.base + p.allowances - p.deductions)::float AS net, p.status
       FROM payroll p JOIN staff s ON s.id = p.staff_id WHERE p.school_id = $1 AND p.month = $2 ORDER BY s.name`, [req.user.schoolId, month]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the salary sheet" }); }
});

router.patch("/payroll/:id", admin, async (req, res) => {
  const b = req.body;
  const a = b.allowances === undefined ? null : Number(b.allowances);
  const d = b.deductions === undefined ? null : Number(b.deductions);
  if ((a !== null && !(a >= 0)) || (d !== null && !(d >= 0))) return res.status(400).json({ error: "Amounts must be numbers" });
  if (b.status && !["paid", "unpaid"].includes(b.status)) return res.status(400).json({ error: "Status must be paid or unpaid" });
  try {
    await pool.query(
      `UPDATE payroll SET allowances = COALESCE($1, allowances), deductions = COALESCE($2, deductions), status = COALESCE($3, status),
         paid_on = CASE WHEN $3 = 'paid' THEN CURRENT_DATE WHEN $3 = 'unpaid' THEN NULL ELSE paid_on END
       WHERE id = $4 AND school_id = $5`, [a, d, b.status || null, req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not update the salary" }); }
});

// ---- staff reviews (performance) ----
router.get("/reviews", admin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.role, s.base_salary::float AS base_salary,
              (SELECT ROUND(AVG(rating),1)::float FROM staff_reviews v WHERE v.staff_id = s.id) AS avg_rating,
              (SELECT notes FROM staff_reviews v WHERE v.staff_id = s.id ORDER BY review_date DESC, id LIMIT 1) AS last_note,
              (SELECT COUNT(*) FROM staff_reviews v WHERE v.staff_id = s.id)::int AS reviews
       FROM staff s WHERE s.school_id = $1 ORDER BY s.name`, [req.user.schoolId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load reviews" }); }
});

router.post("/reviews", admin, async (req, res) => {
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be from 1 to 5" });
  try {
    const ok = await pool.query("SELECT 1 FROM staff WHERE id = $1 AND school_id = $2", [req.body.staffId, req.user.schoolId]);
    if (ok.rowCount === 0) return res.status(400).json({ error: "Choose a staff member" });
    await pool.query("INSERT INTO staff_reviews (school_id, staff_id, rating, notes) VALUES ($1,$2,$3,$4)", [req.user.schoolId, req.body.staffId, rating, req.body.notes || null]);
    res.status(201).json({ ok: true });
  } catch { res.status(500).json({ error: "Could not save the review" }); }
});

module.exports = router;
