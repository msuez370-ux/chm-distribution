const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── BASE DE DONNÉES ──
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DB_DIR, 'chm.db');
console.log('DB:', DB_PATH);

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS stops (
    tour_id   TEXT    NOT NULL,
    seq_idx   INTEGER NOT NULL,
    stop_idx  INTEGER NOT NULL,
    state     INTEGER NOT NULL DEFAULT 0,
    reason    TEXT    NOT NULL DEFAULT '',
    updated_at TEXT   DEFAULT (datetime('now')),
    PRIMARY KEY (tour_id, seq_idx, stop_idx)
  );
  CREATE TABLE IF NOT EXISTS weekly_reset (
    id INTEGER PRIMARY KEY CHECK (id=1),
    last_reset TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS archives (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label   TEXT NOT NULL,
    archived_at  TEXT DEFAULT (datetime('now')),
    data         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assignments (
    tour_id    TEXT PRIMARY KEY,
    facteur    TEXT DEFAULT '',
    remplacant TEXT DEFAULT '',
    heure_debut TEXT DEFAULT '',
    heure_fin   TEXT DEFAULT '',
    notes       TEXT DEFAULT '',
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id     TEXT NOT NULL,
    seq_code    TEXT DEFAULT '',
    adresse     TEXT DEFAULT '',
    type        TEXT NOT NULL,
    commentaire TEXT DEFAULT '',
    facteur     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS permanent_issues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id      TEXT NOT NULL,
    seq_idx      INTEGER NOT NULL,
    stop_idx     INTEGER NOT NULL,
    stop_addr    TEXT NOT NULL,
    stop_street  TEXT DEFAULT '',
    type         TEXT NOT NULL, -- 'stoppub' ou 'acces'
    commentaire  TEXT DEFAULT '',
    facteur      TEXT DEFAULT '',
    first_seen   TEXT DEFAULT (datetime('now')),
    last_seen    TEXT DEFAULT (datetime('now')),
    count_seen   INTEGER DEFAULT 1,
    resolved     INTEGER DEFAULT 0,
    UNIQUE(tour_id, seq_idx, stop_idx, type)
  );
  CREATE TABLE IF NOT EXISTS daily_assignments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id    TEXT NOT NULL,
    facteur    TEXT NOT NULL,
    date       TEXT NOT NULL,
    stops_done INTEGER DEFAULT 0,
    stops_red  INTEGER DEFAULT 0,
    notes      TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tour_id, date)
  );
  INSERT OR IGNORE INTO weekly_reset (id) VALUES (1);
