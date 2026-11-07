// Daily Smart Market Manager : backend sécurisé
// Rôle : garder les jetons API côté serveur et exposer à l'application des routes simples et normalisées.
// Aucun secret n'est jamais renvoyé à l'application. Exécution : node server.js (Node 20.12 ou plus récent).
import express from 'express';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';

try { process.loadEnvFile?.(); } catch { /* pas de fichier .env : on utilise les variables d'environnement de l'hébergeur */ }

const {
  PORT = 8787, ALLOWED_ORIGIN = '', APP_ACCESS_KEY = '',
  AWIN_API_TOKEN = '', AWIN_PUBLISHER_ID = '', AWIN_REGION = 'US', AWIN_FEED_URL = '',
  AMAZON_CREATORS_ENABLED = 'false',
} = process.env;

const origins = ALLOWED_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(cors({
  origin: (o, cb) => cb(null, !o || origins.includes(o)),
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// --- Protection : clé d'accès propre à ce backend + limite de débit simple ---
const hits = new Map();
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const ip = req.ip, now = Date.now();
  const h = (hits.get(ip) || []).filter(t => now - t < 60_000);
  h.push(now); hits.set(ip, h);
  if (h.length > 40) return res.status(429).json({ error: 'Trop de requêtes. Réessayez dans une minute.' });
  if (!APP_ACCESS_KEY) return res.status(503).json({ error: 'APP_ACCESS_KEY non configurée sur le serveur.' });
  const got = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(APP_ACCESS_KEY);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'Clé d’accès refusée.' });
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(new Date().toISOString(), req.path, e.message);
  res.status(e.status && e.status < 500 ? e.status : 502).json({ error: e.publicMessage || 'Erreur lors de l’appel à la plateforme.' });
});

// ============================ AWIN ============================
const AWIN = 'https://api.awin.com';
const needAwin = () => {
  if (!AWIN_API_TOKEN || !AWIN_PUBLISHER_ID) throw Object.assign(new Error('Awin non configuré'), { status: 400, publicMessage: 'AWIN_API_TOKEN et AWIN_PUBLISHER_ID ne sont pas renseignés dans le .env du serveur.' });
};
async function awin(path, params = {}) {
  const u = new URL(AWIN + path);
  Object.entries(params).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { Authorization: `Bearer ${AWIN_API_TOKEN}`, Accept: 'application/json' } });
  if (!r.ok) {
    const msg = r.status === 401 ? 'Jeton Awin refusé (401). Vérifiez AWIN_API_TOKEN.' : r.status === 429 ? 'Limite de requêtes Awin atteinte. Réessayez plus tard.' : `Réponse Awin ${r.status}.`;
    throw Object.assign(new Error('Awin ' + r.status), { status: r.status === 401 ? 400 : r.status, publicMessage: msg });
  }
  return r.json();
}
const day = d => d.toISOString().slice(0, 10);
// L'API de transactions limite chaque appel à 31 jours : on découpe la période.
function windows(start, end, days) {
  const out = []; let a = new Date(start + 'T00:00:00Z'); const z = new Date(end + 'T00:00:00Z');
  while (a <= z) { const b = new Date(Math.min(a.getTime() + (days - 1) * 864e5, z.getTime())); out.push([day(a), day(b)]); a = new Date(b.getTime() + 864e5); }
  return out;
}
function checkRange(b) {
  const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!ok(b.startDate) || !ok(b.endDate) || b.startDate > b.endDate) throw Object.assign(new Error('dates'), { status: 400, publicMessage: 'Période invalide.' });
  if ((new Date(b.endDate) - new Date(b.startDate)) / 864e5 > 366) throw Object.assign(new Error('dates'), { status: 400, publicMessage: 'Période limitée à 12 mois.' });
}

app.get('/api/awin/status', wrap(async (req, res) => {
  needAwin();
  const accounts = await awin('/accounts');
  const mine = (accounts.accounts || []).find(a => String(a.accountId) === String(AWIN_PUBLISHER_ID));
  if (!mine) return res.json({ connected: false, error: 'Le jeton est valide mais AWIN_PUBLISHER_ID ne correspond à aucun de ses comptes.' });
  res.json({ connected: true, publisherId: mine.accountId, accountName: mine.accountName });
}));

