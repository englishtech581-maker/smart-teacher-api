const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { canUseSection, canSeeStudent } = require("../access");
const { buildReportCard } = require("../reportcard");
const { classResults, schoolResults } = require("../results");

const router = express.Router();
router.use(requireAuth);
const staffOnly = requireRole("admin", "teacher");

// ---- exams ----
router.get("/", staffOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, name, term, year FROM exams WHERE school_id = $1 ORDER BY year DESC, created_at DESC", [req.user.schoolId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load exams" }); }
});

router.post("/", requireRole("admin"), async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the exam a name, for example Mid-term" });
  try {
    const r = await pool.query(
      "INSERT INTO exams (school_id, name, term, year) VALUES ($1, $2, $3, COALESCE($4, EXTRACT(YEAR FROM CURRENT_DATE))) RETURNING id, name, term, year",
      [req.user.schoolId, name, req.body.term || null, Number(req.body.year) || null]
    );
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: "Could not create the exam" }); }
});

router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    await pool.query("DELETE FROM exams WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not delete the exam" }); }
});

// ---- marks sheet: the section's students with any marks already saved for this subject ----
router.get("/:id/sheet", staffOnly, async (req, res) => {
  const { sectionId, subject } = req.query;
  if (!sectionId || !subject) return res.status(400).json({ error: "Choose a section and a subject" });
  try {
    const ex = await pool.query("SELECT id FROM exams WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    if (ex.rowCount === 0) return res.status(404).json({ error: "Exam not found" });
    if (!(await canUseSection(req.user, sectionId))) return res.status(403).json({ error: "You do not teach this section" });
    const r = await pool.query(
      `SELECT s.id, s.name, s.admission_no, m.marks::float AS marks, m.total::float AS total
       FROM students s LEFT JOIN exam_marks m ON m.student_id = s.id AND m.exam_id = $1 AND m.subject = $2
       WHERE s.section_id = $3 ORDER BY s.name`,
      [req.params.id, String(subject).trim(), sectionId]
    );
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the marks sheet" }); }
});

router.put("/:id/marks", staffOnly, async (req, res) => {
  const { sectionId, marks } = req.body;
  const subject = String(req.body.subject || "").trim();
  const total = Number(req.body.total);
  if (!subject || !(total > 0) || !sectionId || !Array.isArray(marks)) return res.status(400).json({ error: "Subject, total marks and the marks list are needed" });
  const client = await pool.connect();
  try {
    const ex = await client.query("SELECT id FROM exams WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    if (ex.rowCount === 0) return res.status(404).json({ error: "Exam not found" });
    if (!(await canUseSection(req.user, sectionId))) return res.status(403).json({ error: "You do not teach this section" });
    const ids = (await client.query("SELECT id FROM students WHERE section_id = $1", [sectionId])).rows.map((r) => r.id);
    await client.query("BEGIN");
    let saved = 0;
    const problems = [];
    for (const m of marks) {
      if (!ids.includes(m.studentId)) continue;
      if (m.marks === "" || m.marks === null || m.marks === undefined) {
        await client.query("DELETE FROM exam_marks WHERE exam_id = $1 AND student_id = $2 AND subject = $3", [req.params.id, m.studentId, subject]);
        continue;
      }
      const v = Number(m.marks);
      if (!Number.isFinite(v) || v < 0 || v > total) { problems.push(m.studentId); continue; }
      await client.query(
        `INSERT INTO exam_marks (exam_id, student_id, subject, marks, total) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (exam_id, student_id, subject) DO UPDATE SET marks = EXCLUDED.marks, total = EXCLUDED.total`,
        [req.params.id, m.studentId, subject, v, total]
      );
      saved++;
    }
    await client.query("COMMIT");
    res.json({ saved, problems });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Could not save the marks" });
  } finally { client.release(); }
});

// ---- co-curricular marks ----
router.get("/activities/:studentId", staffOnly, async (req, res) => {
  try {
    if (!(await canSeeStudent(req.user, req.params.studentId))) return res.status(403).json({ error: "Not allowed" });
    const r = await pool.query("SELECT id, category, activity, marks::float AS marks, total::float AS total, note, year FROM activities WHERE student_id = $1 ORDER BY created_at DESC", [req.params.studentId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load activities" }); }
});

router.post("/activities", staffOnly, async (req, res) => {
  const b = req.body;
  if (!b.studentId || !String(b.activity || "").trim()) return res.status(400).json({ error: "Choose a student and name the activity" });
  const marks = b.marks === "" || b.marks == null ? null : Number(b.marks);
  const total = b.total === "" || b.total == null ? null : Number(b.total);
  if ((marks !== null && !Number.isFinite(marks)) || (total !== null && !Number.isFinite(total))) return res.status(400).json({ error: "Marks must be numbers" });
  if (marks !== null && total !== null && marks > total) return res.status(400).json({ error: "Marks cannot be more than the total" });
  try {
    if (!(await canSeeStudent(req.user, b.studentId))) return res.status(403).json({ error: "Not allowed" });
    const r = await pool.query(
      `INSERT INTO activities (school_id, student_id, category, activity, marks, total, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.user.schoolId, b.studentId, b.category || null, String(b.activity).trim(), marks, total, b.note || null]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch { res.status(500).json({ error: "Could not save the activity" }); }
});

router.delete("/activities/:id", staffOnly, async (req, res) => {
  try {
    await pool.query("DELETE FROM activities WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not remove it" }); }
});

// ---- report card (staff for their students; parents for their own children) ----
router.get("/report-card/:studentId", async (req, res) => {
  try {
    if (!(await canSeeStudent(req.user, req.params.studentId))) return res.status(403).json({ error: "Not allowed" });
    const card = await buildReportCard(req.params.studentId, req.query.year);
    if (!card) return res.status(404).json({ error: "Student not found" });
    res.json(card);
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not build the report card" }); }
});

// ---- results: a whole class, the whole school, and every report card of a class ----
// examId is an exam, or "annual" for the whole year's marks together.
router.get("/results/class", staffOnly, async (req, res) => {
  try {
    if (!req.query.sectionId) return res.status(400).json({ error: "Choose a class" });
    if (!(await canUseSection(req.user, req.query.sectionId))) return res.status(403).json({ error: "You do not teach this class" });
    const r = await classResults(req.user.schoolId, req.query.sectionId, req.query.examId, req.query.year);
    if (!r) return res.status(404).json({ error: "Class or exam not found" });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not build the class result" }); }
});

router.get("/results/school", requireRole("admin"), async (req, res) => {
  try { res.json(await schoolResults(req.user.schoolId, req.query.examId, req.query.year)); }
  catch (e) { console.error(e); res.status(500).json({ error: "Could not build the school result" }); }
});

router.get("/report-cards", staffOnly, async (req, res) => {
  try {
    if (!req.query.sectionId) return res.status(400).json({ error: "Choose a class" });
    if (!(await canUseSection(req.user, req.query.sectionId))) return res.status(403).json({ error: "You do not teach this class" });
    const ids = (await pool.query("SELECT id FROM students WHERE section_id = $1 ORDER BY name LIMIT 100", [req.query.sectionId])).rows;
    const cards = [];
    for (const s of ids) cards.push(await buildReportCard(s.id, req.query.year));
    res.json(cards);
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not build the report cards" }); }
});

module.exports = router;