`);

// ── RESET HEBDO ──
function archiveAndReset() {
  const rows = db.prepare('SELECT * FROM stops').all();
  if (rows.length === 0) return;
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - now.getDay() + 1);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const fmt = d => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const label = `Semaine du ${fmt(monday)} au ${fmt(sunday)} ${sunday.getFullYear()}`;
  const byTour = {};
  rows.forEach(r => {
    if (!byTour[r.tour_id]) byTour[r.tour_id] = {};
    if (!byTour[r.tour_id][r.seq_idx]) byTour[r.tour_id][r.seq_idx] = {};
    byTour[r.tour_id][r.seq_idx][r.stop_idx] = r.state;
  });
  db.prepare('INSERT INTO archives (week_label, data) VALUES (?, ?)').run(label, JSON.stringify(byTour));
  db.prepare('DELETE FROM stops').run();
  db.prepare("UPDATE weekly_reset SET last_reset=datetime('now') WHERE id=1").run();
  console.log('Archive & reset:', label);
  broadcastDashboard();
}

function checkWeeklyReset() {
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  if (!row || new Date().getDay() !== 0) return;
  const thisSundayStart = new Date(); thisSundayStart.setHours(0,0,0,0);
  if (new Date(row.last_reset) < thisSundayStart) archiveAndReset();
}

// ── SSE — TEMPS RÉEL ──
const sseClients = new Set();

function broadcastDashboard() {
  if (sseClients.size === 0) return;
  const payload = buildDashboardPayload();
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch(e) { sseClients.delete(res); } });
}

function buildDashboardPayload() {
  // Stats par tournée
  const statRows = db.prepare(
    'SELECT tour_id, state, COUNT(*) as cnt FROM stops GROUP BY tour_id, state'
  ).all();
  const reasonRows = db.prepare(
    "SELECT tour_id, reason, COUNT(*) as cnt FROM stops WHERE state=3 AND reason!='' GROUP BY tour_id, reason"
  ).all();
  const stats = {};
  statRows.forEach(r => {
    if (!stats[r.tour_id]) stats[r.tour_id] = { 0:0, 2:0, 3:0, acces:0, stoppub:0 };
    stats[r.tour_id][r.state] = r.cnt;
  });
  reasonRows.forEach(r => {
    if (!stats[r.tour_id]) stats[r.tour_id] = { 0:0, 2:0, 3:0, acces:0, stoppub:0 };
    if (r.reason === 'acces') stats[r.tour_id].acces = r.cnt;
    if (r.reason === 'stoppub') stats[r.tour_id].stoppub = r.cnt;
  });

  // Dernière mise à jour par tournée
  const lastRows = db.prepare(
    'SELECT tour_id, MAX(updated_at) as last FROM stops GROUP BY tour_id'
  ).all();
  const lastUpdate = {};
  lastRows.forEach(r => { lastUpdate[r.tour_id] = r.last; });

  // Assignments (facteurs)
  const assignRows = db.prepare('SELECT * FROM assignments').all();
  const assignments = {};
  assignRows.forEach(r => { assignments[r.tour_id] = r; });

  // Incidents du jour
  const today = new Date().toISOString().slice(0, 10);
  const incidentRows = db.prepare(
    "SELECT tour_id, COUNT(*) as cnt FROM incidents WHERE created_at >= ? GROUP BY tour_id"
  ).all(today);
  const incidents = {};
  incidentRows.forEach(r => { incidents[r.tour_id] = r.cnt; });

  return { stats, lastUpdate, assignments, incidents, ts: new Date().toISOString() };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ROUTE DASHBOARD ──
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/reports', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// ── SSE ENDPOINT ──
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  // Envoie l'état initial immédiatement
  const payload = buildDashboardPayload();
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  // Ping toutes les 25s pour garder la connexion ouverte
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ── STOPS ──
app.get('/api/states/:tourId', (req, res) => {
  checkWeeklyReset();
  const rows = db.prepare('SELECT seq_idx, stop_idx, state, reason FROM stops WHERE tour_id=?').all(req.params.tourId);
  const result = {};
  rows.forEach(r => {
    if (!result[r.seq_idx]) result[r.seq_idx] = {};
    result[r.seq_idx][r.stop_idx] = { state: r.state, reason: r.reason || '' };
  });
  res.json(result);
});

app.post('/api/state', (req, res) => {
  const { tourId, seqIdx, stopIdx, state } = req.body;
  if (!tourId || seqIdx === undefined || stopIdx === undefined || state === undefined)
    return res.status(400).json({ error: 'Champs manquants' });
  const reason = req.body.reason || '';
  db.prepare(`
    INSERT INTO stops (tour_id, seq_idx, stop_idx, state, reason, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id, seq_idx, stop_idx)
    DO UPDATE SET state=excluded.state, reason=excluded.reason, updated_at=excluded.updated_at
  `).run(tourId, seqIdx, stopIdx, state, reason);

  // Enregistrement permanent si stop pub ou pas d'accès
  if (state === 3 && (reason === 'stoppub' || reason === 'acces')) {
    const addr = req.body.addr || '';
    const street = req.body.street || '';
    const facteur = req.body.facteur || '';
    db.prepare(`
      INSERT INTO permanent_issues (tour_id, seq_idx, stop_idx, stop_addr, stop_street, type, facteur, first_seen, last_seen, count_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 1)
      ON CONFLICT(tour_id, seq_idx, stop_idx, type)
      DO UPDATE SET last_seen=datetime('now'), count_seen=count_seen+1, facteur=excluded.facteur, resolved=0
    `).run(tourId, seqIdx, stopIdx, addr, street, reason, facteur);
  }
  // Si le stop repasse à 0 (annulé), on ne supprime pas le permanent — c'est voulu

  res.json({ ok: true });
  broadcastDashboard();
});

app.post('/api/validate-seq', (req, res) => {
  const { tourId, seqIdx, stopCount, state } = req.body;
  if (!tourId || seqIdx === undefined || stopCount === undefined)
    return res.status(400).json({ error: 'Champs manquants' });
  const targetState = state ?? 2;
  const insert = db.prepare(`
    INSERT INTO stops (tour_id, seq_idx, stop_idx, state, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id, seq_idx, stop_idx)
    DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at
  `);
  db.transaction(() => {
    for (let i = 0; i < stopCount; i++) insert.run(tourId, seqIdx, i, targetState);
  })();
  res.json({ ok: true });
  broadcastDashboard();
});

app.post('/api/reset/:tourId', (req, res) => {
  db.prepare('DELETE FROM stops WHERE tour_id=?').run(req.params.tourId);
  res.json({ ok: true });
  broadcastDashboard();
});

app.post('/api/reset-all', (req, res) => {
  archiveAndReset();
  res.json({ ok: true });
});

// ── ASSIGNMENTS (facteurs) ──
app.get('/api/assignments', (req, res) => {
  const rows = db.prepare('SELECT * FROM assignments').all();
  const result = {};
  rows.forEach(r => { result[r.tour_id] = r; });
  res.json(result);
});

app.post('/api/assignments/:tourId', (req, res) => {
  const { tourId } = req.params;
  const { facteur, remplacant, heure_debut, heure_fin, notes } = req.body;
  db.prepare(`
    INSERT INTO assignments (tour_id, facteur, remplacant, heure_debut, heure_fin, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tour_id)
    DO UPDATE SET facteur=excluded.facteur, remplacant=excluded.remplacant,
      heure_debut=excluded.heure_debut, heure_fin=excluded.heure_fin,
      notes=excluded.notes, updated_at=excluded.updated_at
  `).run(tourId, facteur||'', remplacant||'', heure_debut||'', heure_fin||'', notes||'');
  res.json({ ok: true });
  broadcastDashboard();
});

// ── INCIDENTS ──
app.get('/api/incidents', (req, res) => {
  const { tour_id, date } = req.query;
  let query = 'SELECT * FROM incidents WHERE 1=1';
  const params = [];
  if (tour_id) { query += ' AND tour_id=?'; params.push(tour_id); }
  if (date)    { query += ' AND created_at >= ?'; params.push(date); }
  query += ' ORDER BY created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/incidents', (req, res) => {
  const { tourId, seqCode, adresse, type, commentaire, facteur } = req.body;
  if (!tourId || !type) return res.status(400).json({ error: 'Champs manquants' });
  const result = db.prepare(`
    INSERT INTO incidents (tour_id, seq_code, adresse, type, commentaire, facteur)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tourId, seqCode||'', adresse||'', type, commentaire||'', facteur||'');
  res.json({ ok: true, id: result.lastInsertRowid });
  broadcastDashboard();
});

