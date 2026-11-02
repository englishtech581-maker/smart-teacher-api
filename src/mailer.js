// Sends email through any SMTP service (Gmail app password, Brevo, Resend SMTP...).
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM
// MAIL_DRY_RUN=1 only prints the emails to the server log (for testing).
const nodemailer = require("nodemailer");

let transport = null;
const dry = () => process.env.MAIL_DRY_RUN === "1";
const configured = () => dry() || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function get() {
  if (transport) return transport;
  transport = dry()
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
  return transport;
}

async function send({ to, subject, text, fromName }) {
  const from = `"${String(fromName || "School").replace(/"/g, "")}" <${process.env.MAIL_FROM || process.env.SMTP_USER || "school@example.com"}>`;
  const info = await get().sendMail({ from, to, subject, text });
  if (dry()) console.log("[dry-run email]", to, subject);
  return info;
}

module.exports = { send, configured };
