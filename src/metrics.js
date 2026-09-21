const pool = require("./db");

function computePerformance(quizPct, homeworkStatus, attendancePct) {
  const hwPoints = { Good: 3, Average: 2, Weak: 1, Missing: 0 }[homeworkStatus] ?? 1;
  const quizPoints = quizPct >= 80 ? 3 : quizPct >= 60 ? 2 : quizPct >= 40 ? 1 : 0;
  const attPoints = attendancePct >= 90 ? 3 : attendancePct >= 75 ? 2 : attendancePct >= 50 ? 1 : 0;
  const score = (hwPoints + quizPoints + attPoints) / 9;
  if (score >= 0.8) return "Excellent";
  if (score >= 0.6) return "Good";
  if (score >= 0.4) return "Needs Support";
  return "At Risk";
}

// Pulls a student's latest quiz/homework entry and this month's attendance
// straight from the database, so AI routes never have to trust client-supplied numbers.
async function getStudentMetrics(studentId) {
  const perfRes = await pool.query(
    "SELECT * FROM performance WHERE student_id = $1 ORDER BY recorded_at DESC LIMIT 1",
    [studentId]
  );
  const perf = perfRes.rows[0];
  const quizPct = perf && perf.quiz_max > 0 ? (Number(perf.quiz_score) / Number(perf.quiz_max)) * 100 : 0;
  const homeworkStatus = perf ? perf.homework_status : "Average";
  const topic = perf ? perf.topic : null;
  const conductStatus = perf ? perf.conduct_status : null;
  const conductNotes = perf ? perf.conduct_notes : null;

  const attRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'present') AS present,
       COUNT(*) FILTER (WHERE status = 'late') AS late,
       COUNT(*) AS total
     FROM attendance
     WHERE student_id = $1 AND to_char(att_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')`,
    [studentId]
  );
  const a = attRes.rows[0];
  const attendancePct = Number(a.total) > 0 ? ((Number(a.present) + Number(a.late) * 0.5) / Number(a.total)) * 100 : 100;

  return { quizPct, homeworkStatus, attendancePct, topic, conductStatus, conductNotes, performance: computePerformance(quizPct, homeworkStatus, attendancePct) };
}

module.exports = { computePerformance, getStudentMetrics };
