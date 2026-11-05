require("dotenv").config();
const express = require("express");
const cors = require("cors");
const migrate = require("./migrate");

const authRoutes = require("./routes/auth");
const classRoutes = require("./routes/classes");
const studentRoutes = require("./routes/students");
const attendanceRoutes = require("./routes/attendance");
const performanceRoutes = require("./routes/performance");
const adminRoutes = require("./routes/admin");
const parentRoutes = require("./routes/parent");
const aiRoutes = require("./routes/ai");
const schoolRoutes = require("./routes/school");
const sectionRoutes = require("./routes/sections");
const peopleRoutes = require("./routes/people");
const importRoutes = require("./routes/import");
const bulkRoutes = require("./routes/bulk");
const ownerRoutes = require("./routes/owner");
const examRoutes = require("./routes/exams");
const feeRoutes = require("./routes/fees");
const hrRoutes = require("./routes/hr");
const timetableRoutes = require("./routes/timetable");
const homeworkRoutes = require("./routes/homework");
const bookRoutes = require("./routes/books");
const boardRoutes = require("./routes/board");
const cronRoutes = require("./routes/cron");
const parentExtraRoutes = require("./routes/parentExtra");

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so each visitor has their own address
app.use(cors());
app.use(express.json({ limit: "5mb" })); // photos and spreadsheet imports are larger than the default

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/classes", classRoutes);
app.use("/classes", studentRoutes);
app.use("/classes", attendanceRoutes);
app.use("/classes", performanceRoutes);
app.use("/admin", adminRoutes);
app.use("/parent", parentRoutes);
app.use("/ai", aiRoutes);
app.use("/school", schoolRoutes);
app.use("/sections", sectionRoutes);
app.use("/people", peopleRoutes);
app.use("/import", importRoutes);
app.use("/bulk", bulkRoutes);
app.use("/owner", ownerRoutes);
app.use("/exams", examRoutes);
app.use("/fees", feeRoutes);
app.use("/hr", hrRoutes);
app.use("/timetable", timetableRoutes);
app.use("/homework", homeworkRoutes);
app.use("/books", bookRoutes);
app.use("/parent", parentExtraRoutes);
app.use("/cron", cronRoutes);
app.use("/board", boardRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error" });
});

const port = process.env.PORT || 4000;
const start = () => app.listen(port, () => console.log(`Smart Teacher backend running on port ${port}`));

// Update the database first, then start. If the update fails the server still starts,
// so /health works and the error is visible in the logs.
migrate().then(start).catch((e) => {
  console.error("Database update failed:", e.message);
  start();
});
