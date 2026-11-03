const pool = require("./db");
const { gradeFor } = require("./reportcard");

const r1 = (n) => Math.round(n * 10) / 10;

// A whole class's results for one exam (or for the whole year when examId is "annual"):
// every student's marks, total, percentage, grade and position, plus summary figures for the class.
async function classResults(schoolId, sectionId, examId, year) {
  const sec = (await pool.query("SELECT id, grade, name FROM sections WHERE id = $1 AND school_id = $2", [sectionId, schoolId])).rows[0];
  if (!sec) return null;
  const pass = (await pool.query("SELECT pass_mark FROM schools WHERE id = $1", [schoolId])).rows[0].pass_mark;
  const yr = Number(year) || new Date().getFullYear();
  const students = (await pool.query("SELECT id, name, admission_no FROM students WHERE section_id = $1 ORDER BY name", [sectionId])).rows;

  let examName = "Whole year";
  const params = [sectionId];
  let filter;
  if (examId && examId !== "annual") {
    const e = (await pool.query("SELECT id, name, year FROM exams WHERE id = $1 AND school_id = $2", [examId, schoolId])).rows[0];
    if (!e) return null;
    examName = e.name; params.push(e.id); filter = `m.exam_id = $2`;
  } else {
    params.push(yr, schoolId); filter = `e.year = $2 AND e.school_id = $3`;
  }
  const marks = (await pool.query(
    `SELECT m.student_id, m.subject, SUM(m.marks)::float AS marks, SUM(m.total)::float AS total
     FROM exam_marks m JOIN exams e ON e.id = m.exam_id JOIN students s ON s.id = m.student_id
     WHERE s.section_id = $1 AND ${filter} GROUP BY m.student_id, m.subject`, params)).rows;

  const subjects = [...new Set(marks.map((m) => m.subject))].sort();
  const rows = students.map((s) => {
    const mine = marks.filter((m) => m.student_id === s.id);
    const subj = {};
    for (const m of mine) subj[m.subject] = { marks: m.marks, total: m.total, pct: m.total > 0 ? r1((m.marks / m.total) * 100) : null };
    const got = mine.reduce((a, m) => a + m.marks, 0), max = mine.reduce((a, m) => a + m.total, 0);
    const ratio = max > 0 ? got / max : null;
    const failed = mine.filter((m) => m.total > 0 && (m.marks / m.total) * 100 < pass).map((m) => m.subject);
    return {
      id: s.id, name: s.name, admissionNo: s.admission_no, subjects: subj, got, max, ratio,
      pct: ratio === null ? null : r1(ratio * 100), grade: gradeFor(ratio === null ? null : ratio * 100),
      failed, result: ratio === null ? "No marks" : failed.length ? "Fail" : "Pass", position: null,
    };
  });
  // positions: same percentage, same position
  const ranked = rows.filter((r) => r.ratio !== null).sort((a, b) => b.ratio - a.ratio);
  ranked.forEach((r) => { r.position = 1 + ranked.filter((x) => x.ratio > r.ratio).length; });
  rows.sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999) || a.name.localeCompare(b.name));

  const appeared = ranked.length;
  const passed = rows.filter((r) => r.result === "Pass").length;
  const subjectStats = subjects.map((sub) => {
    const v = rows.map((r) => r.subjects[sub]).filter((x) => x && x.pct !== null);
    return { subject: sub, students: v.length, avg: v.length ? r1(v.reduce((a, x) => a + x.pct, 0) / v.length) : null, highest: v.length ? Math.max(...v.map((x) => x.pct)) : null, passPct: v.length ? Math.round((v.filter((x) => x.pct >= pass).length / v.length) * 100) : null };
  });
  const dist = {};
  rows.forEach((r) => { if (r.pct !== null) dist[r.grade] = (dist[r.grade] || 0) + 1; });
  return {
    section: { id: sec.id, grade: sec.grade, name: sec.name }, exam: examName, year: yr, passMark: pass, subjects, rows: rows.map(({ ratio, ...x }) => x),
    summary: {
      students: rows.length, appeared, passed, failed: appeared - passed, passPct: appeared ? Math.round((passed / appeared) * 100) : null,
      avgPct: appeared ? r1(ranked.reduce((a, r) => a + r.pct, 0) / appeared) : null,
      highest: appeared ? ranked[0].pct : null, lowest: appeared ? ranked[ranked.length - 1].pct : null,
      toppers: ranked.filter((r) => r.position === 1).map((r) => r.name),
    },
    subjectStats, gradeDistribution: dist,
  };
}

// The whole school: one line per class, school-wide figures and the best students.
async function schoolResults(schoolId, examId, year) {
  const secs = (await pool.query("SELECT id FROM sections WHERE school_id = $1 ORDER BY NULLIF(regexp_replace(grade, '\\D', '', 'g'), '')::int NULLS LAST, name LIMIT 120", [schoolId])).rows;
  const classes = [], top = [], subj = {}, dist = {};
  let students = 0, appeared = 0, passed = 0, sumPct = 0, examName = "", passMark = 40;
  for (const s of secs) {
    const r = await classResults(schoolId, s.id, examId, year);
    if (!r) continue;
    examName = r.exam; passMark = r.passMark;
    students += r.summary.students; appeared += r.summary.appeared; passed += r.summary.passed;
    sumPct += r.rows.filter((x) => x.pct !== null).reduce((a, x) => a + x.pct, 0);
    const first = r.rows.find((x) => x.position === 1);
    classes.push({ sectionId: s.id, name: `${r.section.grade}-${r.section.name}`, students: r.summary.students, appeared: r.summary.appeared, passPct: r.summary.passPct, avgPct: r.summary.avgPct, topper: first ? { name: first.name, pct: first.pct } : null });
    r.rows.filter((x) => x.pct !== null).forEach((x) => top.push({ name: x.name, cls: `${r.section.grade}-${r.section.name}`, pct: x.pct, grade: x.grade }));
    r.subjectStats.forEach((st) => { const a = (subj[st.subject] = subj[st.subject] || { sum: 0, n: 0 }); if (st.avg !== null) { a.sum += st.avg * st.students; a.n += st.students; } });
    Object.entries(r.gradeDistribution).forEach(([g, n]) => { dist[g] = (dist[g] || 0) + n; });
  }
  top.sort((a, b) => b.pct - a.pct);
  const best = classes.filter((c) => c.avgPct !== null).sort((a, b) => b.avgPct - a.avgPct);
  return {
    exam: examName || (examId && examId !== "annual" ? "" : "Whole year"), passMark,
    summary: { students, appeared, passed, failed: appeared - passed, passPct: appeared ? Math.round((passed / appeared) * 100) : null, avgPct: appeared ? r1(sumPct / appeared) : null, bestClass: best[0] ? best[0].name : null },
    classes, topStudents: top.slice(0, 10),
    subjectAverages: Object.entries(subj).map(([subject, a]) => ({ subject, avg: a.n ? r1(a.sum / a.n) : null })).sort((a, b) => a.subject.localeCompare(b.subject)),
    gradeDistribution: dist,
  };
}

module.exports = { classResults, schoolResults };
