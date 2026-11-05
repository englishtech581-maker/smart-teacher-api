// The owner of the app (the person who sells it) invites schools here. Protected by the OWNER_KEY
// set in the server's environment; without it nothing in this file works.
const express = require("express");
const crypto = require("crypto");
const pool = require("../db");

const router = express.Router();
const fails = new Map(); // ip -> { n, until }

function guard(req, res, next) {
  const key = process.env.OWNER_KEY;
  if (!key || key.length < 12) return res.status(503).json({ error: "OWNER_KEY is not set on the server (at least 12 characters)" });
  const f = fails.get(req.ip);
  if (f && f.n >= 8 && f.until > Date.now()) return res.status(429).json({ error: "Too many wrong keys. Try again in 15 minutes." });
  const given = Buffer.from(String(req.get("x-owner-key") || ""));
  const want = Buffer.from(key);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    const n = f && f.until > Date.now() ? f.n + 1 : 1;
    fails.set(req.ip, { n, until: Date.now() + 15 * 60 * 1000 });
    return res.status(401).json({ error: "Wrong owner key" });
  }
  fails.delete(req.ip);
  next();
}
router.use(express.json());
router.use(guard);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() {
  const b = crypto.randomBytes(8);
  const c = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

router.post("/codes", async (req, res) => {
  try {
    const note = String(req.body.note || "").trim().slice(0, 120) || null;
    const r = await pool.query("INSERT INTO signup_codes (code, note) VALUES ($1, $2) RETURNING id, code, note, created_at", [newCode(), note]);
    res.status(201).json(r.rows[0]);
  } catch { res.status(500).json({ error: "Could not make a code" }); }
});

router.get("/codes", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.code, c.note, c.created_at, c.used_at, s.name AS school
       FROM signup_codes c LEFT JOIN schools s ON s.id = c.school_id ORDER BY c.created_at DESC LIMIT 200`);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the codes" }); }
});

router.delete("/codes/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM signup_codes WHERE id = $1 AND used_at IS NULL", [req.params.id]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not delete the code" }); }
});

// Every school on the app, with its size.
router.get("/schools", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.city, s.created_at,
         (SELECT COUNT(*) FROM students x WHERE x.school_id = s.id)::int AS students,
         (SELECT COUNT(*) FROM users u WHERE u.school_id = s.id AND u.role = 'teacher')::int AS teachers,
         (SELECT u.email FROM users u WHERE u.school_id = s.id AND u.role = 'admin' ORDER BY u.created_at LIMIT 1) AS admin_email
       FROM schools s ORDER BY s.created_at DESC`);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the schools" }); }
});

module.exports = router;
