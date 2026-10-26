# Smart Teacher & Institute Assistant: server

Node.js + Express + PostgreSQL (Supabase).

- `npm install`, then `npm start`
- On every start the server brings the database up to date by itself (`src/migrate.js`). Nothing has to be pasted into Supabase.
- Settings are listed in `.env.example`. On Render they go in the service's **Environment** tab.

## Main areas
- `/auth`: register and log in (email or phone number)
- `/school`, `/sections`, `/people`, `/import`: school profile, classes and sections with class teachers, student and staff lists, spreadsheet import (admin)
- `/classes/...`: a teacher's classes, students, attendance and performance
- `/parent`: what a parent sees about their children
- `/ai`: lesson guides, early-warning notes, parent reports and risk briefings (Claude or Gemini)
