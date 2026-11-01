const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// One section's weekly timetable (admin and teachers of the school).
router.get("/", requireRole("admin", "teacher"), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.day, t.period, t.subject, t.teacher_id, u.name AS teacher
       FROM timetable_slots t JOIN sections s ON s.id = t.section_id LEFT JOIN users u ON u.id = t.teacher_id
       WHERE t.section_id = $1 AND s.school_id = $2 ORDER BY t.day, t.period`, [req.query.sectionId, req.user.schoolId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the timetable" }); }
});

// Replace the whole timetable of one section. A teacher cannot be in two sections in the same period.
router.put("/", requireRole("admin"), async (req, res) => {
  const { sectionId } = req.body;
  const slots = Array.isArray(req.body.slots) ? req.body.slots : [];
  const client = await pool.connect();
  try {
    const sec = await client.query("SELECT 1 FROM sections WHERE id = $1 AND school_id = $2", [sectionId, req.user.schoolId]);
    if (sec.rowCount === 0) return res.status(404).json({ error: "Section not found" });
    const clean = [];
    for (const x of slots) {
      const day = Number(x.day), period = Number(x.period), subject = String(x.subject || "").trim();
      if (!subject) continue;
      if (!(day >= 1 && day <= 6) || !(period >= 1 && period <= 10)) return res.status(400).json({ error: "Day must be 1-6 and period 1-10" });
      clean.push({ day, period, subject, teacherId: x.teacherId || null });
    }
    for (const x of clean.filter((c) => c.teacherId)) {
      const t = await client.query("SELECT 1 FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher'", [x.teacherId, req.user.schoolId]);
      if (t.rowCount === 0) return res.status(400).json({ error: "One of the teachers is not in your school" });
      const clash = await client.query(
        `SELECT s.grade, s.name FROM timetable_slots t JOIN sections s ON s.id = t.section_id
         WHERE t.teacher_id = $1 AND t.day = $2 AND t.period = $3 AND t.section_id <> $4 LIMIT 1`, [x.teacherId, x.day, x.period, sectionId]);
      if (clash.rowCount) {
        const names = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        return res.status(409).json({ error: `Clash: that teacher is already in ${clash.rows[0].grade}-${clash.rows[0].name} on ${names[x.day]}, period ${x.period}.` });
      }
    }
    await client.query("BEGIN");
    await client.query("DELETE FROM timetable_slots WHERE section_id = $1", [sectionId]);
    for (const x of clean) {
      await client.query(
        `INSERT INTO timetable_slots (section_id, day, period, subject, teacher_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (section_id, day, period) DO UPDATE SET subject = EXCLUDED.subject, teacher_id = EXCLUDED.teacher_id`,
        [sectionId, x.day, x.period, x.subject, x.teacherId]);
    }
    await client.query("COMMIT");
    res.json({ saved: clean.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Could not save the timetable" });
  } finally { client.release(); }
});

// A teacher's own week, across every section.
router.get("/mine", requireRole("teacher"), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.day, t.period, t.subject, s.grade, s.name AS section FROM timetable_slots t JOIN sections s ON s.id = t.section_id
       WHERE t.teacher_id = $1 ORDER BY t.day, t.period`, [req.user.id]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load your timetable" }); }
});

module.exports = router;
