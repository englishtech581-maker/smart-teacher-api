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

// "7-A", "7A", "Class 7 A", "10th B", "7" -> { grade: "7", section: "A" }
function parseClass(v) {
  const s = String(v || "")
    .replace(/class|grade/gi, "")
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .trim();
  const m = s.match(/^(\d+|[A-Za-z]+)\s*[-\s]?\s*([A-Za-z]?)$/);
  if (!m) return null;
  return { grade: m[1], section: (m[2] || "A").toUpperCase() };
}

function toDate(v) {
  const d = new Date(String(v || ""));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

module.exports = { normPhone, normId, parseClass, toDate };
