const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");

const router = express.Router();

router.post("/:classId/students", requireAuth, requireRole("teacher"), async (req, res) => {
  const { name, parentEmail, parentPhone } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      "INSERT INTO students (class_id, name, parent_email, parent_phone) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.params.classId, name, parentEmail ? parentEmail.toLowerCase() : null, parentPhone ? parentPhone.trim() : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not add student" });
  }
});

router.get("/:classId/students", requireAuth, async (req, res) => {
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      "SELECT * FROM students WHERE class_id = $1 ORDER BY name",
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
