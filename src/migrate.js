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
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS gender_type TEXT`, // boys, girls or coed

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

  // ---- exams, marks, co-curricular ----
  `CREATE TABLE IF NOT EXISTS exams (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     term TEXT,
     year INT NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS exam_marks (
     exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
     student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
     subject TEXT NOT NULL,
     marks NUMERIC NOT NULL,
     total NUMERIC NOT NULL,
     PRIMARY KEY (exam_id, student_id, subject)
   )`,
  `CREATE TABLE IF NOT EXISTS activities (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
     category TEXT,
     activity TEXT NOT NULL,
     marks NUMERIC,
     total NUMERIC,
     year INT NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE),
     note TEXT,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // ---- fees ----
  `CREATE TABLE IF NOT EXISTS fee_charges (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     month TEXT NOT NULL,
     amount NUMERIC NOT NULL,
     created_at TIMESTAMPTZ DEFAULT now(),
     UNIQUE (student_id, title, month)
   )`,
  `CREATE TABLE IF NOT EXISTS fee_payments (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     charge_id UUID NOT NULL REFERENCES fee_charges(id) ON DELETE CASCADE,
     amount NUMERIC NOT NULL,
     paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
     method TEXT,
     note TEXT
   )`,

  // ---- staff attendance, leave, salary, reviews ----
  `ALTER TABLE staff ADD COLUMN IF NOT EXISTS base_salary NUMERIC`,
  `CREATE TABLE IF NOT EXISTS staff_attendance (
     staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
     att_date DATE NOT NULL,
     status TEXT NOT NULL,
     PRIMARY KEY (staff_id, att_date)
   )`,
  `CREATE TABLE IF NOT EXISTS leave_requests (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
     from_date DATE NOT NULL,
     to_date DATE NOT NULL,
     kind TEXT,
     reason TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS payroll (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
     month TEXT NOT NULL,
     base NUMERIC NOT NULL,
     allowances NUMERIC NOT NULL DEFAULT 0,
     deductions NUMERIC NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'unpaid',
     paid_on DATE,
     UNIQUE (staff_id, month)
   )`,
  `CREATE TABLE IF NOT EXISTS staff_reviews (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
     review_date DATE NOT NULL DEFAULT CURRENT_DATE,
     rating INT NOT NULL,
     notes TEXT
   )`,

  // ---- timetable and homework ----
  `CREATE TABLE IF NOT EXISTS timetable_slots (
     section_id UUID NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
     day INT NOT NULL,
     period INT NOT NULL,
     subject TEXT NOT NULL,
     teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
     PRIMARY KEY (section_id, day, period)
   )`,
  `CREATE TABLE IF NOT EXISTS homework (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
     section_id UUID REFERENCES sections(id) ON DELETE CASCADE,
     teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
     subject TEXT,
     title TEXT NOT NULL,
     details TEXT,
     due_date DATE,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // ---- the school's own books ----
  `CREATE TABLE IF NOT EXISTS books (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     grade TEXT,
     subject TEXT,
     added_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS book_chunks (
     book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
     idx INT NOT NULL,
     body TEXT NOT NULL,
     PRIMARY KEY (book_id, idx)
   )`,

  // ---- automatic monthly fee vouchers and reminders ----
  `CREATE TABLE IF NOT EXISTS fee_plans (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     amount NUMERIC NOT NULL,
     section_id UUID REFERENCES sections(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS fee_settings (
     school_id UUID PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
     auto_on BOOLEAN NOT NULL DEFAULT false,
     due_day INT NOT NULL DEFAULT 10,
     reminder_days INT NOT NULL DEFAULT 7
   )`,
  `CREATE TABLE IF NOT EXISTS fee_notices (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     month TEXT NOT NULL,
     message TEXT NOT NULL,
     phone TEXT,
     email TEXT,
     emailed BOOLEAN NOT NULL DEFAULT false,
     wa_done BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT now(),
     UNIQUE (student_id, kind, month)
   )`,

  // ---- pass mark, notices, calendar, password reset ----
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS pass_mark INT NOT NULL DEFAULT 40`,
  `CREATE TABLE IF NOT EXISTS announcements (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     body TEXT,
     audience TEXT NOT NULL DEFAULT 'all',
     pinned BOOLEAN NOT NULL DEFAULT false,
     created_by UUID REFERENCES users(id) ON DELETE SET NULL,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS calendar_events (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     school_id UUID NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'other',
     start_date DATE NOT NULL,
     end_date DATE NOT NULL,
     details TEXT,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS calendar_school_idx ON calendar_events (school_id, start_date)`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     token_hash TEXT PRIMARY KEY,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL,
     used BOOLEAN NOT NULL DEFAULT false,
     created_at TIMESTAMPTZ DEFAULT now()
   )`,
];




async function migrate() {
  for (const sql of STEPS) await pool.query(sql);
  console.log("Database is up to date");
}

module.exports = migrate;
