const express = require("express");
const pool = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { assertClassAccess } = require("../utils");

const router = express.Router();

// Mark attendance for a whole class on one date.
// body: { date: "2026-09-14", records: [{ studentId, status }] }
router.post("/:classId/attendance", requireAuth, requireRole("teacher"), async (req, res) => {
  const { date, records } = req.body;
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: "date and records[] are required" });

  const client = await pool.connect();
  try {
    await assertClassAccess(req.params.classId, req.user);
    await client.query("BEGIN");
    for (const r of records) {
      await client.query(
        `INSERT INTO attendance (student_id, class_id, att_date, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (student_id, att_date) DO UPDATE SET status = EXCLUDED.status`,
        [r.studentId, req.params.classId, date, r.status]
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(err.status || 500).json({ error: err.message || "Could not save attendance" });
  } finally {
    client.release();
  }
});

// Get one day's attendance for a class.
router.get("/:classId/attendance", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date query param is required" });
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      "SELECT student_id, status FROM attendance WHERE class_id = $1 AND att_date = $2",
      [req.params.classId, date]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not load attendance" });
  }
});

// Monthly rollup: present/late/total and percentage per student.
router.get("/:classId/attendance/monthly", requireAuth, async (req, res) => {
  const { month } = req.query; // "2026-09"
  if (!month) return res.status(400).json({ error: "month query param is required, e.g. 2026-09" });
  try {
    await assertClassAccess(req.params.classId, req.user);
    const result = await pool.query(
      `SELECT s.id AS student_id, s.name,
              COUNT(*) FILTER (WHERE a.status = 'present') AS present,
              COUNT(*) FILTER (WHERE a.status = 'late') AS late,
              COUNT(*) AS total
       FROM students s
       LEFT JOIN attendance a ON a.student_id = s.id AND to_char(a.att_date, 'YYYY-MM') = $2
       WHERE s.class_id = $1
       GROUP BY s.id, s.name
       ORDER BY s.name`,
      [req.params.classId, month]
    );
    const rows = result.rows.map((r) => ({
      ...r,
      pct: r.total > 0 ? Math.round(((Number(r.present) + Number(r.late) * 0.5) / Number(r.total)) * 100) : null,
    }));
    res.json(rows);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not load monthly attendance" });
  }
});

module.exports = router;
