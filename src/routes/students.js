const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");
const { normPhone } = require("../text");

const router = express.Router();

// A teacher adds a student to their own class. If the class is tied to a section
// (for example 7-A), the student also joins that section.
router.post("/:classId/students", requireAuth, requireRole("teacher"), async (req, res) => {
  const { name, parentEmail, parentPhone } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const klass = await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      `INSERT INTO students (class_id, school_id, section_id, name, parent_email, parent_phone)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.classId, klass.school_id, klass.section_id || null, name,
       parentEmail ? parentEmail.toLowerCase() : null, normPhone(parentPhone) || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not add student" });
  }
});

// Students of a class: the ones added to it directly, plus everyone in its section.
router.get("/:classId/students", requireAuth, async (req, res) => {
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      `SELECT * FROM students
       WHERE class_id = $1
          OR (section_id IS NOT NULL AND section_id = (SELECT section_id FROM classes WHERE id = $1))
       ORDER BY name`,
      [req.params.classId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not load students" });
  }
});

router.delete("/:classId/students/:studentId", requireAuth, requireRole("teacher"), async (req, res) => {
  try {
    await assertClassAccess(req.params.classId, req.user);
    await pool.query("DELETE FROM students WHERE id = $1 AND class_id = $2", [req.params.studentId, req.params.classId]);
    res.status(204).end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not remove student" });
  }
});

module.exports = router;
