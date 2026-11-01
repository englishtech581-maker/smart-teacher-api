const pool = require("./db");

// Pakistani-style grade bands.
function gradeFor(pct) {
  if (pct === null || pct === undefined) return "-";
  if (pct >= 90) return "A+";
  if (pct >= 80) return "A";
  if (pct >= 70) return "B";
  if (pct >= 60) return "C";
  if (pct >= 50) return "D";
  if (pct >= 40) return "E";
  return "F";
}
const remarkFor = (pct) =>
  pct === null ? "" : pct >= 85 ? "Outstanding work" : pct >= 70 ? "Very good" : pct >= 55 ? "Satisfactory, can do better" : pct >= 40 ? "Needs extra support" : "Needs urgent attention";
const round1 = (n) => Math.round(n * 10) / 10;
const CONDUCT_SCORE = { Excellent: 100, Good: 80, Concern: 40 };

// Everything a report card shows for one student: every exam, attendance, conduct,
// co-curricular marks and the annual evaluation that combines them.
async function buildReportCard(studentId, year) {
  const st = await pool.query(
    `SELECT s.id, s.name, s.admission_no, s.guardian_name, s.section_id, sec.grade, sec.name AS section, sch.name AS school_name
     FROM students s LEFT JOIN sections sec ON sec.id = s.section_id JOIN schools sch ON sch.id = s.school_id WHERE s.id = $1`,
    [studentId]
  );
  const s = st.rows[0];
  if (!s) return null;
  const yr = Number(year) || new Date().getFullYear();

  const exams = await pool.query("SELECT * FROM exams WHERE school_id = (SELECT school_id FROM students WHERE id = $1) AND year = $2 ORDER BY created_at", [studentId, yr]);
  const out = [];
  for (const e of exams.rows) {
    const m = await pool.query("SELECT subject, marks::float AS marks, total::float AS total FROM exam_marks WHERE exam_id = $1 AND student_id = $2 ORDER BY subject", [e.id, studentId]);
    if (m.rowCount === 0) continue;
    const got = m.rows.reduce((a, r) => a + r.marks, 0);
    const max = m.rows.reduce((a, r) => a + r.total, 0);
    const pct = max > 0 ? round1((got / max) * 100) : null;
    // position in the section for this exam, by total percentage
    let position = null, of = null;
    if (s.section_id) {
      const rk = await pool.query(
        `SELECT m.student_id, SUM(m.marks)/NULLIF(SUM(m.total),0) AS p FROM exam_marks m JOIN students st ON st.id = m.student_id
         WHERE m.exam_id = $1 AND st.section_id = $2 GROUP BY m.student_id ORDER BY p DESC NULLS LAST`,
        [e.id, s.section_id]
      );
      of = rk.rowCount;
      const mine = rk.rows.find((r) => r.student_id === studentId);
      position = 1 + rk.rows.filter((r) => Number(r.p) > Number(mine.p)).length;
    }
    out.push({
      id: e.id, name: e.name, term: e.term,
      subjects: m.rows.map((r) => ({ ...r, pct: r.total > 0 ? round1((r.marks / r.total) * 100) : null, grade: gradeFor(r.total > 0 ? (r.marks / r.total) * 100 : null) })),
      got, max, pct, grade: gradeFor(pct), position, of,
    });
  }

  const att = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='present') AS p, COUNT(*) FILTER (WHERE status='late') AS l, COUNT(*) AS t
     FROM attendance WHERE student_id = $1 AND EXTRACT(YEAR FROM att_date) = $2`, [studentId, yr]);
  const a = att.rows[0];
  const attendancePct = Number(a.t) > 0 ? Math.round(((Number(a.p) + Number(a.l) * 0.5) / Number(a.t)) * 100) : null;

  const cond = await pool.query("SELECT conduct_status, conduct_notes FROM performance WHERE student_id = $1 AND conduct_status IS NOT NULL ORDER BY recorded_at DESC LIMIT 1", [studentId]);
  const conduct = cond.rows[0] ? { status: cond.rows[0].conduct_status, notes: cond.rows[0].conduct_notes } : null;

  const act = await pool.query("SELECT id, category, activity, marks::float AS marks, total::float AS total, note FROM activities WHERE student_id = $1 AND year = $2 ORDER BY created_at", [studentId, yr]);
  const scored = act.rows.filter((r) => r.total > 0);
  const activityPct = scored.length ? round1((scored.reduce((x, r) => x + r.marks, 0) / scored.reduce((x, r) => x + r.total, 0)) * 100) : null;

  // Annual evaluation: academics 70%, attendance 10%, co-curricular 10%, conduct 10%.
  // A part that has no data yet is left out and the others share its weight.
  const academicPct = out.length ? round1(out.reduce((x, e) => x + (e.pct || 0), 0) / out.length) : null;
  const parts = [
    ["Academics", academicPct, 70],
    ["Attendance", attendancePct, 10],
    ["Co-curricular", activityPct, 10],
    ["Conduct", conduct ? CONDUCT_SCORE[conduct.status] ?? 80 : null, 10],
  ].filter((p) => p[1] !== null);
  const wsum = parts.reduce((x, p) => x + p[2], 0);
  const overall = wsum ? round1(parts.reduce((x, p) => x + p[1] * p[2], 0) / wsum) : null;

  return {
    student: { id: s.id, name: s.name, admissionNo: s.admission_no, guardian: s.guardian_name, grade: s.grade, section: s.section },
    school: s.school_name, year: yr, exams: out,
    attendancePct, conduct, activities: act.rows, activityPct,
    evaluation: { parts: parts.map((p) => ({ name: p[0], pct: p[1], weight: p[2] })), overall, grade: gradeFor(overall), remark: remarkFor(overall) },
  };
}

module.exports = { buildReportCard, gradeFor };
