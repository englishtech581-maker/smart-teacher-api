const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { normId, GENDER_TYPES } = require("../text");
const pool = require("../db");
const crypto = require("crypto");
const mailer = require("../mailer");

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, schoolId: user.school_id, role: user.role, name: user.name, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
}

/**
 * Register a new user.
 * - role "admin": also creates a brand-new school (schoolName required).
 * - role "teacher" or "parent": joins an existing school (schoolId required).
 */
router.post("/register", async (req, res) => {
  const { name, email, password, role, schoolName, schoolId, genderType } = req.body;
  const inviteCode = String(req.body.inviteCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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
      // Only a school the owner has invited may register: each invitation code works once.
      if (!inviteCode) throw { status: 403, message: "A new school needs an invitation code from the owner of this app" };
      const code = await client.query("SELECT id FROM signup_codes WHERE replace(code, '-', '') = $1 AND used_at IS NULL FOR UPDATE", [inviteCode]);
      if (code.rowCount === 0) throw { status: 403, message: "This invitation code is not valid or was already used" };
      const schoolResult = await client.query(
        "INSERT INTO schools (name, gender_type) VALUES ($1, $2) RETURNING id",
        [schoolName, GENDER_TYPES.includes(genderType) ? genderType : null]
      );
      finalSchoolId = schoolResult.rows[0].id;
      await client.query("UPDATE signup_codes SET used_at = now(), school_id = $1 WHERE id = $2", [finalSchoolId, code.rows[0].id]);
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
      [finalSchoolId, name, normId(email), passwordHash, role]
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
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [normId(email)]);
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

// ---- forgotten password ----
// 1. The person types the email they log in with. If an account has it, a one-hour link is emailed.
// 2. The link opens the app with a form for the new password.
// The answer is the same whether or not the email exists, so nobody can use this to find out who has an account.
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const APP_URL = () => (process.env.APP_URL || "https://smart-teacher-frontend-phi.vercel.app").replace(/\/$/, "");

router.post("/forgot", async (req, res) => {
  const id = normId(req.body.email || "");
  if (!id) return res.status(400).json({ error: "Type the email you use to log in" });
  const mailReady = mailer.configured();
  try {
    const u = (await pool.query("SELECT id, name, email, school_id FROM users WHERE email = $1", [id])).rows[0];
    if (u && mailReady && u.email.includes("@")) {
      const recent = (await pool.query("SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'", [u.id])).rows[0].n;
      if (recent < 3) {
        const token = crypto.randomBytes(32).toString("hex");
        await pool.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [sha(token), u.id]);
        const school = (await pool.query("SELECT name FROM schools WHERE id = $1", [u.school_id])).rows[0];
        try {
          await mailer.send({
            to: u.email, fromName: school ? school.name : "Institute Assistant", subject: "Reset your password",
            text: `Assalam o Alaikum ${u.name},\n\nSomeone asked to reset the password for this account. Open this link within one hour to choose a new password:\n\n${APP_URL()}/?reset=${token}\n\nIf you did not ask for this, ignore this email. Your password stays the same.`,
          });
        } catch (e) { console.error("Reset email failed:", e.message); }
      }
    }
    res.json({ ok: true, mailReady });
  } catch { res.status(500).json({ error: "Could not start the password reset" }); }
});

router.post("/reset", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "The link or the new password is missing" });
  if (String(password).length < 6) return res.status(400).json({ error: "The password needs at least 6 characters" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = (await client.query("SELECT user_id FROM password_resets WHERE token_hash = $1 AND used = false AND expires_at > now() FOR UPDATE", [sha(String(token))])).rows[0];
    if (!r) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This link has expired or was already used. Ask for a new one." }); }
    await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(String(password), 10), r.user_id]);
    await client.query("UPDATE password_resets SET used = true WHERE user_id = $1", [r.user_id]);
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch { await client.query("ROLLBACK").catch(() => {}); res.status(500).json({ error: "Could not change the password" }); }
  finally { client.release(); }
});

module.exports = router;
