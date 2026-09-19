# Smart Teacher & Institute Assistant — Pilot Backend

A trimmed-down backend meant for **one real pilot school**, not the full
commercial product yet. No billing/subscriptions, no multi-school admin UI —
just enough to replace the browser-only prototype with real accounts and a
real database.

## What's here

- Node.js + Express API
- PostgreSQL (works with Supabase, Railway, Render, or any Postgres host)
- Email + password auth with JWT (no third-party auth service required)
- Roles: `admin` (principal), `teacher`, `parent`
- Routes for classes, students, attendance, performance, and a parent portal

## What's deliberately left out (add later, once the pilot proves it's needed)

- Payments / subscriptions
- AI lesson-guide generation as a backend endpoint (for now, keep calling the
  AI directly from the frontend as the prototype already does — move it
  behind this backend once you're ready to meter/limit usage per school)
- Multi-school admin tooling beyond one school's dashboard
- Email/SMS notifications to parents (the attendance/report screens are
  designed to be read in-app for now)

## 1. Set up a database

Easiest free option to start: [Supabase](https://supabase.com) or
[Railway](https://railway.app). Create a Postgres database, then run the
contents of `sql/schema.sql` against it (Supabase: SQL Editor → paste → Run.
Railway: connect with `psql` or any Postgres client).

## 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in:
- `DATABASE_URL` — the connection string your Postgres provider gives you
- `JWT_SECRET` — any long random string, e.g. `openssl rand -hex 32`
- `PORT` — defaults to 4000

## 3. Install and run locally

```bash
npm install
npm run dev
```

Visit `http://localhost:4000/health` — you should see `{"ok": true}`.

## 4. Deploy

Push this folder to a GitHub repo, then connect it to **Railway** or
**Render**:
- Set the same environment variables in the platform's dashboard
- Build command: `npm install`
- Start command: `npm start`

Both have a free tier that's enough for a single-school pilot.

## API reference (quick)

All authenticated routes need `Authorization: Bearer <token>` from login/register.

### Auth
- `POST /auth/register` — `{ name, email, password, role, schoolName? , schoolId? }`
  - `role: "admin"` creates a **new school** (needs `schoolName`)
  - `role: "teacher" | "parent"` joins an **existing school** (needs `schoolId`)
- `POST /auth/login` — `{ email, password }` → `{ token, user }`

### Classes (teacher creates, admin/teacher can list)
- `POST /classes` — `{ subject, grade, chapter?, topic? }`
- `GET /classes`
- `PATCH /classes/:classId` — `{ chapter?, topic? }`

### Students
- `POST /classes/:classId/students` — `{ name, parentEmail? }`
- `GET /classes/:classId/students`
- `DELETE /classes/:classId/students/:studentId`

### Attendance
- `POST /classes/:classId/attendance` — `{ date, records: [{ studentId, status }] }`
- `GET /classes/:classId/attendance?date=YYYY-MM-DD`
- `GET /classes/:classId/attendance/monthly?month=YYYY-MM`

### Performance
- `POST /classes/:classId/performance` — `{ studentId, quizScore, quizMax, homeworkStatus, topic? }`
- `GET /classes/:classId/performance/latest`

### Admin dashboard
- `GET /admin/dashboard`

### Parent portal
- `GET /parent/children` — matches by the parent's own login email against
  each student's `parent_email`

## How a parent gets an account

For the pilot, keep it simple: when a teacher adds a student, they also type
the parent's email (`parentEmail`). The parent then registers with
`role: "parent"` using that **same email address**, and `/parent/children`
will find their child automatically. No manual linking step needed.

## Connecting the existing frontend prototype

The React prototype currently keeps its data in the browser (`window.storage`).
To point it at this real backend instead, replace those `loadData`/`saveData`
calls with `fetch()` calls to these endpoints, and store the JWT (e.g. in a
`useState` held at the top of the app after login) to send on every request.
That swap can be done screen by screen — start with login + one class, and
migrate the rest once it works end to end.
