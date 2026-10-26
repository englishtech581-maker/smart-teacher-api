const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// Everyone in the school can read the profile (name and photo).
router.get("/", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, name, city, school_type, phone, photo FROM schools WHERE id = $1",
      [req.user.schoolId]
    );
    res.json(r.rows[0] || null);
  } catch {
    res.status(500).json({ error: "Could not load the school profile" });
  }
});

router.patch("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, city, schoolType, phone, photo } = req.body;
  if (photo && (!String(photo).startsWith("data:image/") || String(photo).length > 900000)) {
    return res.status(400).json({ error: "The photo must be an image under about 600 KB" });
  }
  try {
    const r = await pool.query(
      `UPDATE schools SET
         name = COALESCE($1, name), city = COALESCE($2, city), school_type = COALESCE($3, school_type),
         phone = COALESCE($4, phone), photo = COALESCE($5, photo)
       WHERE id = $6
       RETURNING id, name, city, school_type, phone, photo`,
      [name || null, city ?? null, schoolType ?? null, phone ?? null, photo || null, req.user.schoolId]
    );
    res.json(r.rows[0]);
  } catch {
    res.status(500).json({ error: "Could not save the school profile" });
  }
});

module.exports = router;
