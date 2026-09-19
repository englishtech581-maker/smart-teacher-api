const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");

const router = express.Router();

// Record a new performance entry (quiz + homework) for a student.
// Kept as history (one row per entry) rather than overwritten, so trends can be added later.
router.post("/:classId/performance", requireAuth, requireRole("teacher"), async (req, res) => {
  const { studentId, quizScore, quizMax, homeworkStatus, topic } = req.body;
  if (!studentId) return res.status(400).json({ error: "studentId is required" });
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      `INSERT INTO performance (student_id, class_id, quiz_score, quiz_max, homework_status, topic)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [studentId, req.params.classId, quizScore ?? null, quizMax ?? null, homeworkStatus || null, topic || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not save performance" });
  }
});

// Latest performance entry per student in this class.
router.get("/:classId/performance/latest", requireAuth, async (req, res) => {
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      `SELECT DISTINCT ON (student_id) *
       FROM performance
       WHERE class_id = $1
       ORDER BY student_id, recorded_at DESC`,
      [req.params.classId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not load performance" });
  }
});

module.exports = router;
