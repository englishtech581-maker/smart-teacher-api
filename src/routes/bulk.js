// Spreadsheet uploads for every tab. The browser reads the Excel or CSV file and sends plain rows here.
// Every row is checked and saved on its own, so one bad row never blocks the others, and the answer lists
// each skipped row with the line number it has in the person's own file.
const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { canUseSection } = require("../access");
const { assertClassAccess, sectionFor } = require("../utils");
const { parseClass, toDate, normPhone } = require("../text");

const router = express.Router();
router.use(requireAuth);
const admin = requireRole("admin");
const staffOnly = requireRole("admin", "teacher");

const clean = (v) => String(v ?? "").trim();
const lc = (v) => clean(v).toLowerCase();
const rowsOf = (req, max = 1000) => (Array.isArray(req.body.rows) ? req.body.rows.slice(0, max) : []);
const lineOf = (r, i) => r.row || i + 2;
const num = (v) => {
  const s = clean(v).replace(/,/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

// "2026-11", "Nov 2026", "November-2026", "11/2026" -> 2026-11
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function toMonth(v) {
  const s = clean(v);
  let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})(?:[-\/.]\d{1,2})?$/))) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${String(m[2]).padStart(2, "0")}` : null;
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{4})$/))) return +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${String(m[1]).padStart(2, "0")}` : null;
  if ((m = s.match(/^([A-Za-z]{3,})[\s,.-]*(\d{4})$/))) {
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, "0")}` : null;
  }
  const d = toDate(s); // a full date such as 01/11/2026 also names its month
  return d ? d.slice(0, 7) : null;
}

const STATUS_WORDS = {
  present: ["p", "present", "pres"], absent: ["a", "absent", "abs"], late: ["l", "late"], leave: ["lv", "leave", "on leave", "sick"],
};
function toStatus(v) {
  const s = lc(v);
  for (const k of Object.keys(STATUS_WORDS)) if (STATUS_WORDS[k].includes(s)) return k;
  return null;
}

const DAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function toDay(v) {
  const s = lc(v);
  if (/^[1-6]$/.test(s)) return +s;
  return DAYS[s.slice(0, 3)] || null;
}

// All the students of the school, indexed, so each row is matched without a query of its own.
async function studentIndex(schoolId, onlySectionIds) {
  const r = await pool.query(
    `SELECT s.id, s.name, s.admission_no, s.section_id, sec.grade, sec.name AS sec_name
     FROM students s LEFT JOIN sections sec ON sec.id = s.section_id WHERE s.school_id = $1`, [schoolId]);
  const all = r.rows.map((x) => ({ ...x, cls: x.grade ? `${x.grade}-${x.sec_name}` : "" }));
  const list = onlySectionIds ? all.filter((x) => onlySectionIds.includes(x.section_id)) : all;
  const byAdm = new Map();
  for (const s of list) if (s.admission_no) byAdm.set(lc(s.admission_no), s);
  return {
    find(row) {
      const adm = lc(row.admissionNo);
      if (adm) {
        const s = byAdm.get(adm);
        return s ? { student: s } : { error: `Admission number "${clean(row.admissionNo)}" not found` };
      }
      const name = lc(row.name);
      if (!name) return { error: "Admission number or student name is needed" };
      let hit = list.filter((s) => lc(s.name) === name);
      if (clean(row.className)) {
        const c = parseClass(row.className);
        if (c) hit = hit.filter((s) => s.cls.toLowerCase() === `${c.grade}-${c.section}`.toLowerCase());
      }
      if (hit.length === 1) return { student: hit[0] };
      if (hit.length === 0) return { error: `Student "${clean(row.name)}" not found` };
      return { error: `Several students are called "${clean(row.name)}". Add the admission number or the class` };
    },
  };
}

// Staff are found by email, phone or (when unique) name.
async function staffIndex(schoolId) {
  const r = await pool.query("SELECT id, name, email, phone FROM staff WHERE school_id = $1", [schoolId]);
  return {
    find(row) {
      const email = lc(row.email), phone = normPhone(row.phone), name = lc(row.name);
      if (email) { const h = r.rows.filter((s) => lc(s.email) === email); if (h.length === 1) return { staff: h[0] }; }
      if (phone) { const h = r.rows.filter((s) => s.phone === phone); if (h.length === 1) return { staff: h[0] }; }
      if (name) {
        const h = r.rows.filter((s) => lc(s.name) === name);
        if (h.length === 1) return { staff: h[0] };
        if (h.length > 1) return { error: `Several staff are called "${clean(row.name)}". Add the phone number or email` };
      }
      return { error: `Staff member "${clean(row.name || row.email || row.phone)}" not found` };
    },
  };
}

// Teachers (login accounts) by email or name.
async function teacherIndex(schoolId) {
  const r = await pool.query("SELECT id, name, email FROM users WHERE school_id = $1 AND role = 'teacher'", [schoolId]);
  return {
    find(v) {
      const s = lc(v);
      if (!s) return { none: true };
      const h = r.rows.filter((t) => lc(t.email) === s || lc(t.name) === s);
      if (h.length === 1) return { teacher: h[0] };
      return { error: h.length ? `Several teachers are called "${clean(v)}". Use the email` : `Teacher "${clean(v)}" has no login in this school yet` };
    },
  };
}

async function sectionMap(schoolId) {
  const r = await pool.query("SELECT id, grade, name FROM sections WHERE school_id = $1", [schoolId]);
  const m = new Map();
  for (const s of r.rows) m.set(`${s.grade}-${s.name}`.toLowerCase(), s);
  return {
    find(v) {
      const c = parseClass(v);
      if (!c) return { error: `Class "${clean(v)}" not understood` };
      const s = m.get(`${c.grade}-${c.section}`.toLowerCase());
      return s ? { section: s } : { error: `Class ${c.grade}-${c.section} does not exist. Add it in the Classes tab first` };
    },
  };
}

const fail = (res, msg = "The upload could not be saved") => res.status(500).json({ error: msg });

// ---------------------------------------------------------------- exam marks
// row: { admissionNo | name (+className), subject, marks, total }   body: { examId, total }
router.post("/marks", staffOnly, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const ex = await pool.query("SELECT id FROM exams WHERE id = $1 AND school_id = $2", [req.body.examId, req.user.schoolId]);
    if (ex.rowCount === 0) return res.status(404).json({ error: "Choose the exam first" });
    const defTotal = num(req.body.total);
    const idx = await studentIndex(req.user.schoolId);
    const allowed = new Map();
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.admissionNo);
      const subject = clean(r.subject);
      if (!subject) { skipped.push({ row: line, name: who, reason: "Subject is missing" }); continue; }
      const marks = num(r.marks);
      if (marks === null) { skipped.push({ row: line, name: who, reason: `${subject}: marks are empty` }); continue; }
      const total = num(r.total) ?? defTotal;
      if (!(total > 0)) { skipped.push({ row: line, name: who, reason: `${subject}: total marks are missing` }); continue; }
      if (Number.isNaN(marks) || marks < 0 || marks > total) { skipped.push({ row: line, name: who, reason: `${subject}: "${clean(r.marks)}" is not a mark between 0 and ${total}` }); continue; }
      const f = idx.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      const s = f.student;
      if (!s.section_id) { skipped.push({ row: line, name: s.name, reason: "This student has no class yet" }); continue; }
      if (!allowed.has(s.section_id)) allowed.set(s.section_id, await canUseSection(req.user, s.section_id));
      if (!allowed.get(s.section_id)) { skipped.push({ row: line, name: s.name, reason: `You do not teach class ${s.cls}` }); continue; }
      await pool.query(
        `INSERT INTO exam_marks (exam_id, student_id, subject, marks, total) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (exam_id, student_id, subject) DO UPDATE SET marks = EXCLUDED.marks, total = EXCLUDED.total`,
        [req.body.examId, s.id, subject, marks, total]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- classes
// row: { className, classTeacher }
router.post("/sections", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const teachers = await teacherIndex(req.user.schoolId);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i);
      const c = parseClass(r.className);
      if (!c) { skipped.push({ row: line, name: clean(r.className), reason: `Class "${clean(r.className)}" not understood` }); continue; }
      const t = teachers.find(r.classTeacher);
      if (t.error) { skipped.push({ row: line, name: `${c.grade}-${c.section}`, reason: t.error }); continue; }
      const id = await sectionFor(pool, req.user.schoolId, c.grade, c.section);
      if (t.teacher) await pool.query("UPDATE sections SET class_teacher_id = $1 WHERE id = $2", [t.teacher.id, id]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- fee charges
// row: { admissionNo | name, title, month, amount }
router.post("/fee-charges", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const idx = await studentIndex(req.user.schoolId);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.admissionNo);
      const month = toMonth(r.month);
      if (!month) { skipped.push({ row: line, name: who, reason: `Month "${clean(r.month)}" not understood. Use a month such as 2026-11 or Nov 2026` }); continue; }
      const amount = num(r.amount);
      if (!(amount > 0)) { skipped.push({ row: line, name: who, reason: "Amount must be a number above zero" }); continue; }
      const f = idx.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      const ins = await pool.query(
        `INSERT INTO fee_charges (school_id, student_id, title, month, amount) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (student_id, title, month) DO NOTHING`,
        [req.user.schoolId, f.student.id, clean(r.title) || "Tuition fee", month, amount]);
      if (ins.rowCount) imported++; else skipped.push({ row: line, name: f.student.name, reason: "This fee is already charged for that month" });
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- fee payments
// row: { admissionNo | name, month (optional), title (optional), amount, paidOn, method }
// Money is put on the oldest unpaid fee first (inside the chosen month / fee name when given).
router.post("/fee-payments", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const idx = await studentIndex(req.user.schoolId);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.admissionNo);
      const amount = num(r.amount);
      if (!(amount > 0)) { skipped.push({ row: line, name: who, reason: "Amount must be a number above zero" }); continue; }
      let month = null;
      if (clean(r.month)) { month = toMonth(r.month); if (!month) { skipped.push({ row: line, name: who, reason: `Month "${clean(r.month)}" not understood` }); continue; } }
      let paidOn = null;
      if (clean(r.paidOn)) { paidOn = toDate(r.paidOn); if (!paidOn) { skipped.push({ row: line, name: who, reason: `Date "${clean(r.paidOn)}" not understood` }); continue; } }
      const f = idx.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const ch = await client.query(
          `SELECT c.id, (c.amount - COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id),0))::float AS left
           FROM fee_charges c WHERE c.student_id = $1 AND c.school_id = $2
             AND ($3::text IS NULL OR c.month = $3) AND ($4::text IS NULL OR lower(c.title) = lower($4))
           ORDER BY c.month, c.created_at FOR UPDATE OF c`,
          [f.student.id, req.user.schoolId, month, clean(r.title) || null]);
        const open = ch.rows.filter((c) => c.left > 0.001);
        const balance = open.reduce((a, c) => a + c.left, 0);
        // the same payment uploaded twice is recognised and not added again
        const dup = await client.query(
          `SELECT 1 FROM fee_payments p JOIN fee_charges c ON c.id = p.charge_id
           WHERE c.student_id = $1 AND p.amount = $2 AND p.paid_on = COALESCE($3::date, CURRENT_DATE) AND p.note = 'Uploaded from a file' LIMIT 1`,
          [f.student.id, amount, paidOn]);
        if (dup.rowCount) { await client.query("ROLLBACK"); skipped.push({ row: line, name: f.student.name, reason: "This payment was already recorded" }); continue; }
        if (ch.rowCount === 0) { await client.query("ROLLBACK"); skipped.push({ row: line, name: f.student.name, reason: "No fee found for this student" + (month ? ` in ${month}` : "") }); continue; }
        if (amount > balance + 0.001) { await client.query("ROLLBACK"); skipped.push({ row: line, name: f.student.name, reason: balance <= 0.001 ? "Nothing is left to pay" : `Only ${balance} is left to pay` }); continue; }
        let rest = amount;
        for (const c of open) {
          if (rest <= 0.001) break;
          const part = Math.min(rest, c.left);
          await client.query("INSERT INTO fee_payments (charge_id, amount, method, note, paid_on) VALUES ($1,$2,$3,'Uploaded from a file',COALESCE($4::date, CURRENT_DATE))",
            [c.id, part, clean(r.method) || null, paidOn]);
          rest -= part;
        }
        await client.query("COMMIT");
        imported++;
      } catch { await client.query("ROLLBACK").catch(() => {}); skipped.push({ row: line, name: who, reason: "Could not be saved" }); }
      finally { client.release(); }
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- staff attendance
// row: { name | phone | email, date, status }
router.post("/staff-attendance", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const st = await staffIndex(req.user.schoolId);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.email || r.phone);
      const date = toDate(r.date);
      if (!date) { skipped.push({ row: line, name: who, reason: `Date "${clean(r.date)}" not understood` }); continue; }
      const status = toStatus(r.status);
      if (!status) { skipped.push({ row: line, name: who, reason: `Status "${clean(r.status)}" not understood. Use Present, Absent, Late or Leave` }); continue; }
      const f = st.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      await pool.query(
        `INSERT INTO staff_attendance (staff_id, att_date, status) VALUES ($1,$2,$3)
         ON CONFLICT (staff_id, att_date) DO UPDATE SET status = EXCLUDED.status`, [f.staff.id, date, status]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- monthly salaries
// row: { name | phone | email, salary }
router.post("/salary", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const st = await staffIndex(req.user.schoolId);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.email || r.phone);
      const salary = num(r.salary);
      if (salary === null || Number.isNaN(salary) || salary < 0) { skipped.push({ row: line, name: who, reason: `Salary "${clean(r.salary)}" is not a number` }); continue; }
      const f = st.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      await pool.query("UPDATE staff SET base_salary = $1 WHERE id = $2 AND school_id = $3", [salary, f.staff.id, req.user.schoolId]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- timetable
// row: { className, day, period, subject, teacher }. The classes named in the file get exactly the file's timetable.
// The whole file must arrive in one request, because a class is replaced as a whole.
router.post("/timetable", admin, async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = rowsOf(req, 3000);
    const secs = await sectionMap(req.user.schoolId);
    const teachers = await teacherIndex(req.user.schoolId);
    const skipped = [];
    const good = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.className);
      const sec = secs.find(r.className);
      if (sec.error) { skipped.push({ row: line, name: who, reason: sec.error }); continue; }
      const day = toDay(r.day), period = Number(clean(r.period));
      if (!day) { skipped.push({ row: line, name: who, reason: `Day "${clean(r.day)}" not understood. Use Monday to Saturday` }); continue; }
      if (!Number.isInteger(period) || period < 1 || period > 10) { skipped.push({ row: line, name: who, reason: "Period must be a number from 1 to 10" }); continue; }
      const subject = clean(r.subject);
      if (!subject) { skipped.push({ row: line, name: who, reason: "Subject is missing" }); continue; }
      const t = teachers.find(r.teacher);
      if (t.error) { skipped.push({ row: line, name: who, reason: t.error }); continue; }
      const key = `${sec.section.id}|${day}|${period}`;
      if (seen.has(key)) { skipped.push({ row: line, name: who, reason: "This class already has a lesson in that period in the file" }); continue; }
      seen.add(key);
      good.push({ row: line, who, sectionId: sec.section.id, label: `${sec.section.grade}-${sec.section.name}`, day, period, subject, teacherId: t.teacher ? t.teacher.id : null });
    }
    // a teacher cannot be in two classes in the same period, inside the file or against classes not in the file
    const inFile = new Set(good.map((g) => g.sectionId));
    const busy = new Map(); // teacher|day|period -> class label
    const keep = [];
    for (const g of good) {
      if (g.teacherId) {
        const k = `${g.teacherId}|${g.day}|${g.period}`;
        if (busy.has(k)) { skipped.push({ row: g.row, name: g.who, reason: `Clash: that teacher is already in ${busy.get(k)} in the same period` }); continue; }
        const o = await client.query(
          `SELECT s.grade, s.name FROM timetable_slots t JOIN sections s ON s.id = t.section_id
           WHERE t.teacher_id = $1 AND t.day = $2 AND t.period = $3 AND t.section_id <> ALL($4::uuid[]) LIMIT 1`,
          [g.teacherId, g.day, g.period, [...inFile]]);
        if (o.rowCount) { skipped.push({ row: g.row, name: g.who, reason: `Clash: that teacher is already in ${o.rows[0].grade}-${o.rows[0].name} in the same period` }); continue; }
        busy.set(k, g.label);
      }
      keep.push(g);
    }
    await client.query("BEGIN");
    const replaced = new Set(keep.map((g) => g.sectionId));
    for (const sid of replaced) await client.query("DELETE FROM timetable_slots WHERE section_id = $1", [sid]);
    for (const g of keep) {
      await client.query("INSERT INTO timetable_slots (section_id, day, period, subject, teacher_id) VALUES ($1,$2,$3,$4,$5)", [g.sectionId, g.day, g.period, g.subject, g.teacherId]);
    }
    await client.query("COMMIT");
    res.json({ imported: keep.length, classes: replaced.size, skipped: skipped.sort((a, b) => a.row - b.row) });
  } catch { await client.query("ROLLBACK").catch(() => {}); fail(res); }
  finally { client.release(); }
});

// ---------------------------------------------------------------- calendar events
const KINDS = ["holiday", "exam", "activity", "meeting", "other"];
function toKind(v) {
  const s = lc(v);
  if (!s) return "other";
  const hit = KINDS.find((k) => s.includes(k));
  if (hit) return hit;
  if (/eid|vacation|break|off|closed/.test(s)) return "holiday";
  if (/test|paper|exam/.test(s)) return "exam";
  if (/sport|trip|event|function/.test(s)) return "activity";
  return "other";
}
// row: { title, kind, startDate, endDate, details }
router.post("/events", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), title = clean(r.title);
      if (!title) { skipped.push({ row: line, reason: "Event name is missing" }); continue; }
      const start = toDate(r.startDate), end = clean(r.endDate) ? toDate(r.endDate) : start;
      if (!start || !end) { skipped.push({ row: line, name: title, reason: "Check the dates" }); continue; }
      if (end < start) { skipped.push({ row: line, name: title, reason: "The last day is before the first day" }); continue; }
      const dup = await pool.query("SELECT 1 FROM calendar_events WHERE school_id = $1 AND lower(title) = lower($2) AND start_date = $3 AND end_date = $4", [req.user.schoolId, title, start, end]);
      if (dup.rowCount) { skipped.push({ row: line, name: title, reason: "Already in the calendar" }); continue; }
      await pool.query("INSERT INTO calendar_events (school_id, title, kind, start_date, end_date, details) VALUES ($1,$2,$3,$4,$5,$6)",
        [req.user.schoolId, title.slice(0, 200), toKind(r.kind), start, end, clean(r.details).slice(0, 1000) || null]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- announcements
// row: { title, body, audience }
router.post("/announcements", admin, async (req, res) => {
  try {
    const rows = rowsOf(req);
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), title = clean(r.title);
      if (!title) { skipped.push({ row: line, reason: "Title is missing" }); continue; }
      const a = lc(r.audience);
      const audience = /teacher|staff/.test(a) ? "teachers" : /parent/.test(a) ? "parents" : "all";
      const body = clean(r.body).slice(0, 4000) || null;
      const dup = await pool.query("SELECT 1 FROM announcements WHERE school_id = $1 AND lower(title) = lower($2) AND COALESCE(body,'') = $3", [req.user.schoolId, title, body || ""]);
      if (dup.rowCount) { skipped.push({ row: line, name: title, reason: "Already posted" }); continue; }
      await pool.query("INSERT INTO announcements (school_id, title, body, audience, created_by) VALUES ($1,$2,$3,$4,$5)", [req.user.schoolId, title.slice(0, 200), body, audience, req.user.id]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- co-curricular activities
// row: { admissionNo | name (+className), activity, category, marks, total, note }
router.post("/activities", staffOnly, async (req, res) => {
  try {
    const rows = rowsOf(req);
    const idx = await studentIndex(req.user.schoolId);
    const allowed = new Map();
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.admissionNo);
      const activity = clean(r.activity);
      if (!activity) { skipped.push({ row: line, name: who, reason: "Activity is missing" }); continue; }
      const marks = num(r.marks), total = num(r.total);
      if (Number.isNaN(marks) || Number.isNaN(total)) { skipped.push({ row: line, name: who, reason: "Marks and total must be numbers" }); continue; }
      if (marks !== null && total !== null && marks > total) { skipped.push({ row: line, name: who, reason: "Marks are more than the total" }); continue; }
      const f = idx.find(r);
      if (f.error) { skipped.push({ row: line, name: who, reason: f.error }); continue; }
      const s = f.student;
      if (!s.section_id) { skipped.push({ row: line, name: s.name, reason: "This student has no class yet" }); continue; }
      if (!allowed.has(s.section_id)) allowed.set(s.section_id, await canUseSection(req.user, s.section_id));
      if (!allowed.get(s.section_id)) { skipped.push({ row: line, name: s.name, reason: `You do not teach class ${s.cls}` }); continue; }
      const dup = await pool.query(
        `SELECT 1 FROM activities WHERE student_id = $1 AND lower(activity) = lower($2) AND COALESCE(lower(category),'') = $3
           AND year = EXTRACT(YEAR FROM CURRENT_DATE)`, [s.id, activity, lc(r.category)]);
      if (dup.rowCount) { skipped.push({ row: line, name: s.name, reason: "Already recorded this year" }); continue; }
      await pool.query("INSERT INTO activities (school_id, student_id, category, activity, marks, total, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [req.user.schoolId, s.id, clean(r.category) || null, activity, marks, total, clean(r.note) || null]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch { fail(res); }
});

// ---------------------------------------------------------------- student attendance (one class)
// row: { admissionNo | name, date, status }   body: { classId }
router.post("/attendance", staffOnly, async (req, res) => {
  try {
    const rows = rowsOf(req, 3000);
    const klass = await assertClassAccess(req.body.classId, req.user);
    const mem = await pool.query(
      `SELECT id, name, admission_no FROM students WHERE school_id = $1 AND (class_id = $2 OR ($3::uuid IS NOT NULL AND section_id = $3::uuid))`,
      [req.user.schoolId, klass.id, klass.section_id || null]);
    const byAdm = new Map(mem.rows.filter((s) => s.admission_no).map((s) => [lc(s.admission_no), s]));
    let imported = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], line = lineOf(r, i), who = clean(r.name || r.admissionNo);
      const date = toDate(r.date);
      if (!date) { skipped.push({ row: line, name: who, reason: `Date "${clean(r.date)}" not understood` }); continue; }
      const status = toStatus(r.status);
      if (!status) { skipped.push({ row: line, name: who, reason: `Status "${clean(r.status)}" not understood. Use Present, Absent, Late or Leave` }); continue; }
      let s = null;
      if (clean(r.admissionNo)) s = byAdm.get(lc(r.admissionNo));
      else if (lc(r.name)) {
        const h = mem.rows.filter((x) => lc(x.name) === lc(r.name));
        if (h.length > 1) { skipped.push({ row: line, name: who, reason: "Several students have this name. Add the admission number" }); continue; }
        s = h[0];
      } else { skipped.push({ row: line, reason: "Admission number or student name is needed" }); continue; }
      if (!s) { skipped.push({ row: line, name: who, reason: "Not a student of this class" }); continue; }
      await pool.query(
        `INSERT INTO attendance (student_id, class_id, att_date, status) VALUES ($1,$2,$3,$4)
         ON CONFLICT (student_id, att_date) DO UPDATE SET status = EXCLUDED.status`, [s.id, klass.id, date, status]);
      imported++;
    }
    res.json({ imported, skipped });
  } catch (err) { res.status(err.status || 500).json({ error: err.message || "The upload could not be saved" }); }
});

module.exports = router;
