const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Returns every student linked to this parent, matched by either parent_email
// or parent_phone. A parent without an email simply registers using their
// phone number in the email/login field, and it's matched here either way.
router.get("/children", requireAuth, requireRole("parent"), async (req, res) => {
  try {
    const loginId = req.user.email.toLowerCase();
    const students = await pool.query(
      `SELECT s.*, c.subject, c.grade
       FROM students s
       JOIN classes c ON c.id = s.class_id
       WHERE s.parent_email = $1 OR s.parent_phone = $1`,
      [loginId]
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