// ── DASHBOARD DATA (REST fallback) ──
app.get('/api/dashboard', (req, res) => {
  checkWeeklyReset();
  res.json(buildDashboardPayload());
});

// ── ARCHIVES ──
app.get('/api/archives', (req, res) => {
  res.json(db.prepare('SELECT id, week_label, archived_at FROM archives ORDER BY id DESC').all());
});

app.get('/api/archives/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM archives WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

// ── RAPPORTS ──

// Stats hebdomadaires depuis les archives
app.get('/api/reports/weekly', (req, res) => {
  const archives = db.prepare('SELECT id, week_label, archived_at, data FROM archives ORDER BY id DESC LIMIT 12').all();
  const weeks = archives.map(arc => {
    const data = JSON.parse(arc.data);
    let totalStops = 0, totalDone = 0, totalRed = 0;
    const byTour = {};
    Object.entries(data).forEach(([tid, seqs]) => {
      let g=0, r=0, total=0;
      Object.values(seqs).forEach(stops => {
        Object.values(stops).forEach(state => {
          total++;
          if(state===2||state===1)g++;
          else if(state===3||state===2)r++;
        });
      });
      byTour[tid]={g,r,total};
      totalStops+=total; totalDone+=g; totalRed+=r;
    });
    return { id:arc.id, label:arc.week_label, date:arc.archived_at, totalStops, totalDone, totalRed, byTour };
  });
  res.json(weeks);
});

// Liste permanente stop pub
app.get('/api/reports/stoppub', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM permanent_issues WHERE type='stoppub' AND resolved=0 ORDER BY tour_id, count_seen DESC"
  ).all();
  res.json(rows);
});

