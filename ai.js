const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");
const { callClaude, parseJSON } = require("../aiClient");
const { getStudentMetrics } = require("../metrics");

const router = express.Router();

// ---- Lesson guide (teacher) ----
router.post("/lesson-guide", requireAuth, requireRole("teacher"), async (req, res) => {
  const { subject, klass, chapter, topic, language } = req.body;
  if (!topic) return res.status(400).json({ error: "topic is required" });

  const langLine =
    language === "ur"
      ? "Write the ENTIRE response in Urdu (اردو رسم الخط میں)."
      : "Write the entire response in clear, simple English suitable for school teachers.";
  const system = `You are an experienced curriculum specialist helping a school teacher prepare a lesson. ${langLine}
Respond with ONLY a single valid JSON object, no markdown fences, no preamble. Keep every section SHORT (bullet-style, concise phrases). Schema:
{
 "objectives": ["...", "..."],
 "introduction": "1-2 short sentences",
 "explanation": "2-4 short sentences",
 "examples": ["...", "..."],
 "activities": ["...", "..."],
 "questions": ["...", "..."],
 "weakStudentActivities": ["...", "..."],
 "advancedQuestions": ["...", "..."],
 "assessment": ["...", "..."],
 "homework": ["...", "..."],
 "nextLesson": "one short sentence"
}
3-4 items per array is enough. Be concrete to the given subject/class/chapter/topic.`;
  const user = `Subject: ${subject}\nClass: ${klass}\nChapter: ${chapter || ""}\nTopic: ${topic}`;

  try {
    const text = await callClaude({ system, user, maxTokens: 1000 });
    res.json(parseJSON(text));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not generate lesson guide" });
  }
});

// ---- Early-warning insight for one student (teacher) ----
// classId/studentId only — quiz/homework/attendance are pulled from the DB,
// never trusted from the client, and ownership is checked via assertClassAccess.
router.post("/student-insight", requireAuth, requireRole("teacher"), async (req, res) => {
  const { classId, studentId, language } = req.body;
  if (!classId || !studentId) return res.status(400).json({ error: "classId and studentId are required" });

  try {
    const klass = await assertClassAccess(classId, req.user);
    const studentRes = await pool.query("SELECT * FROM students WHERE id = $1 AND class_id = $2", [studentId, classId]);
    const student = studentRes.rows[0];
    if (!student) return res.status(404).json({ error: "Student not found in this class" });

    const { quizPct, homeworkStatus, attendancePct, performance, topic } = await getStudentMetrics(studentId);
    const langLine = language === "ur" ? "Write the ENTIRE response in Urdu." : "Write in clear, simple English.";
    const system = `You are an experienced teacher-mentor giving a busy classroom teacher a quick, specific, actionable early-warning note about one student. ${langLine} Respond with ONLY a single valid JSON object, no markdown fences. Schema:
{
 "likelyCause": "one short sentence guessing the most likely reason for the struggle",
 "actions": ["2-3 short, concrete, specific classroom actions for this week"],
 "watchFor": "one short sentence: what sign shows improvement or decline"
}
Be specific to the subject/topic, not generic.`;
    const user = `Student: ${student.name}\nSubject: ${klass.subject}, Class: ${klass.grade}, Topic: ${topic || klass.topic || "current topic"}\nQuiz score: ${Math.round(quizPct)}%\nHomework: ${homeworkStatus}\nAttendance: ${Math.round(attendancePct)}%\nCurrent performance label: ${performance}`;

    const text = await callClaude({ system, user, maxTokens: 1000 });
    res.json(parseJSON(text));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not get insight" });
  }
});

// ---- Institute-wide risk briefing (admin) ----
// Computed entirely server-side from the admin's own school — no client-supplied list.
router.post("/risk-briefing", requireAuth, requireRole("admin"), async (req, res) => {
  const { language } = req.body;
  try {
    const classesRes = await pool.query("SELECT * FROM classes WHERE school_id = $1", [req.user.schoolId]);
    const atRiskList = [];
    for (const c of classesRes.rows) {
      const studentsRes = await pool.query("SELECT * FROM students WHERE class_id = $1", [c.id]);
      for (const s of studentsRes.rows) {
        const { quizPct, homeworkStatus, performance } = await getStudentMetrics(s.id);
        if (performance === "At Risk" || performance === "Needs Support") {
          atRiskList.push({ name: s.name, classLabel: `${c.subject} · Class ${c.grade}`, quizPct, homework: homeworkStatus, performance });
        }
      }
    }
    const langLine = language === "ur" ? "Write the ENTIRE response in Urdu." : "Write in clear, simple English.";
    const system = `You are an academic operations advisor summarizing at-risk students for a school principal. ${langLine} Respond with ONLY a JSON object, no markdown fences:
{ "briefing": "a short 3-5 sentence prioritized briefing naming patterns and what the principal should ask teachers to do this week" }`;
    const user = atRiskList.length
      ? `At-risk / needs-support students across the institute:\n${atRiskList.map((s) => `- ${s.name} (${s.classLabel}): quiz ${Math.round(s.quizPct)}%, homework ${s.homework}, performance ${s.performance}`).join("\n")}`
      : "No students are currently flagged At Risk or Needs Support.";

    const text = await callClaude({ system, user, maxTokens: 1000 });
    const parsed = parseJSON(text);
    res.json({ briefing: parsed.briefing, atRiskCount: atRiskList.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not generate briefing" });
  }
});

// ---- Plain-language report for a parent ----
// Ownership is checked server-side: a parent can only request a report for a
// child whose parent_email matches their own login email.
router.post("/parent-report", requireAuth, requireRole("parent"), async (req, res) => {
  const { studentId, language } = req.body;
  if (!studentId) return res.status(400).json({ error: "studentId is required" });

  try {
    const studentRes = await pool.query(
      "SELECT s.*, c.subject, c.grade FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = $1",
      [studentId]
    );
    const student = studentRes.rows[0];
    if (!student) return res.status(404).json({ error: "Student not found" });
    if (!student.parent_email || student.parent_email !== req.user.email.toLowerCase()) {
      return res.status(403).json({ error: "Not allowed to view this child's report" });
    }

    const { quizPct, homeworkStatus, attendancePct, performance } = await getStudentMetrics(studentId);
    const langLine =
      language === "ur"
        ? "Write the ENTIRE response in Urdu (اردو رسم الخط میں)."
        : "Write in warm, plain, non-technical English suitable for a parent with no education background.";
    const system = `You are a caring class teacher writing a short report card note directly to a parent. ${langLine} Avoid jargon. Respond with ONLY a JSON object, no markdown fences:
{
 "summary": "2-3 sentence warm, honest summary of how the child is doing overall",
 "strengths": ["1-2 short positive points"],
 "areasToImprove": ["1-2 short, specific, non-alarming points"],
 "homeSupportTip": "one short concrete thing the parent can do at home"
}`;
    const user = `Child: ${student.name}\nSubject: ${student.subject}, Class: ${student.grade}\nQuiz score: ${Math.round(quizPct)}%\nHomework habits: ${homeworkStatus}\nAttendance: ${Math.round(attendancePct)}%\nOverall performance: ${performance}`;

    const text = await callClaude({ system, user, maxTokens: 1000 });
    res.json(parseJSON(text));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not generate report" });
  }
});

module.exports = router;
