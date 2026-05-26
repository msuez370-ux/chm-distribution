const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup — persistent volume on Railway at /data, fallback local
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'chm.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stops (
    tour_id TEXT NOT NULL,
    seq_idx INTEGER NOT NULL,
    stop_idx INTEGER NOT NULL,
    state INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (tour_id, seq_idx, stop_idx)
  );
  CREATE TABLE IF NOT EXISTS weekly_reset (
    id INTEGER PRIMARY KEY CHECK (id=1),
    last_reset TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO weekly_reset (id) VALUES (1);
`);

// Auto reset every Sunday at midnight (checked on each request)
function checkWeeklyReset() {
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  if (!row) return;
  const last = new Date(row.last_reset);
  const now = new Date();
  const diffDays = (now - last) / (1000 * 60 * 60 * 24);
  // Reset if more than 7 days OR if we crossed a Sunday
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - now.getDay());
  lastSunday.setHours(0,0,0,0);
  if (last < lastSunday) {
    db.prepare('DELETE FROM stops').run();
    db.prepare('UPDATE weekly_reset SET last_reset=datetime("now") WHERE id=1').run();
    console.log('Weekly reset performed');
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET all states for a tour
app.get('/api/states/:tourId', (req, res) => {
  checkWeeklyReset();
  const rows = db.prepare('SELECT seq_idx, stop_idx, state FROM stops WHERE tour_id=?').all(req.params.tourId);
  const result = {};
  rows.forEach(r => {
    if (!result[r.seq_idx]) result[r.seq_idx] = {};
    result[r.seq_idx][r.stop_idx] = r.state;
  });
  res.json(result);
});

// POST update a stop state
app.post('/api/state', (req, res) => {
  const { tourId, seqIdx, stopIdx, state } = req.body;
  if (!tourId || seqIdx === undefined || stopIdx === undefined || state === undefined) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  db.prepare(`
    INSERT INTO stops (tour_id, seq_idx, stop_idx, state, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id, seq_idx, stop_idx) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
  `).run(tourId, seqIdx, stopIdx, state);
  res.json({ ok: true });
});

// POST manual reset for a tour (manager use)
app.post('/api/reset/:tourId', (req, res) => {
  db.prepare('DELETE FROM stops WHERE tour_id=?').run(req.params.tourId);
  res.json({ ok: true });
});

// POST reset ALL tours (manager use)
app.post('/api/reset-all', (req, res) => {
  db.prepare('DELETE FROM stops').run();
  db.prepare('UPDATE weekly_reset SET last_reset=datetime("now") WHERE id=1').run();
  res.json({ ok: true });
});

// GET dashboard summary for all tours
app.get('/api/dashboard', (req, res) => {
  checkWeeklyReset();
  const rows = db.prepare('SELECT tour_id, state, COUNT(*) as cnt FROM stops GROUP BY tour_id, state').all();
  const result = {};
  rows.forEach(r => {
    if (!result[r.tour_id]) result[r.tour_id] = {0:0,1:0,2:0,3:0};
    result[r.tour_id][r.state] = r.cnt;
  });
  res.json(result);
});

app.listen(PORT, () => console.log(`CHM Distribution running on port ${PORT}`));
