const pool = require("./db");

async function assertClassAccess(classId, user) {
  const result = await pool.query("SELECT * FROM classes WHERE id = $1", [classId]);
  const klass = result.rows[0];
  if (!klass) throw { status: 404, message: "Class not found" };
  const allowed = klass.teacher_id === user.id || (user.role === "admin" && klass.school_id === user.schoolId);
  if (!allowed) throw { status: 403, message: "Not allowed to access this class" };
  return klass;
}

module.exports = { assertClassAccess };
