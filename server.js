const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Base de données
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DB_DIR, 'chm.db');
console.log('DB:', DB_PATH);
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stops (
    tour_id    TEXT    NOT NULL,
    seq_idx    INTEGER NOT NULL,
    stop_idx   INTEGER NOT NULL,
    state      INTEGER NOT NULL DEFAULT 0,
    reason     TEXT    NOT NULL DEFAULT '',
    updated_at TEXT    DEFAULT (datetime('now')),
    PRIMARY KEY (tour_id, seq_idx, stop_idx)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    tour_id    TEXT PRIMARY KEY,
    facteur    TEXT DEFAULT '',
    remplacant TEXT DEFAULT '',
    heure_debut TEXT DEFAULT '',
    heure_fin   TEXT DEFAULT '',
    updated_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_assignments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id    TEXT NOT NULL,
    facteur    TEXT NOT NULL,
    date       TEXT NOT NULL,
    stops_done INTEGER DEFAULT 0,
    stops_red  INTEGER DEFAULT 0,
    UNIQUE(tour_id, date)
  );
  CREATE TABLE IF NOT EXISTS permanent_issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id     TEXT NOT NULL,
    seq_idx     INTEGER NOT NULL,
    stop_idx    INTEGER NOT NULL,
    stop_addr   TEXT NOT NULL,
    stop_street TEXT DEFAULT '',
    type        TEXT NOT NULL,
    facteur     TEXT DEFAULT '',
    count_seen  INTEGER DEFAULT 1,
    first_seen  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT DEFAULT (datetime('now')),
    resolved    INTEGER DEFAULT 0,
    UNIQUE(tour_id, seq_idx, stop_idx, type)
  );
  CREATE TABLE IF NOT EXISTS weekly_reset (
    id INTEGER PRIMARY KEY CHECK (id=1),
    last_reset TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS archives (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label  TEXT NOT NULL,
    archived_at TEXT DEFAULT (datetime('now')),
    data        TEXT NOT NULL
  );
  INSERT OR IGNORE INTO weekly_reset (id) VALUES (1);
`);

// SSE clients
const sseClients = new Set();

function broadcast() {
  if (!sseClients.size) return;
  const payload = getDashboardPayload();
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch(e) { sseClients.delete(res); } });
}

function getDashboardPayload() {
  const statRows = db.prepare('SELECT tour_id, state, COUNT(*) as cnt FROM stops GROUP BY tour_id, state').all();
  const reasonRows = db.prepare("SELECT tour_id, reason, COUNT(*) as cnt FROM stops WHERE state=3 AND reason!='' GROUP BY tour_id, reason").all();
  const lastRows = db.prepare('SELECT tour_id, MAX(updated_at) as last FROM stops GROUP BY tour_id').all();
  const assignRows = db.prepare('SELECT * FROM assignments').all();
  const today = new Date().toISOString().slice(0,10);
  const incRows = db.prepare("SELECT tour_id, COUNT(*) as cnt FROM permanent_issues WHERE date(last_seen)=? GROUP BY tour_id").all(today);

  const stats = {};
  statRows.forEach(r => {
    if (!stats[r.tour_id]) stats[r.tour_id] = {0:0,2:0,3:0,acces:0,stoppub:0};
    stats[r.tour_id][r.state] = r.cnt;
  });
  reasonRows.forEach(r => {
    if (!stats[r.tour_id]) stats[r.tour_id] = {0:0,2:0,3:0,acces:0,stoppub:0};
    if (r.reason==='acces') stats[r.tour_id].acces = r.cnt;
    if (r.reason==='stoppub') stats[r.tour_id].stoppub = r.cnt;
  });

  const lastUpdate = {};
  lastRows.forEach(r => { lastUpdate[r.tour_id] = r.last; });

  const assignments = {};
  assignRows.forEach(r => { assignments[r.tour_id] = r; });

  const incidents = {};
  incRows.forEach(r => { incidents[r.tour_id] = r.cnt; });

  return { stats, lastUpdate, assignments, incidents, ts: new Date().toISOString() };
}

function archiveAndReset() {
  const rows = db.prepare('SELECT * FROM stops').all();
  if (!rows.length) return;
  const now = new Date();
  const mon = new Date(now); mon.setDate(now.getDate() - now.getDay() + 1);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = d => d.toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'});
  const label = `Semaine du ${fmt(mon)} au ${fmt(sun)} ${sun.getFullYear()}`;
  const byTour = {};
  rows.forEach(r => {
    if (!byTour[r.tour_id]) byTour[r.tour_id] = {};
    if (!byTour[r.tour_id][r.seq_idx]) byTour[r.tour_id][r.seq_idx] = {};
    byTour[r.tour_id][r.seq_idx][r.stop_idx] = { state: r.state, reason: r.reason };
  });
  db.prepare('INSERT INTO archives (week_label, data) VALUES (?,?)').run(label, JSON.stringify(byTour));
  db.prepare('DELETE FROM stops').run();
  db.prepare("UPDATE weekly_reset SET last_reset=datetime('now') WHERE id=1").run();
  console.log('Archived:', label);
  broadcast();
}

function checkWeeklyReset() {
  if (new Date().getDay() !== 0) return;
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  if (!row) return;
  const thisSun = new Date(); thisSun.setHours(0,0,0,0);
  if (new Date(row.last_reset) < thisSun) archiveAndReset();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Routes pages
app.get('/dashboard', (req,res) => res.sendFile(path.join(__dirname,'public','dashboard.html')));
app.get('/reports',   (req,res) => res.sendFile(path.join(__dirname,'public','reports.html')));

// SSE temps réel
app.get('/api/stream', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(getDashboardPayload())}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e){} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// États d'une tournée
app.get('/api/states/:tourId', (req,res) => {
  checkWeeklyReset();
  const rows = db.prepare('SELECT seq_idx,stop_idx,state,reason FROM stops WHERE tour_id=?').all(req.params.tourId);
  const result = {};
  rows.forEach(r => {
    if (!result[r.seq_idx]) result[r.seq_idx] = {};
    result[r.seq_idx][r.stop_idx] = { state: r.state, reason: r.reason||'' };
  });
  // Ajouter les problèmes permanents non résolus
  const perms = db.prepare('SELECT seq_idx,stop_idx,type FROM permanent_issues WHERE tour_id=? AND resolved=0').all(req.params.tourId);
  perms.forEach(p => {
    if (!result[p.seq_idx]) result[p.seq_idx] = {};
    if (!result[p.seq_idx][p.stop_idx])
      result[p.seq_idx][p.stop_idx] = { state: 3, reason: p.type, permanent: true };
  });
  // Inclure la date du dernier reset pour que le client puisse invalider son cache
  const resetRow = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  res.json({ stops: result, last_reset: resetRow?.last_reset || null });
});

// Mise à jour d'un stop
app.post('/api/state', (req,res) => {
  const { tourId, seqIdx, stopIdx, state, reason, addr, street, facteur } = req.body;
  if (!tourId || seqIdx===undefined || stopIdx===undefined || state===undefined)
    return res.status(400).json({ error: 'Champs manquants' });
  const r = reason||'';
  db.prepare(`
    INSERT INTO stops (tour_id,seq_idx,stop_idx,state,reason,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(tour_id,seq_idx,stop_idx)
    DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at
  `).run(tourId, seqIdx, stopIdx, state, r);
  // Enregistrement permanent si stop pub ou pas d'accès
  if (state===3 && (r==='stoppub'||r==='acces')) {
    db.prepare(`
      INSERT INTO permanent_issues (tour_id,seq_idx,stop_idx,stop_addr,stop_street,type,facteur,first_seen,last_seen,count_seen)
      VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'),1)
      ON CONFLICT(tour_id,seq_idx,stop_idx,type)
      DO UPDATE SET last_seen=datetime('now'),count_seen=count_seen+1,resolved=0,facteur=excluded.facteur
    `).run(tourId, seqIdx, stopIdx, addr||'', street||'', r, facteur||'');
  }
  res.json({ ok: true });
  broadcast();
});

// Valider toute une séquence
app.post('/api/validate-seq', (req,res) => {
  const { tourId, seqIdx, stopCount, state } = req.body;
  const insert = db.prepare(`
    INSERT INTO stops (tour_id,seq_idx,stop_idx,state,reason,updated_at)
    VALUES (?,?,?,?,'',datetime('now'))
    ON CONFLICT(tour_id,seq_idx,stop_idx)
    DO UPDATE SET state=excluded.state,reason='',updated_at=excluded.updated_at
  `);
  db.transaction(() => {
    for (let i=0; i<stopCount; i++) insert.run(tourId, seqIdx, i, state||2);
  })();
  res.json({ ok: true });
  broadcast();
});

// Reset une tournée
app.post('/api/reset/:tourId', (req,res) => {
  db.prepare('DELETE FROM stops WHERE tour_id=?').run(req.params.tourId);
  res.json({ ok: true });
  broadcast();
});

// Reset tout + archive
app.post('/api/reset-all', (req,res) => {
  archiveAndReset();
  res.json({ ok: true });
});

// Dashboard REST
app.get('/api/dashboard', (req,res) => {
  checkWeeklyReset();
  res.json(getDashboardPayload());
});

// Assignments
app.get('/api/assignments', (req,res) => {
  const rows = db.prepare('SELECT * FROM assignments').all();
  const r = {}; rows.forEach(a => { r[a.tour_id] = a; }); res.json(r);
});
app.post('/api/assignments/:tourId', (req,res) => {
  const { tourId } = req.params;
  const { facteur='', remplacant='', heure_debut='', heure_fin='' } = req.body;
  db.prepare(`
    INSERT INTO assignments (tour_id,facteur,remplacant,heure_debut,heure_fin,updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(tour_id) DO UPDATE SET facteur=excluded.facteur,remplacant=excluded.remplacant,
    heure_debut=excluded.heure_debut,heure_fin=excluded.heure_fin,updated_at=excluded.updated_at
  `).run(tourId, facteur, remplacant, heure_debut, heure_fin);
  res.json({ ok: true });
  broadcast();
});

// Rapports
app.get('/api/reports/stoppub', (req,res) =>
  res.json(db.prepare("SELECT * FROM permanent_issues WHERE type='stoppub' AND resolved=0 ORDER BY count_seen DESC").all()));
app.get('/api/reports/acces', (req,res) =>
  res.json(db.prepare("SELECT * FROM permanent_issues WHERE type='acces' AND resolved=0 ORDER BY count_seen DESC").all()));
app.post('/api/reports/resolve/:id', (req,res) => {
  db.prepare('UPDATE permanent_issues SET resolved=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/api/reports/weekly', (req,res) => {
  const archives = db.prepare('SELECT id,week_label,archived_at,data FROM archives ORDER BY id DESC LIMIT 12').all();
  res.json(archives.map(a => {
    const data = JSON.parse(a.data);
    let done=0, red=0, total=0;
    Object.values(data).forEach(seqs => Object.values(seqs).forEach(stops =>
      Object.values(stops).forEach(v => {
        total++;
        const st = typeof v==='object' ? v.state : v;
        if(st===2||st===1) done++;
        else if(st===3) red++;
      })
    ));
    return { id:a.id, label:a.week_label, date:a.archived_at, done, red, total };
  }));
});
app.get('/api/reports/facteurs', (req,res) => {
  const since = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  res.json(db.prepare(`
    SELECT facteur, COUNT(DISTINCT date) as jours, SUM(stops_done) as done,
    SUM(stops_red) as red, COUNT(DISTINCT tour_id) as tournees
    FROM daily_assignments WHERE date>=? AND facteur!='' GROUP BY facteur ORDER BY done DESC
  `).all(since));
});
app.post('/api/daily-snapshot', (req,res) => {
  const today = new Date().toISOString().slice(0,10);
  const payload = getDashboardPayload();
  const assigns = db.prepare('SELECT * FROM assignments').all();
  db.transaction(() => {
    assigns.forEach(a => {
      if (!a.facteur) return;
      const s = payload.stats[a.tour_id]||{};
      db.prepare(`
        INSERT INTO daily_assignments (tour_id,facteur,date,stops_done,stops_red)
        VALUES (?,?,?,?,?)
        ON CONFLICT(tour_id,date) DO UPDATE SET stops_done=excluded.stops_done,stops_red=excluded.stops_red,facteur=excluded.facteur
      `).run(a.tour_id, a.facteur, today, s[2]||0, s[3]||0);
    });
  })();
  res.json({ ok: true });
});

// Archives
app.get('/api/archives', (req,res) =>
  res.json(db.prepare('SELECT id,week_label,archived_at FROM archives ORDER BY id DESC').all()));
app.get('/api/archives/:id', (req,res) => {
  const row = db.prepare('SELECT * FROM archives WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Introuvable' });
  res.json({ ...row, data: JSON.parse(row.data) });
});

// Health
app.get('/api/health', (req,res) => res.json({
  ok: true, db: DB_PATH,
  stops: db.prepare('SELECT COUNT(*) as c FROM stops').get().c,
  permanent: db.prepare('SELECT COUNT(*) as c FROM permanent_issues WHERE resolved=0').get().c
}));

app.listen(PORT, () => console.log(`CHM Distribution — port ${PORT}`));
