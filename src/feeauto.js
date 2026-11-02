const pool = require("./db");
const mailer = require("./mailer");
const { monthName, monthPK, PAID } = require("./voucher");

const rs = (n) => "Rs " + Math.round(Number(n)).toLocaleString("en-PK");

function voucherText(school, name, cls, month, total, dueDate, no) {
  return `Assalam o Alaikum. Fee voucher for ${name}${cls ? ` (Class ${cls})` : ""}, ${monthName(month)}: ${rs(total)}, to be paid by ${dueDate}. Voucher no. ${no}. You can see and print it in the parent portal. - ${school}\n` +
    `السلام علیکم! ${name} کی ${monthName(month)} کی فیس ${rs(total)} ہے، آخری تاریخ ${dueDate}۔ واؤچر نمبر ${no}۔ — ${school}`;
}
function reminderText(school, name, month, balance) {
  return `Reminder: the fee of ${rs(balance)} for ${name} (${monthName(month)}) has not been paid yet. Please pay at the school office. Please ignore this message if you have already paid. - ${school}\n` +
    `یاد دہانی: ${name} کی ${monthName(month)} کی ${rs(balance)} فیس ابھی تک ادا نہیں ہوئی۔ براہِ کرم اسکول آفس میں جمع کروائیں۔ اگر جمع ہو چکی ہے تو اس پیغام کو نظرانداز کریں۔ — ${school}`;
}

// Everything the automatic fee system does for one school. It is safe to run any number of times a day:
// fees, vouchers and reminders are each created only once.
async function runAuto(schoolId) {
  const out = { charged: 0, vouchers: 0, reminders: 0, emailed: 0, emailFailed: 0 };
  await pool.query("INSERT INTO fee_settings (school_id) VALUES ($1) ON CONFLICT DO NOTHING", [schoolId]);
  const set = (await pool.query("SELECT * FROM fee_settings WHERE school_id = $1", [schoolId])).rows[0];
  const school = (await pool.query("SELECT name FROM schools WHERE id = $1", [schoolId])).rows[0].name;
  const month = monthPK();

  // 1. this month's fees, from the fee plans
  const plans = (await pool.query("SELECT * FROM fee_plans WHERE school_id = $1", [schoolId])).rows;
  for (const p of plans) {
    const r = await pool.query(
      `INSERT INTO fee_charges (school_id, student_id, title, month, amount)
       SELECT $1, s.id, $2, $3, $4 FROM students s WHERE s.school_id = $1 AND ($5::uuid IS NULL OR s.section_id = $5::uuid)
       ON CONFLICT (student_id, title, month) DO NOTHING`, [schoolId, p.title, month, p.amount, p.section_id]);
    out.charged += r.rowCount;
  }

  // 2. a voucher message for every student who owes something this month
  const owing = (await pool.query(
    `SELECT s.id, s.name, s.admission_no, s.parent_phone, s.parent_email, sec.grade, sec.name AS section,
            SUM(c.amount - ${PAID})::float AS balance
     FROM fee_charges c JOIN students s ON s.id = c.student_id LEFT JOIN sections sec ON sec.id = s.section_id
     WHERE c.school_id = $1 AND c.month = $2
       AND NOT EXISTS (SELECT 1 FROM fee_notices n WHERE n.student_id = s.id AND n.kind = 'voucher' AND n.month = $2)
     GROUP BY s.id, sec.grade, sec.name HAVING SUM(c.amount - ${PAID}) > 0`, [schoolId, month])).rows;
  const dueDate = `${month}-${String(Math.min(set.due_day, 28)).padStart(2, "0")}`;
  for (const s of owing) {
    // include earlier unpaid months in the amount quoted
    const prev = (await pool.query(`SELECT COALESCE(SUM(c.amount - ${PAID}),0)::float AS d FROM fee_charges c WHERE c.student_id = $1 AND c.month < $2`, [s.id, month])).rows[0].d;
    const no = `${month.replace("-", "")}-${s.admission_no || s.id.slice(0, 6)}`;
    const msg = voucherText(school, s.name, s.grade ? `${s.grade}-${s.section}` : "", month, s.balance + prev, dueDate, no);
    const r = await pool.query(
      `INSERT INTO fee_notices (school_id, student_id, kind, month, message, phone, email) VALUES ($1,$2,'voucher',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [schoolId, s.id, month, msg, s.parent_phone, s.parent_email]);
    out.vouchers += r.rowCount;
  }

  // 3. one reminder for every voucher that is still unpaid after the waiting days
  const late = (await pool.query(
    `SELECT n.student_id, n.month, s.name, s.parent_phone, s.parent_email,
            COALESCE((SELECT SUM(c.amount - ${PAID}) FROM fee_charges c WHERE c.student_id = n.student_id AND c.month = n.month), 0)::float AS balance
     FROM fee_notices n JOIN students s ON s.id = n.student_id
     WHERE n.school_id = $1 AND n.kind = 'voucher' AND n.created_at <= now() - ($2 || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM fee_notices r WHERE r.student_id = n.student_id AND r.kind = 'reminder' AND r.month = n.month)`,
    [schoolId, String(set.reminder_days)])).rows;
  for (const l of late) {
    if (l.balance <= 0) continue;
    const r = await pool.query(
      `INSERT INTO fee_notices (school_id, student_id, kind, month, message, phone, email) VALUES ($1,$2,'reminder',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [schoolId, l.student_id, l.month, reminderText(school, l.name, l.month, l.balance), l.parent_phone, l.parent_email]);
    out.reminders += r.rowCount;
  }

  // 4. email whatever has an email address (when sending email is set up)
  if (mailer.configured()) {
    const todo = (await pool.query("SELECT id, kind, month, message, email FROM fee_notices WHERE school_id = $1 AND emailed = false AND email IS NOT NULL", [schoolId])).rows;
    for (const n of todo) {
      try {
        await mailer.send({ to: n.email, fromName: school, subject: `${n.kind === "reminder" ? "Fee reminder" : "Fee voucher"}, ${monthName(n.month)} - ${school}`, text: n.message });
        await pool.query("UPDATE fee_notices SET emailed = true WHERE id = $1", [n.id]);
        out.emailed++;
      } catch (e) { console.error("Email failed:", e.message); out.emailFailed++; }
    }
  }
  return out;
}

module.exports = { runAuto };
