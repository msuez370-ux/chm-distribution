# Distribution CHM — Application facteurs

## Déploiement Railway (15 minutes)

### Étape 1 — Créer un compte Railway
1. Allez sur **railway.app**
2. Cliquez "Start a New Project" → "Sign in with GitHub"
3. Créez un compte GitHub si besoin (gratuit)

### Étape 2 — Préparer les fichiers
1. Dézippez le fichier `chm-app.zip` sur votre ordinateur
2. Vous verrez : `server.js`, `package.json`, `railway.json`, `public/`

### Étape 3 — Déployer sur Railway
**Option A — Via GitHub (recommandé) :**
1. Créez un dépôt GitHub privé nommé `chm-distribution`
2. Uploadez tous les fichiers du dossier dans ce dépôt
3. Sur Railway : "New Project" → "Deploy from GitHub repo" → choisissez `chm-distribution`
4. Railway détecte automatiquement Node.js et déploie

**Option B — Via Railway CLI :**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Étape 4 — Ajouter un volume de données (obligatoire)
1. Dans votre projet Railway, cliquez sur votre service
2. Allez dans "Volumes" → "Add Volume"
3. Mount path : `/data`
4. Railway redémarre automatiquement

### Étape 5 — Obtenir l'URL
1. Dans Railway, cliquez "Settings" → "Domains" → "Generate Domain"
2. Vous obtenez une URL du type : `https://chm-distribution-xxx.up.railway.app`
3. **C'est cette URL que vous mettez dans les QR codes !**

### Résultat final
- Chaque facteur scanne son QR code → arrive directement sur sa tournée
- Toutes les modifications sont synchronisées en temps réel
- Les données se remettent à zéro automatiquement chaque dimanche à minuit
- Votre dashboard (onglet 📊) montre la progression de toutes les tournées

## Support
En cas de problème, contactez votre administrateur système.