app.post('/api/awin/sync', wrap(async (req, res) => {
  needAwin(); checkRange(req.body || {});
  const { startDate, endDate } = req.body;
  const progs = await awin(`/publishers/${AWIN_PUBLISHER_ID}/programmes`, { relationship: 'joined' }).catch(() => []);
  const names = Object.fromEntries((Array.isArray(progs) ? progs : []).map(p => [p.id, p.name]));
  const transactions = [];
  for (const [a, b] of windows(startDate, endDate, 31)) {
    const rows = await awin(`/publishers/${AWIN_PUBLISHER_ID}/transactions/`, { startDate: `${a}T00:00:00`, endDate: `${b}T23:59:59`, timezone: 'UTC' });
    for (const t of rows) transactions.push({
      id: t.id, date: t.transactionDate, advertiser: names[t.advertiserId] || `Annonceur ${t.advertiserId}`,
      commission: t.commissionAmount?.amount ?? 0, sale: t.saleAmount?.amount ?? 0,
      currency: t.commissionAmount?.currency || 'USD',
      status: t.commissionStatus, paid: !!t.paidToPublisher,
    });
  }
  // Clics : le rapport « advertiser » agrège par période. On interroge par semaine.
  const clicks = [];
  for (const [a, b] of windows(startDate, endDate, 7)) {
    try {
      const rep = await awin(`/publishers/${AWIN_PUBLISHER_ID}/reports/advertiser`, { startDate: a, endDate: b, region: AWIN_REGION, timezone: 'UTC' });
      const list = Array.isArray(rep) ? rep : [];
      clicks.push({ date: a, clicks: list.reduce((s, r) => s + (r.clicks || 0), 0), conversions: list.reduce((s, r) => s + (r.confirmedNo || 0) + (r.pendingNo || 0), 0) });
    } catch (e) { if (e.status === 429) break; }
  }
  res.json({ transactions, clicks, programmes: (Array.isArray(progs) ? progs : []).map(p => ({ id: p.id, name: p.name })) });
}));

// Produits : Awin fournit les produits par flux (feed) que vous créez dans votre compte. L'URL contient une clé : elle reste ici.
function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; r.push(f); f = ''; rows.push(r); r = []; }
    else f += c; }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows.filter(x => x.some(Boolean));
}
app.post('/api/awin/products', wrap(async (req, res) => {
  if (!AWIN_FEED_URL) throw Object.assign(new Error('feed'), { status: 400, publicMessage: 'AWIN_FEED_URL n’est pas renseignée. Créez un flux CSV dans Awin (Create-a-Feed) et collez son URL dans le .env.' });
  const r = await fetch(AWIN_FEED_URL);
  if (!r.ok) throw Object.assign(new Error('feed ' + r.status), { status: 502, publicMessage: 'Le flux produits Awin n’a pas pu être téléchargé.' });
  const rows = parseCSV(await r.text()); const h = rows[0] || [];
  const ix = n => h.findIndex(x => x.toLowerCase() === n);
  const c = { name: ix('product_name'), link: ix('aw_deep_link'), price: ix('search_price'), merch: ix('merchant_name'), cat: ix('merchant_category'), desc: ix('description'), cur: ix('currency') };
  if (c.name < 0 || c.link < 0) throw Object.assign(new Error('cols'), { status: 400, publicMessage: 'Le flux doit contenir au minimum product_name et aw_deep_link.' });
  const items = rows.slice(1, 201).map(x => ({ name: x[c.name], link: x[c.link], price: c.price >= 0 ? parseFloat(x[c.price]) || 0 : 0, merchant: c.merch >= 0 ? x[c.merch] : '', category: c.cat >= 0 ? x[c.cat] : '', description: c.desc >= 0 ? (x[c.desc] || '').slice(0, 300) : '', currency: c.cur >= 0 ? x[c.cur] : '' })).filter(p => p.name && p.link);
  res.json({ items });
}));

// Lien suivi via Link Builder (vérifiez les champs dans la documentation Awin si l'API évolue).
app.post('/api/awin/link', wrap(async (req, res) => {
  needAwin();
  const { advertiserId, destination } = req.body || {};
  if (!Number.isInteger(advertiserId) || !/^https?:\/\//.test(destination || '')) throw Object.assign(new Error('params'), { status: 400, publicMessage: 'advertiserId (entier) et destination (URL) requis.' });
  const r = await fetch(`${AWIN}/publishers/${AWIN_PUBLISHER_ID}/linkbuilder/generate`, {
    method: 'POST', headers: { Authorization: `Bearer ${AWIN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ advertiserId, destination, shorten: true }),
  });
  if (!r.ok) throw Object.assign(new Error('link ' + r.status), { status: 502, publicMessage: `Awin a refusé la génération du lien (${r.status}). Vérifiez que vous êtes approuvé chez cet annonceur.` });
  const j = await r.json();
  res.json({ url: j.url, shortUrl: j.shortUrl });
}));

// ============================ AMAZON ============================
// Amazon Creators API : accès soumis à l'éligibilité et à l'autorisation d'Amazon. Implémentez les appels
// uniquement d'après la documentation officielle et vos conditions d'accès. Ce backend ne fait pas de scraping
// et ne simule rien : tant que l'accès n'est pas confirmé, la route répond « non disponible ».
// Les commissions Amazon ne sont PAS synchronisées ici : importez les rapports CSV depuis Associates Central.
app.get('/api/amazon/status', wrap(async (req, res) => {
  if (AMAZON_CREATORS_ENABLED !== 'true') return res.json({ available: false, message: 'Creators API non activée sur ce serveur. Mode manuel : produits, liens et rapports CSV.' });
  res.json({ available: true, message: 'Creators API marquée comme activée. Implémentez /api/amazon/products selon la documentation officielle.' });
}));
app.post('/api/amazon/products', wrap(async (req, res) => {
  res.status(501).json({ error: 'Non implémenté : à compléter d’après la documentation officielle de l’API Amazon Creators, une fois l’accès autorisé.' });
}));

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`DSMM backend sur le port ${PORT}`));