// Liste permanente pas d'accès
app.get('/api/reports/acces', (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM permanent_issues WHERE type='acces' AND resolved=0 ORDER BY tour_id, count_seen DESC"
  ).all();
  res.json(rows);
});

// Résoudre un problème permanent (l'encadrant valide que c'est réglé)
app.post('/api/reports/resolve/:id', (req, res) => {
  db.prepare('UPDATE permanent_issues SET resolved=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Stats par facteur (depuis daily_assignments + archives)
app.get('/api/reports/facteurs', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const sevenDaysAgo = new Date(Date.now()-7*24*3600*1000).toISOString().slice(0,10);
  const rows = db.prepare(`
    SELECT facteur,
      COUNT(DISTINCT date) as jours_travailles,
      SUM(stops_done) as total_done,
      SUM(stops_red) as total_red,
      COUNT(DISTINCT tour_id) as nb_tournees
    FROM daily_assignments
    WHERE date >= ? AND facteur != ''
    GROUP BY facteur
    ORDER BY total_done DESC
  `).all(sevenDaysAgo);
  // Incidents par facteur
  const incidents = db.prepare(`
    SELECT facteur, COUNT(*) as cnt FROM incidents
    WHERE created_at >= ? AND facteur != ''
    GROUP BY facteur
  `).all(sevenDaysAgo);
  const incByFacteur = {};
  incidents.forEach(r => { incByFacteur[r.facteur] = r.cnt; });
  const result = rows.map(r => ({ ...r, incidents: incByFacteur[r.facteur]||0 }));
  res.json(result);
});

// Enregistrer l'avancement journalier d'un facteur (appelé depuis dashboard)
app.post('/api/daily-snapshot', (req, res) => {
  const today = new Date().toISOString().slice(0,10);
  const payload = buildDashboardPayload();
  const assignments = db.prepare('SELECT * FROM assignments').all();
  const tx = db.transaction(() => {
    assignments.forEach(a => {
      if (!a.facteur) return;
      const s = payload.stats[a.tour_id]||{};
      db.prepare(`
        INSERT INTO daily_assignments (tour_id, facteur, date, stops_done, stops_red)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tour_id, date) DO UPDATE SET
          stops_done=excluded.stops_done, stops_red=excluded.stops_red, facteur=excluded.facteur
      `).run(a.tour_id, a.facteur, today, s[2]||0, s[3]||0);
    });
  });
  tx();
  res.json({ ok: true });
});

// ── HEALTH ──
app.get('/api/health', (req, res) => {
  const stops = db.prepare('SELECT COUNT(*) as cnt FROM stops').get().cnt;
  const incidents = db.prepare('SELECT COUNT(*) as cnt FROM incidents').get().cnt;
  res.json({ ok: true, db: DB_PATH, stops, incidents });
});

app.listen(PORT, () => console.log(`CHM Distribution — port ${PORT} — DB: ${DB_PATH}`));
