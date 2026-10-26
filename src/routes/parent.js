const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { normPhone } = require("../text");

const router = express.Router();

// Every student linked to this parent, matched by parent email or parent phone.
// A parent without an email registers with their phone number instead.
router.get("/children", requireAuth, requireRole("parent"), async (req, res) => {
  try {
    const loginId = req.user.email.toLowerCase();
    const phone = normPhone(loginId) || "-";
    const students = await pool.query(
      `SELECT s.*, c.subject, COALESCE(c.grade, sec.grade) AS grade, sec.name AS section
       FROM students s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN sections sec ON sec.id = s.section_id
       WHERE s.parent_email = $1 OR s.parent_phone = $2`,
      [loginId, phone]
    );

    const children = [];
    for (const s of students.rows) {
      const perf = await pool.query(
        `SELECT * FROM performance WHERE student_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [s.id]
      );
      const att = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'present') AS present,
           COUNT(*) FILTER (WHERE status = 'late') AS late,
           COUNT(*) AS total
         FROM attendance
         WHERE student_id = $1 AND to_char(att_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')`,
        [s.id]
      );
      const a = att.rows[0];
      children.push({
        id: s.id,
        name: s.name,
        subject: s.subject,
        grade: s.grade,
        section: s.section,
        latestPerformance: perf.rows[0] || null,
        attendancePct: Number(a.total) > 0 ? Math.round(((Number(a.present) + Number(a.late) * 0.5) / Number(a.total)) * 100) : null,
      });
    }
    res.json(children);
  } catch (err) {
    res.status(500).json({ error: "Could not load children" });
  }
});

module.exports = router;
