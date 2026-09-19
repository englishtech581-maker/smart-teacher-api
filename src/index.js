require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const classRoutes = require("./routes/classes");
const studentRoutes = require("./routes/students");
const attendanceRoutes = require("./routes/attendance");
const performanceRoutes = require("./routes/performance");
const adminRoutes = require("./routes/admin");
const parentRoutes = require("./routes/parent");
const aiRoutes = require("./routes/ai");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/classes", classRoutes);
app.use("/classes", studentRoutes);
app.use("/classes", attendanceRoutes);
app.use("/classes", performanceRoutes);
app.use("/admin", adminRoutes);
app.use("/parent", parentRoutes);
app.use("/ai", aiRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Smart Teacher backend running on port ${port}`));
