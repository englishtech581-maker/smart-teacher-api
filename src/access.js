const pool = require("./db");
const { normPhone } = require("./text");

// Can this teacher or admin work with this section's students?
// Admins: any section of their school. Teachers: sections they teach a class in, or are class teacher of.
async function canUseSection(user, sectionId) {
  const sec = await pool.query("SELECT * FROM sections WHERE id = $1 AND school_id = $2", [sectionId, user.schoolId]);
  if (sec.rowCount === 0) return false;
  if (user.role === "admin") return true;
  if (sec.rows[0].class_teacher_id === user.id) return true;
  const c = await pool.query("SELECT 1 FROM classes WHERE section_id = $1 AND teacher_id = $2 LIMIT 1", [sectionId, user.id]);
  return c.rowCount > 0;
}

// Is this student one of the logged-in parent's children (matched by email or phone)?
async function parentOwns(user, studentId) {
  const loginId = String(user.email || "").toLowerCase();
  const r = await pool.query(
    "SELECT 1 FROM students WHERE id = $1 AND (parent_email = $2 OR parent_phone = $3)",
    [studentId, loginId, normPhone(loginId) || "-"]
  );
  return r.rowCount > 0;
}

// Staff, teachers and admins may look at any student of their school; a parent only at their own children.
async function canSeeStudent(user, studentId) {
  if (user.role === "parent") return parentOwns(user, studentId);
  const r = await pool.query("SELECT section_id FROM students WHERE id = $1 AND school_id = $2", [studentId, user.schoolId]);
  if (r.rowCount === 0) return false;
  if (user.role === "admin") return true;
  return r.rows[0].section_id ? canUseSection(user, r.rows[0].section_id) : false;
}

module.exports = { canUseSection, parentOwns, canSeeStudent };
