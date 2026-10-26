const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sectionFor } = require("../utils");
const { normPhone, parseClass, toDate } = require("../text");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

// ---- Students (whole school) ----
router.get("/students", async (req, res) => {
  const { q = "", sectionId } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const params = [req.user.schoolId];
  let where = "s.school_id = $1";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (s.name ILIKE $${params.length} OR s.admission_no ILIKE $${params.length} OR s.parent_phone ILIKE $${params.length})`;
  }
  if (sectionId) {
    params.push(sectionId);
    where += ` AND s.section_id = $${params.length}`;
  }
  try {
    const rows = await pool.query(
      `SELECT s.id, s.name, s.admission_no, s.gender, s.guardian_name, s.parent_phone, s.parent_email,
              s.section_id, sec.grade, sec.name AS section
       FROM students s LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE ${where}
       ORDER BY NULLIF(regexp_replace(COALESCE(sec.grade, ''), '\\D', '', 'g'), '')::int NULLS LAST, sec.name, s.name
       LIMIT ${limit}`,
      params
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM students s WHERE ${where}`, params);
    res.json({ students: rows.rows, total: total.rows[0].n });
  } catch {
    res.status(500).json({ error: "Could not load the students" });
  }
});

router.post("/students", async (req, res) => {
  const b = req.body;
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "Student name is required" });
  try {
    let sectionId = null;
    if (String(b.className || "").trim()) {
      const c = parseClass(b.className);
      if (!c) return res.status(400).json({ error: "Class should look like 7-A" });
      sectionId = await sectionFor(pool, req.user.schoolId, c.grade, c.section);
    }
    const r = await pool.query(
      `INSERT INTO students (school_id, section_id, name, admission_no, gender, guardian_name, parent_phone, parent_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        req.user.schoolId, sectionId, String(b.name).trim(), String(b.admissionNo || "").trim() || null,
        b.gender || null, b.guardianName || null, normPhone(b.parentPhone) || null,
        b.parentEmail ? String(b.parentEmail).toLowerCase() : null,
      ]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "A student with this admission number already exists" });
    res.status(500).json({ error: "Could not add the student" });
  }
});

router.delete("/students/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM students WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Could not remove the student" });
  }
});

// ---- Teachers who have a login (used for the class teacher list) ----
router.get("/teachers", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, name, email FROM users WHERE school_id = $1 AND role = 'teacher' ORDER BY name",
      [req.user.schoolId]
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Could not load the teachers" });
  }
});

// ---- Staff records ----
router.get("/staff", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, name, role, department, phone, email, joined_on FROM staff WHERE school_id = $1 ORDER BY name",
      [req.user.schoolId]
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Could not load the staff" });
  }
});

router.post("/staff", async (req, res) => {
  const b = req.body;
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "Name is required" });
  try {
    const r = await pool.query(
      `INSERT INTO staff (school_id, name, role, department, phone, email, joined_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        req.user.schoolId, String(b.name).trim(), b.role || null, b.department || null,
        normPhone(b.phone) || null, b.email ? String(b.email).toLowerCase() : null, toDate(b.joinedOn),
      ]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch {
    res.status(500).json({ error: "Could not add the staff member" });
  }
});

router.delete("/staff/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM staff WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Could not remove the staff member" });
  }
});

module.exports = router;
