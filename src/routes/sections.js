const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// All sections of the school with their class teacher and number of students.
router.get("/", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT sec.id, sec.grade, sec.name, sec.class_teacher_id, u.name AS class_teacher_name,
              (SELECT COUNT(*) FROM students st WHERE st.section_id = sec.id)::int AS students
       FROM sections sec
       LEFT JOIN users u ON u.id = sec.class_teacher_id
       WHERE sec.school_id = $1
       ORDER BY NULLIF(regexp_replace(sec.grade, '\\D', '', 'g'), '')::int NULLS LAST, sec.grade, sec.name`,
      [req.user.schoolId]
    );
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Could not load the sections" });
  }
});

router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const grade = String(req.body.grade || "").trim();
  const name = String(req.body.name || "A").trim().toUpperCase();
  if (!grade) return res.status(400).json({ error: "Class is required, for example 7" });
  try {
    const r = await pool.query(
      `INSERT INTO sections (school_id, grade, name) VALUES ($1, $2, $3)
       ON CONFLICT (school_id, grade, name) DO NOTHING RETURNING id`,
      [req.user.schoolId, grade, name]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: `Class ${grade}-${name} already exists` });
    res.status(201).json({ id: r.rows[0].id });
  } catch {
    res.status(500).json({ error: "Could not add the section" });
  }
});

// Choose (or clear) the class teacher of a section.
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const teacherId = req.body.classTeacherId || null;
  try {
    if (teacherId) {
      const t = await pool.query(
        "SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'",
        [teacherId, req.user.schoolId]
      );
      if (t.rowCount === 0) return res.status(400).json({ error: "That teacher is not in your school" });
    }
    const r = await pool.query(
      "UPDATE sections SET class_teacher_id = $1 WHERE id = $2 AND school_id = $3 RETURNING id",
      [teacherId, req.params.id, req.user.schoolId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Section not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Could not update the section" });
  }
});

router.delete("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const c = await pool.query("SELECT COUNT(*)::int AS n FROM students WHERE section_id = $1", [req.params.id]);
    if (c.rows[0].n > 0) return res.status(409).json({ error: "Move or remove the students of this section first" });
    await pool.query("DELETE FROM sections WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Could not delete the section" });
  }
});

module.exports = router;
