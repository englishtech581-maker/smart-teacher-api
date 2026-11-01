const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin", "teacher"));

const CHUNK = 1500;
// Cut text into pieces of about 1500 characters, breaking at the end of a sentence or line where possible.
function split(text) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK, clean.length);
    if (end < clean.length) {
      const cut = Math.max(clean.lastIndexOf("\n", end), clean.lastIndexOf(". ", end));
      if (cut > i + CHUNK * 0.5) end = cut + 1;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
  }
  return out;
}

router.get("/", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.title, b.grade, b.subject, b.added_by, (SELECT COUNT(*) FROM book_chunks c WHERE c.book_id = b.id)::int AS pieces
       FROM books b WHERE b.school_id = $1 ORDER BY b.grade, b.subject, b.title`, [req.user.schoolId]);
    res.json(r.rows);
  } catch { res.status(500).json({ error: "Could not load the books" }); }
});

router.post("/", async (req, res) => {
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Give the book a title" });
  try {
    const r = await pool.query("INSERT INTO books (school_id, title, grade, subject, added_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [req.user.schoolId, title, req.body.grade || null, req.body.subject || null, req.user.id]);
    res.status(201).json({ id: r.rows[0].id });
  } catch { res.status(500).json({ error: "Could not add the book" }); }
});

// The browser sends the book's text in parts. Each part is cut into pieces and stored in order.
router.post("/:id/text", async (req, res) => {
  const text = String(req.body.text || "");
  if (!text.trim()) return res.status(400).json({ error: "No text to add" });
  const client = await pool.connect();
  try {
    const own = await client.query("SELECT 1 FROM books WHERE id = $1 AND school_id = $2", [req.params.id, req.user.schoolId]);
    if (own.rowCount === 0) return res.status(404).json({ error: "Book not found" });
    const pieces = split(text);
    await client.query("BEGIN");
    const next = (await client.query("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM book_chunks WHERE book_id = $1", [req.params.id])).rows[0].n;
    for (let k = 0; k < pieces.length; k++) {
      await client.query("INSERT INTO book_chunks (book_id, idx, body) VALUES ($1,$2,$3)", [req.params.id, next + k, pieces[k]]);
    }
    await client.query("COMMIT");
    res.status(201).json({ added: pieces.length });
  } catch { await client.query("ROLLBACK").catch(() => {}); res.status(500).json({ error: "Could not save the text" }); }
  finally { client.release(); }
});

router.delete("/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM books WHERE id = $1 AND school_id = $2 AND ($3 = 'admin' OR added_by = $4)", [req.params.id, req.user.schoolId, req.user.role, req.user.id]);
    res.status(204).end();
  } catch { res.status(500).json({ error: "Could not delete the book" }); }
});

// The passages of a book that best match what the teacher wants to teach.
// Pieces are scored by how many of the topic's words they contain; the best few are returned in book order.
async function bookContext(bookId, schoolId, query, maxChars = 6000) {
  const b = await pool.query("SELECT title FROM books WHERE id = $1 AND school_id = $2", [bookId, schoolId]);
  if (b.rowCount === 0) return null;
  const rows = (await pool.query("SELECT idx, body FROM book_chunks WHERE book_id = $1 ORDER BY idx", [bookId])).rows;
  const words = [...new Set(String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))];
  const scored = rows.map((r) => {
    const low = r.body.toLowerCase();
    let score = 0;
    for (const w of words) { const m = low.split(w).length - 1; if (m) score += 1 + Math.min(m, 5) * 0.3; }
    return { ...r, score };
  }).filter((r) => r.score > 0).sort((a, b2) => b2.score - a.score);
  const picked = [];
  let used = 0;
  for (const r of scored) {
    if (used + r.body.length > maxChars) continue;
    picked.push(r); used += r.body.length;
    if (picked.length >= 6) break;
  }
  picked.sort((a, b2) => a.idx - b2.idx);
  return { title: b.rows[0].title, text: picked.map((p) => p.body).join("\n---\n"), found: picked.length };
}

module.exports = router;
module.exports.bookContext = bookContext;
