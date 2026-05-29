const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  CREATE TABLE IF NOT EXISTS archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,
    archived_at TEXT DEFAULT (datetime('now')),
    data TEXT NOT NULL
  );
  INSERT OR IGNORE INTO weekly_reset (id) VALUES (1);
`);

function archiveAndReset() {
  // Snapshot all current stops
  const rows = db.prepare('SELECT * FROM stops').all();
  if (rows.length === 0) return; // Nothing to archive

  // Build week label: "Semaine du DD/MM au DD/MM/YYYY"
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = d => d.toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit'});
  const label = `Semaine du ${fmt(monday)} au ${fmt(sunday)} ${sunday.getFullYear()}`;

  // Group by tour
  const byTour = {};
  rows.forEach(r => {
    if (!byTour[r.tour_id]) byTour[r.tour_id] = {};
    if (!byTour[r.tour_id][r.seq_idx]) byTour[r.tour_id][r.seq_idx] = {};
    byTour[r.tour_id][r.seq_idx][r.stop_idx] = r.state;
  });

  db.prepare('INSERT INTO archives (week_label, data) VALUES (?, ?)').run(label, JSON.stringify(byTour));
  db.prepare('DELETE FROM stops').run();
  db.prepare('UPDATE weekly_reset SET last_reset=datetime("now") WHERE id=1').run();
  console.log('Archived & reset:', label);
}

function checkWeeklyReset() {
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  if (!row) return;
  const last = new Date(row.last_reset);
  const now = new Date();
  const lastSunday = new Date(now);
  lastSunday.setDate(now.getDate() - now.getDay());
  lastSunday.setHours(0, 0, 0, 0);
  if (last < lastSunday) archiveAndReset();
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

// POST update a single stop
app.post('/api/state', (req, res) => {
  const { tourId, seqIdx, stopIdx, state } = req.body;
  if (!tourId || seqIdx === undefined || stopIdx === undefined || state === undefined)
    return res.status(400).json({ error: 'Missing fields' });
  db.prepare(`
    INSERT INTO stops (tour_id, seq_idx, stop_idx, state, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id, seq_idx, stop_idx) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
  `).run(tourId, seqIdx, stopIdx, state);
  res.json({ ok: true });
});

// POST validate entire sequence (set all stops to state 2 = green)
app.post('/api/validate-seq', (req, res) => {
  const { tourId, seqIdx, stopCount, state } = req.body;
  if (!tourId || seqIdx === undefined || stopCount === undefined)
    return res.status(400).json({ error: 'Missing fields' });
  const targetState = state ?? 2;
  const insert = db.prepare(`
    INSERT INTO stops (tour_id, seq_idx, stop_idx, state, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id, seq_idx, stop_idx) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < stopCount; i++) insert.run(tourId, seqIdx, i, targetState);
  });
  tx();
  res.json({ ok: true });
});

// POST reset a single tour
app.post('/api/reset/:tourId', (req, res) => {
  db.prepare('DELETE FROM stops WHERE tour_id=?').run(req.params.tourId);
  res.json({ ok: true });
});

// POST reset ALL (with archive)
app.post('/api/reset-all', (req, res) => {
  archiveAndReset();
  res.json({ ok: true });
});

// GET dashboard summary
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

// GET list of archives
app.get('/api/archives', (req, res) => {
  const rows = db.prepare('SELECT id, week_label, archived_at FROM archives ORDER BY id DESC').all();
  res.json(rows);
});

// GET one archive detail
app.get('/api/archives/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM archives WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

app.listen(PORT, () => console.log(`CHM Distribution running on port ${PORT}`));
