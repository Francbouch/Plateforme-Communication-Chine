# ForgeBridge

Plateforme privée de collaboration technique Canada–Chine. Phase 1 : fondations applicatives, projets, fournisseurs, accès individuels et invitations. Aucun déploiement ni ressource cloud n’est créé automatiquement.

## Démarrage

Node.js 24 LTS et npm 11. Depuis la racine du dépôt :

```sh
npm ci
npm run dev
```

Vite écoute sur le port 5173 et relaie `/api` vers le Worker local sur 8787. Sans configuration Supabase, l’interface affiche les instructions de configuration et l’API retourne 503 sur les routes protégées ; ce mode ne simule pas une connexion.

Pour les opérations réelles, créer **un nouveau** projet Supabase dédié (ou une instance Supabase locale), puis suivre [DEPLOYMENT.md](DEPLOYMENT.md). Copier les deux ensembles de variables de [.env.example](.env.example) vers `apps/web/.env.local` et `apps/api/.dev.vars`. Appliquer les migrations dans l’ordre. Créer et confirmer le premier compte, provisionner son organisation par SQL administrateur, activer TOTP puis valider la session MFA dans Administration.

Les inscriptions ne donnent aucun accès métier. Un propriétaire crée un projet, un fournisseur, associe ce fournisseur au projet, puis crée une invitation nominative. Le destinataire confirme son compte, se connecte et colle le jeton dans Administration. Le jeton est partagé manuellement via un canal sûr ; aucun courriel d’invitation métier n’est envoyé automatiquement.

## Commandes

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:db       # Docker local, PostgreSQL isolé, sans ports publiés
npm run test:browser  # Chromium Playwright installé au préalable
```

## Structure

- `apps/web/src/` : React, React Router, TanStack Query, i18next, Tailwind CSS et composants HTML accessibles.
- `apps/api/src/` : API REST Hono `/api/v1`, authentification Supabase, validation Zod, adaptateur privé R2.
- `packages/shared/src/` : types et contrats de saisie communs.
- `supabase/migrations/` : tables, contraintes, RLS et RPC transactionnelles.
- `tests/` : tests API, SQL et navigateur.

Lire [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md), [PERMISSIONS.md](PERMISSIONS.md), [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md) et [ROADMAP.md](ROADMAP.md).

## Limites actuelles

La gestion documentaire, les annotations, la messagerie et les notifications restent explicitement indisponibles. Aucun endpoint de fichier n’existe. Le succès des tests SQL locaux ne valide pas le service Supabase Auth, son SMTP ou une configuration de production. Les listes sont plafonnées à 200 entrées ; une pagination sera nécessaire avant une utilisation à grande échelle. Voir les résultats effectivement exécutés dans TESTING.md.
