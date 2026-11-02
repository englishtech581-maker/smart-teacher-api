const pool = require("./db");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
// today's date and month in Pakistan time, whatever time zone the server runs in
const pkt = () => new Date(Date.now() + 5 * 3600 * 1000);
const todayPK = () => pkt().toISOString().slice(0, 10);
const monthPK = () => pkt().toISOString().slice(0, 7);

const PAID = "COALESCE((SELECT SUM(p.amount) FROM fee_payments p WHERE p.charge_id = c.id), 0)";

// One student's fee voucher for a month: this month's fees plus anything still unpaid from earlier months.
async function buildVoucher(studentId, month) {
  const st = await pool.query(
    `SELECT s.id, s.name, s.admission_no, s.guardian_name, s.school_id, sec.grade, sec.name AS section, sch.name AS school_name, sch.phone AS school_phone,
            COALESCE(fs.due_day, 10) AS due_day
     FROM students s LEFT JOIN sections sec ON sec.id = s.section_id JOIN schools sch ON sch.id = s.school_id
     LEFT JOIN fee_settings fs ON fs.school_id = s.school_id WHERE s.id = $1`, [studentId]);
  const s = st.rows[0];
  if (!s) return null;
  const items = (await pool.query(`SELECT c.title, c.amount::float AS amount, ${PAID}::float AS paid FROM fee_charges c WHERE c.student_id = $1 AND c.month = $2 ORDER BY c.title`, [studentId, month])).rows;
  const prev = (await pool.query(`SELECT COALESCE(SUM(c.amount - ${PAID}), 0)::float AS due FROM fee_charges c WHERE c.student_id = $1 AND c.month < $2`, [studentId, month])).rows[0].due;
  const current = items.reduce((a, x) => a + x.amount, 0);
  const paid = items.reduce((a, x) => a + x.paid, 0);
  const due = String(Math.min(Number(s.due_day), 28)).padStart(2, "0");
  return {
    school: s.school_name, schoolPhone: s.school_phone,
    student: { id: s.id, name: s.name, admissionNo: s.admission_no, guardian: s.guardian_name, grade: s.grade, section: s.section },
    month, monthName: monthName(month), voucherNo: `${month.replace("-", "")}-${s.admission_no || s.id.slice(0, 6)}`,
    items, previousDues: prev, current, paid, balance: current - paid + prev, dueDate: `${month}-${due}`,
  };
}

module.exports = { buildVoucher, monthName, todayPK, monthPK, pkt, PAID };
