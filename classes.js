const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Create a class (teacher only)
router.post("/", requireAuth, requireRole("teacher"), async (req, res) => {
  const { subject, grade, chapter, topic } = req.body;
  if (!subject || !grade) return res.status(400).json({ error: "subject and grade are required" });
  try {
    const result = await pool.query(
      `INSERT INTO classes (school_id, teacher_id, subject, grade, chapter, topic)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.schoolId, req.user.id, subject, grade, chapter || null, topic || null]
    );
    res.status(201).json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Could not create class" });
  }
});

// List classes: teachers see their own, admins see the whole school
router.get("/", requireAuth, async (req, res) => {
  try {
    const query =
      req.user.role === "admin"
        ? { text: "SELECT * FROM classes WHERE school_id = $1 ORDER BY created_at DESC", params: [req.user.schoolId] }
        : { text: "SELECT * FROM classes WHERE teacher_id = $1 ORDER BY created_at DESC", params: [req.user.id] };
    const result = await pool.query(query.text, query.params);
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Could not load classes" });
  }
});

// Update a class's chapter/topic (e.g. after planning a new lesson)
router.patch("/:classId", requireAuth, requireRole("teacher"), async (req, res) => {
  const { chapter, topic } = req.body;
  try {
    const result = await pool.query(
      `UPDATE classes SET chapter = COALESCE($1, chapter), topic = COALESCE($2, topic)
       WHERE id = $3 AND teacher_id = $4 RETURNING *`,
      [chapter, topic, req.params.classId, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Class not found" });
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Could not update class" });
  }
});

module.exports = router;
