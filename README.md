# dsmm-backend

Petit serveur Node.js qui connecte **Daily Smart Market Manager** aux API des plateformes sans jamais exposer vos clés dans le navigateur.

## Ce qui est pris en charge

| Plateforme | Fonction | Route |
|---|---|---|
| Awin | Vérifier la connexion | `GET /api/awin/status` |
| Awin | Transactions, commissions (en attente, validées, payées), programmes, clics agrégés par semaine | `POST /api/awin/sync` |
| Awin | Produits via votre flux CSV (Create-a-Feed) | `POST /api/awin/products` |
| Awin | Lien suivi (Link Builder) | `POST /api/awin/link` |
| Amazon | État de la Creators API | `GET /api/amazon/status` |
| Amazon | Produits via Creators API | `POST /api/amazon/products` (non implémenté : à compléter après autorisation d'Amazon) |

**Amazon : les commissions ne sont pas synchronisées automatiquement.** Importez vos rapports CSV dans l'application (onglet Affiliation > Importer un rapport).

## Installation

1. Installez Node.js 20.12 ou plus récent.
2. Dans ce dossier : `npm install`
3. Copiez `.env.example` en `.env` et remplissez-le :
   - `ALLOWED_ORIGIN` : l'adresse exacte de l'application (sans `/` final).
   - `APP_ACCESS_KEY` : une longue valeur aléatoire de votre choix. Vous la saisirez dans l'application (champ « Clé d'accès »).
   - `AWIN_API_TOKEN` : Awin > Account > API Credentials.
   - `AWIN_PUBLISHER_ID` : votre identifiant éditeur (chiffres).
   - `AWIN_FEED_URL` (facultatif) : URL du flux CSV créé dans Awin.
4. `npm start`, puis testez : `curl http://localhost:8787/health`

## Publication

Hébergez ce dossier chez un fournisseur Node.js (Render, Railway, Fly.io, VPS…). Définissez les variables du `.env` dans l'interface de l'hébergeur plutôt que de téléverser le fichier. Servez-le **en HTTPS**. Dans l'application : Affiliation > Connecter mon compte > adresse du backend > Tester la connexion.

## Sécurité

- Les jetons Awin et Amazon restent dans les variables d'environnement du serveur. Ils ne sont jamais renvoyés au navigateur.
- Chaque appel exige `APP_ACCESS_KEY`. Cette clé est stockée dans le navigateur de l'application : elle protège votre backend, pas vos comptes Awin ou Amazon. Si vous la pensez compromise, changez-la dans le `.env`.
- CORS n'autorise que `ALLOWED_ORIGIN`. Une limite de 40 requêtes par minute et par adresse est appliquée.
- Une vraie authentification par utilisateur (par exemple Supabase Auth) est recommandée dès que plusieurs personnes utilisent l'application.
- Ne publiez jamais le fichier `.env`.

## Conditions d'utilisation

Utilisez uniquement les API officielles, dans la limite de leurs quotas, et conformément aux conditions de chaque programme (Awin Publisher, Amazon Associates et Creators API). N'extrayez pas de données par automatisation de pages web et ne stockez aucun mot de passe de plateforme. Les noms de champs des API peuvent évoluer : vérifiez la documentation officielle si une route échoue.
