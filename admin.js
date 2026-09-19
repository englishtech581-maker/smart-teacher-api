const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const totalStudents = await pool.query(
      `SELECT COUNT(*) FROM students s JOIN classes c ON c.id = s.class_id WHERE c.school_id = $1`,
      [schoolId]
    );

    const classCount = await pool.query(`SELECT COUNT(*) FROM classes WHERE school_id = $1`, [schoolId]);

    const todayAttendance = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.status = 'present') AS present,
         COUNT(*) AS total
       FROM attendance a
       JOIN classes c ON c.id = a.class_id
       WHERE c.school_id = $1 AND a.att_date = CURRENT_DATE`,
      [schoolId]
    );

    // Latest performance per student, joined to their latest attendance rate this month.
    const latestPerf = await pool.query(
      `SELECT DISTINCT ON (p.student_id) p.student_id, p.quiz_score, p.quiz_max, p.homework_status
       FROM performance p
       JOIN classes c ON c.id = p.class_id
       WHERE c.school_id = $1
       ORDER BY p.student_id, p.recorded_at DESC`,
      [schoolId]
    );

    let quizSum = 0, quizCount = 0, pendingHomework = 0, needingSupport = 0;
    latestPerf.rows.forEach((r) => {
      if (r.quiz_max > 0) {
        quizSum += (Number(r.quiz_score) / Number(r.quiz_max)) * 100;
        quizCount += 1;
      }
      if (r.homework_status === "Missing") pendingHomework += 1;
      const quizPct = r.quiz_max > 0 ? (Number(r.quiz_score) / Number(r.quiz_max)) * 100 : 0;
      const hwPoints = { Good: 3, Average: 2, Weak: 1, Missing: 0 }[r.homework_status] ?? 1;
      const quizPoints = quizPct >= 80 ? 3 : quizPct >= 60 ? 2 : quizPct >= 40 ? 1 : 0;
      const score = (hwPoints + quizPoints + 3) / 9; // attendance term simplified here; refine later with real join
      if (score < 0.6) needingSupport += 1;
    });

    const att = todayAttendance.rows[0];
    res.json({
      totalStudents: Number(totalStudents.rows[0].count),
      classCount: Number(classCount.rows[0].count),
      todayAttendancePct: Number(att.total) > 0 ? Math.round((Number(att.present) / Number(att.total)) * 100) : null,
      needingSupport,
      pendingHomework,
      avgQuizPct: quizCount > 0 ? Math.round(quizSum / quizCount) : null,
    });
  } catch (err) {
    res.status(500).json({ error: "Could not load dashboard" });
  }
});

module.exports = router;
