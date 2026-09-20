const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, schoolId: user.school_id, role: user.role, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

router.post("/register", async (req, res) => {
  const { name, email, password, role, schoolName, schoolId } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password and role are required" });
  }
  if (!["admin", "teacher", "parent"].includes(role)) {
    return res.status(400).json({ error: "role must be admin, teacher or parent" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let finalSchoolId = schoolId;
    if (role === "admin") {
      if (!schoolName) throw { status: 400, message: "schoolName is required to register as admin" };
      const schoolResult = await client.query(
        "INSERT INTO schools (name) VALUES ($1) RETURNING id",
        [schoolName]
      );
      finalSchoolId = schoolResult.rows[0].id;
    } else {
      if (!schoolId) throw { status: 400, message: "schoolId is required for teacher/parent registration" };
      const schoolCheck = await client.query("SELECT id FROM schools WHERE id = $1", [schoolId]);
      if (schoolCheck.rowCount === 0) throw { status: 404, message: "School not found" };
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      `INSERT INTO users (school_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, school_id, name, email, role`,
      [finalSchoolId, name, email.toLowerCase(), passwordHash, role]
    );

    await client.query("COMMIT");
    const user = userResult.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "Registration failed" });
  } finally {
    client.release();
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid email or password" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid email or password" });

    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(user), user: safeUser });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
