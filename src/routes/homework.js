const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");
const { toDate } = require("../text");

const router = express.Router();
router.use(requireAuth, requireRole("teacher", "admin"));

// Homework is set for a class. Parents see it through the section that class belongs to.
router.post("/", async (req, res) => {
  const { classId, title, details } = req.body;
  if (!classId || !String(title || "").trim()) return res.status(400).json({ error: "Write what the homework is" });
  try {
    const klass = await assertClassAccess(classId, req.user);
    if (!klass.section_id) return res.status(400).json({ error: "This class is not linked to a section, so parents cannot see homework. Create the class again and choose a section." });
    const r = await pool.query(
      `INSERT INTO homework (school_id, class_id, section_id, teacher_id, subject, title, details, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.user.schoolId, classId, klass.section_id, req.user.id, klass.subject, String(title).trim(), details || null, toDate(req.body.dueDate)]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || "Could not save the homework" }); }
});

router.get("/class/:classId", async (req, res) => {
  try {
    await assertClassAccess(req.params.classId, req.user);
    const r = await pool.query(
      `SELECT id, subject, title, details, to_char(due_date,'YYYY-MM-DD') AS due_date, to_char(created_at,'YYYY-MM-DD') AS given_on
       FROM homework WHERE class_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.params.classId]);
    res.json(r.rows);
  } catch (err) { res.status(err.status || 500).json({ error: err.message || "Could not load homework" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM homework WHERE id = $1 AND school_id = $2 AND ($3 = 'admin' OR teacher_id = $4)", [req.params.id, req.user.schoolId, req.user.role, req.user.id]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not delete it" }); }
});

module.exports = router;
