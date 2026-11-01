// Small text helpers shared by several routes.

// Pakistani mobile numbers come in many shapes: 0300-1234567, +92 300 1234567, 3001234567.
// Everything is reduced to the plain 11-digit form 03001234567 so that a parent who types
// their number differently from the school still matches.
function normPhone(p) {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0092")) d = d.slice(4);
  else if (d.startsWith("92") && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith("3")) d = "0" + d;
  return d;
}

// A login name is either an email (lower-cased) or a phone number (digits only).
function normId(v) {
  const s = String(v || "").trim();
  return s.includes("@") ? s.toLowerCase() : normPhone(s);
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const EARLY = ["nursery", "prep", "kg", "lkg", "ukg", "pg", "playgroup", "montessori", "reception"];

// "7-A", "7A", "Class 7 A", "10th B", "Seven A", "KG" -> { grade: "7", section: "A" }
// Anything that is not a number, a number word or a known early class is refused, so a typo
// cannot create a new class by accident.
function parseClass(v) {
  const s = String(v || "")
    .replace(/class|grade/gi, "")
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .trim();
  const m = s.match(/^(\d+|[A-Za-z]+)\s*[-\s]?\s*([A-Za-z]?)$/);
  if (!m) return null;
  let grade = m[1];
  if (!/^\d+$/.test(grade)) {
    const w = grade.toLowerCase();
    if (WORDS[w]) grade = String(WORDS[w]);
    else if (EARLY.includes(w)) grade = w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
    else return null;
  }
  return { grade, section: (m[2] || "A").toUpperCase() };
}

// Dates arrive as 2017-04-01 (from the spreadsheet reader) or typed by hand as 01/04/2017.
// Typed dates are read day first, the way they are written in Pakistan.
function toDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/))) {
    d = +m[1]; mo = +m[2]; y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
  } else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null; // not a real date
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

module.exports = { normPhone, normId, parseClass, toDate };
