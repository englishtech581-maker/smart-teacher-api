const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sectionFor } = require("../utils");
const { normPhone, parseClass, toDate } = require("../text");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

const clean = (v) => String(v ?? "").trim();

// Rows arrive already read from the Excel or CSV file by the browser.
// Each row is saved on its own, so one bad row never blocks the others.
router.post("/students", async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 1000) : [];
  const schoolId = req.user.schoolId;
  const sections = {};
  let imported = 0;
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = r.row || i + 2; // row number in the spreadsheet, counting the header
    const name = clean(r.name);
    if (!name) { skipped.push({ row: line, reason: "Name is missing" }); continue; }
    try {
      let sectionId = null;
      if (clean(r.className)) {
        const c = parseClass(r.className);
        if (!c) { skipped.push({ row: line, name, reason: `Class "${clean(r.className)}" not understood` }); continue; }
        const key = c.grade + "|" + c.section;
        sections[key] = sections[key] || (await sectionFor(pool, schoolId, c.grade, c.section));
        sectionId = sections[key];
      }
      const adm = clean(r.admissionNo) || null;
      const phone = normPhone(r.parentPhone) || null;
      if (!adm) {
        const dup = await pool.query(
          `SELECT 1 FROM students WHERE school_id = $1 AND lower(name) = lower($2)
             AND section_id IS NOT DISTINCT FROM $3 AND COALESCE(parent_phone, '') = $4 LIMIT 1`,
          [schoolId, name, sectionId, phone || ""]
        );
        if (dup.rowCount) { skipped.push({ row: line, name, reason: "Already in the school" }); continue; }
      }
      const ins = await pool.query(
        `INSERT INTO students (school_id, section_id, name, admission_no, gender, guardian_name, parent_phone, parent_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (school_id, admission_no) WHERE admission_no IS NOT NULL DO NOTHING
         RETURNING id`,
        [schoolId, sectionId, name, adm, clean(r.gender) || null, clean(r.guardianName) || null, phone,
         clean(r.parentEmail) ? clean(r.parentEmail).toLowerCase() : null]
      );
      if (ins.rowCount) imported++;
      else skipped.push({ row: line, name, reason: "Admission number already exists" });
    } catch {
      skipped.push({ row: line, name, reason: "Could not be saved" });
    }
  }
  res.json({ imported, skipped });
});

router.post("/staff", async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 1000) : [];
  let imported = 0;
  const skipped = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = r.row || i + 2;
    const name = clean(r.name);
    if (!name) { skipped.push({ row: line, reason: "Name is missing" }); continue; }
    try {
      const phone = normPhone(r.phone) || null;
      const dup = await pool.query(
        "SELECT 1 FROM staff WHERE school_id = $1 AND lower(name) = lower($2) AND COALESCE(phone, '') = $3 LIMIT 1",
        [req.user.schoolId, name, phone || ""]
      );
      if (dup.rowCount) { skipped.push({ row: line, name, reason: "Already in the school" }); continue; }
      await pool.query(
        `INSERT INTO staff (school_id, name, role, department, phone, email, joined_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.schoolId, name, clean(r.role) || null, clean(r.department) || null, phone,
         clean(r.email) ? clean(r.email).toLowerCase() : null, toDate(r.joinedOn)]
      );
      imported++;
    } catch {
      skipped.push({ row: line, name, reason: "Could not be saved" });
    }
  }
  res.json({ imported, skipped });
});

module.exports = router;
