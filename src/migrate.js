// Brings the database up to date every time the server starts.
// Every step is safe to run again, so nothing needs to be pasted into Supabase by hand.
const pool = require("./db");

const STEPS = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  // earlier changes (phone login for parents, conduct tracking)
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_phone TEXT`,
  `ALTER TABLE performance ADD COLUMN IF NOT EXISTS conduct_status TEXT`,
  `ALTER TABLE performance ADD COLUMN IF NOT EXISTS conduct_notes TEXT`,

  // school profile
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS city TEXT`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS school_type TEXT`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS photo TEXT`,

  // sections such as 7-A, each with a class teacher
  `CREATE TABLE IF NOT EXISTS sections (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     grade TEXT NOT NULL,
     name TEXT NOT NULL,
     class_teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ DEFAULT now(),
     UNIQUE (school_id, grade, name)
   )`,

  // fuller student records
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS school_id UUID REFERENCES schools(id) ON DELETE CASCADE`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id) ON DELETE SET NULL`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS admission_no TEXT`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS gender TEXT`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS guardian_name TEXT`,
  `UPDATE students s SET school_id = c.school_id FROM classes c WHERE s.class_id = c.id AND s.school_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS students_admission_uq ON students (school_id, admission_no) WHERE admission_no IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS students_school_idx ON students (school_id)`,
  `CREATE INDEX IF NOT EXISTS students_section_idx ON students (section_id)`,

  // a teaching class can be tied to a section, so the teacher sees that section's students
  `ALTER TABLE classes ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id) ON DELETE SET NULL`,

  // staff records (teaching and non-teaching)
  `CREATE TABLE IF NOT EXISTS staff (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     role TEXT,
     department TEXT,
     phone TEXT,
     email TEXT,
     joined_on DATE,
     user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS staff_school_idx ON staff (school_id)`,

  // AI: daily request counter per person, and saved lesson guides so the same topic is never paid for twice
  `CREATE TABLE IF NOT EXISTS ai_usage (
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     day DATE NOT NULL DEFAULT CURRENT_DATE,
     count INT NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day)
   )`,
  `CREATE TABLE IF NOT EXISTS ai_cache (
     key TEXT PRIMARY KEY,
     response JSONB NOT NULL,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
];

async function migrate() {
  for (const sql of STEPS) await pool.query(sql);
  console.log("Database is up to date");
}

module.exports = migrate;
