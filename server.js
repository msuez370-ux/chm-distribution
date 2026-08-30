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

// ── MIGRATION ──
// Les bases créées par d'anciennes versions du serveur n'ont pas toutes les colonnes
// (CREATE TABLE IF NOT EXISTS ne modifie jamais une table existante).
// On ajoute les colonnes manquantes sans toucher aux données.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`).run();
    console.log(`Migration: colonne ${table}.${col} ajoutée`);
  }
}
ensureColumn('stops', 'reason', "TEXT NOT NULL DEFAULT ''");
ensureColumn('stops', 'updated_at', 'TEXT');

// ── FUSEAU HORAIRE (Europe/Paris) ──
// Railway fait tourner le serveur en UTC ; l'équipe raisonne en heure de Paris.
// Ces fonctions convertissent sans dépendance externe (Intl est natif à Node).

// Décalage UTC → Paris (heure d'été incluse) à un instant donné, en minutes.
function parisOffsetMinutes(utcInstant) {
  const asUTC = new Date(utcInstant.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asParis = new Date(utcInstant.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  return Math.round((asParis - asUTC) / 60000);
}
// Renvoie un Date dont les champs UTC (getUTCDay, getUTCHours...) représentent
// en réalité l'heure murale de Paris pour l'instant UTC donné. Ne jamais utiliser
// ce résultat comme un vrai instant (ex: pour l'écrire en base) — voir fromParisWallClock.
function toParisWallClock(utcInstant) {
  return new Date(utcInstant.getTime() + parisOffsetMinutes(utcInstant) * 60000);
}
// Conversion inverse : un "faux" instant en heure murale de Paris → vrai instant UTC.
function fromParisWallClock(parisWallClock) {
  return new Date(parisWallClock.getTime() - parisOffsetMinutes(parisWallClock) * 60000);
}
// Lundi 00:00 (heure de Paris) de la semaine contenant l'instant donné (en heure murale de Paris).
function mondayOfParisWeek(parisWallClock) {
  const d = new Date(parisWallClock);
  const day = d.getUTCDay(); // 0=dimanche .. 1=lundi .. 6=samedi
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
// Lundi 00:01 (heure de Paris) le plus récent qui soit déjà passé, en instant UTC réel.
// C'est le seuil de déclenchement du reset hebdo : peu importe quel jour de la semaine
// ce code tourne, on regarde toujours "est-ce que le dernier lundi 00:01 est passé
// depuis le dernier reset connu ?" plutôt que "sommes-nous dimanche/lundi en ce moment".
function lastMondayResetUTC() {
  const parisNow = toParisWallClock(new Date());
  const monday = mondayOfParisWeek(parisNow);
  monday.setUTCMinutes(1); // lundi 00:01
  if (monday > parisNow) monday.setUTCDate(monday.getUTCDate() - 7);
  return fromParisWallClock(monday);
}

// ── NETTOYAGE PONCTUEL DES ARCHIVES ──
// Deux corrections ponctuelles liées à l'historique du bug de reset hebdo.
// Les deux sont idempotentes (sans effet si déjà appliquées) et peuvent rester
// en place sans risque, ou être retirées une fois vérifiées sur Railway.

// 1) Des archives en double (même semaine, créées à quelques minutes d'écart)
//    proviennent des tests de mise au point de fin mai / début juin 2026.
//    On ne garde que la plus récente de chaque groupe en double.
function cleanupDuplicateArchives() {
  const dupGroups = db.prepare(`
    SELECT week_label, COUNT(*) as cnt FROM archives GROUP BY week_label HAVING cnt > 1
  `).all();
  let removed = 0;
  dupGroups.forEach(g => {
    const rows = db.prepare('SELECT id FROM archives WHERE week_label=? ORDER BY id DESC').all(g.week_label);
    const toDelete = rows.slice(1).map(r => r.id); // garde le plus récent (id max)
    if (toDelete.length) {
      const placeholders = toDelete.map(() => '?').join(',');
      db.prepare(`DELETE FROM archives WHERE id IN (${placeholders})`).run(...toDelete);
      removed += toDelete.length;
    }
  });
  if (removed > 0) console.log(`Nettoyage archives : ${removed} doublon(s) supprimé(s)`);
}

// 2) L'archive créée lors du déploiement du correctif du reset hebdo a rattrapé
//    d'un coup ~6 semaines cumulées (le reset était resté bloqué depuis le
//    19/07/2026), et portait donc l'étiquette trompeuse "13/07 au 19/07" qui ne
//    reflète pas la vraie période couverte. On la corrige une seule fois.
function fixMislabeledCatchupArchive() {
  const info = db.prepare(`
    UPDATE archives SET week_label = ?
    WHERE week_label = 'Semaine du 13/07 au 19/07 2026'
  `).run('Semaine du 27/07 au 30/08 2026 (rattrapage — plusieurs semaines cumulées, reset resté bloqué avant le correctif)');
  if (info.changes > 0) console.log('Archive de rattrapage renommée pour refléter la vraie période couverte.');
}

cleanupDuplicateArchives();
fixMislabeledCatchupArchive();

// ── RESET HEBDO ──
// Archive les données de la semaine qui vient de se terminer, puis vide les compteurs.
// L'étiquette de la semaine archivée est calculée à partir de l'ancien last_reset
// (qui marque le lundi 00:01 où cette semaine a commencé) et non de "maintenant" —
// sinon un rattrapage tardif (ex: exécuté un mardi car le serveur était éteint
// lundi) étiquetterait l'archive avec la mauvaise semaine.
function archiveAndReset() {
  const rows = db.prepare('SELECT * FROM stops').all();
  const prevReset = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();

  const referenceParis = (prevReset && prevReset.last_reset)
    ? toParisWallClock(new Date(prevReset.last_reset.replace(' ', 'T') + 'Z'))
    : toParisWallClock(new Date());
  const monday = mondayOfParisWeek(referenceParis);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = d => `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  const label = `Semaine du ${fmt(monday)} au ${fmt(sunday)} ${sunday.getUTCFullYear()}`;

  if (rows.length > 0) {
    const byTour = {};
    rows.forEach(r => {
      if (!byTour[r.tour_id]) byTour[r.tour_id] = {};
      if (!byTour[r.tour_id][r.seq_idx]) byTour[r.tour_id][r.seq_idx] = {};
      byTour[r.tour_id][r.seq_idx][r.stop_idx] = r.state;
    });
    db.prepare('INSERT INTO archives (week_label, data) VALUES (?, ?)').run(label, JSON.stringify(byTour));
    db.prepare('DELETE FROM stops').run();
  }
  // Toujours avancer last_reset, même s'il n'y avait rien à archiver — sinon la
  // vérification périodique ré-essaierait indéfiniment (voir note ci-dessous).
  db.prepare("UPDATE weekly_reset SET last_reset=datetime('now') WHERE id=1").run();
  console.log('Archive & reset:', label, rows.length ? `(${rows.length} stops archivés)` : '(rien à archiver)');
  broadcastDashboard();
}

// Déclenche le reset dès que le seuil (lundi 00:01 Paris) est franchi depuis le
// dernier reset connu — quel que soit le jour/l'heure où cette fonction est
// appelée. Appelée à la fois par le trafic API (ci-dessous) ET par un minuteur
// serveur indépendant (voir tout en bas du fichier), donc ça ne dépend plus de
// la présence d'un facteur ou d'un manager sur l'appli le dimanche.
function checkWeeklyReset() {
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  if (!row) return;
  const lastResetUTC = new Date(row.last_reset.replace(' ', 'T') + 'Z');
  if (lastResetUTC < lastMondayResetUTC()) archiveAndReset();
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
// Les pages HTML ne doivent jamais être servies depuis un cache périmé :
// les téléphones doivent toujours revalider pour récupérer la dernière version de l'app.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// ── DONNÉES DES TOURNÉES (adresses/rues) ──
// Lues directement depuis la ligne "const TOURS = {...}" de public/index.html
// au démarrage — jamais recopiées à la main ailleurs, pour qu'il n'existe
// qu'une seule source de vérité (l'app facteur) et zéro risque de désynchro
// avec reports.html. Alimente /api/tours, utilisé par la vue "détail" des
// rapports (rues faites / non faites par tournée archivée).
let TOURS_DATA = {};
try {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const line = indexHtml.split('\n').find(l => l.startsWith('const TOURS = '));
  if (line) {
    let jsonStr = line.slice('const TOURS = '.length).trim();
    if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
    TOURS_DATA = JSON.parse(jsonStr);
    console.log(`Données tournées chargées depuis index.html : ${Object.keys(TOURS_DATA).length} tournées`);
  } else {
    console.warn('⚠️  Ligne "const TOURS = " introuvable dans index.html — /api/tours renverra un objet vide.');
  }
} catch (e) {
  console.warn('⚠️  Échec de lecture des données de tournées depuis index.html :', e.message);
}

app.get('/api/tours', (req, res) => {
  res.json(TOURS_DATA);
});

// ── ROUTE DASHBOARD ──
app.get('/dashboard', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/reports', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
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

// ── ÉPOQUE DE RESET ──
// Identifie la "génération" des données. Change à chaque archivage/reset.
// Permet aux clients de purger leur cache local, et au serveur de refuser
// les écritures provenant d'une génération périmée (anti-résurrection).
function currentEpoch() {
  const row = db.prepare('SELECT last_reset FROM weekly_reset WHERE id=1').get();
  return row ? row.last_reset : '';
}

// ── STOPS ──
app.get('/api/states/:tourId', (req, res) => {
  checkWeeklyReset();
  const rows = db.prepare('SELECT seq_idx, stop_idx, state, reason FROM stops WHERE tour_id=?').all(req.params.tourId);
  const result = {};
  rows.forEach(r => {
    if (!result[r.seq_idx]) result[r.seq_idx] = {};
    result[r.seq_idx][r.stop_idx] = { state: r.state, reason: r.reason || '' };
  });
  res.setHeader('X-Reset-Epoch', currentEpoch());
  res.json(result);
});

app.post('/api/state', (req, res) => {
  const { tourId, seqIdx, stopIdx, state } = req.body;
  if (!tourId || seqIdx === undefined || stopIdx === undefined || state === undefined)
    return res.status(400).json({ error: 'Champs manquants' });
  // Anti-résurrection : refuse toute écriture ne portant pas l'époque courante
  // (vieux clients en cache qui renvoient les données de la semaine passée)
  if ((req.body.epoch || '') !== currentEpoch())
    return res.status(409).json({ error: 'reset', message: 'Données périmées — rescannez le QR code de votre tournée' });
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
  if ((req.body.epoch || '') !== currentEpoch())
    return res.status(409).json({ error: 'reset', message: 'Données périmées — rescannez le QR code de votre tournée' });
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

// Vérification indépendante du trafic : même si aucun facteur ni manager n'ouvre
// l'appli le lundi matin, le reset hebdomadaire se déclenche tout seul dans les
// minutes qui suivent lundi 00:01 (heure de Paris), tant que le serveur tourne.
setInterval(checkWeeklyReset, 5 * 60 * 1000);
checkWeeklyReset();

app.listen(PORT, () => console.log(`CHM Distribution — port ${PORT} — DB: ${DB_PATH}`));
