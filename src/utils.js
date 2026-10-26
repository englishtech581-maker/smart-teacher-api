const pool = require("./db");

/**
 * Confirms the class exists and the requesting user is allowed to touch it:
 * the owning teacher, or an admin from the same school. Throws {status, message}.
 */
async function assertClassAccess(classId, user) {
  const result = await pool.query("SELECT * FROM classes WHERE id = $1", [classId]);
  const klass = result.rows[0];
  if (!klass) throw { status: 404, message: "Class not found" };
  const allowed = klass.teacher_id === user.id || (user.role === "admin" && klass.school_id === user.schoolId);
  if (!allowed) throw { status: 403, message: "Not allowed to access this class" };
  return klass;
}

// Finds the section (for example 7-A) in this school, creating it when it is new.
async function sectionFor(db, schoolId, grade, name) {
  const r = await db.query(
    `INSERT INTO sections (school_id, grade, name) VALUES ($1, $2, $3)
     ON CONFLICT (school_id, grade, name) DO UPDATE SET grade = EXCLUDED.grade
     RETURNING id`,
    [schoolId, grade, name]
  );
  return r.rows[0].id;
}

module.exports = { assertClassAccess, sectionFor };
