# Tests ForgeBridge

## Validation autonome

```sh
npm ci
# Chromium Playwright si aucun navigateur système n’est disponible :
npx playwright install chromium
npm run verify
# Dans l’environnement cloud actuel :
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify
```

`verify` enchaîne TypeScript strict, ESLint, Vitest, les builds Vite/Worker,
les scénarios Chromium de prévisualisation et de l’application privée. Le build
Worker utilise `--dry-run`, jamais un déploiement. La règle permanente est dans
[AGENTS.md](AGENTS.md). Ne pas demander au propriétaire de refaire ces tests ordinaires.

## Réalité et isolation des tests

- `tests/d1-api.test.ts` : moteur D1 réel via Miniflare/workerd, JWT RSA signés,
  validations Access, CRUD, rôles et refus, quotas, audit/outbox et rollback.
- `tests/documents.test.ts` : application Hono compilée dans workerd, D1 et R2
  réels isolés ; imports, SHA-256, versions immuables, téléchargements et Range,
  dossiers et cycles, recherche/pagination, annotations, fils et historique,
  conflits, auteurs et refus d’accès. Conservation après redémarrage du runtime.
- `tests/pdf-review.test.ts` : transformations canoniques des coordonnées pour
  crop/rotation/échelle, déplacements bornés, remplacement simple/multiple de pages,
  vérification du contenu réel des flux PDF, dimensions/orientations et erreurs.
- `tests/origin-storage.test.ts`, `locales.test.ts`, `dependencies.test.ts` :
  verrou Vercel, exceptions intentionnelles `/demo`/code compilé, clés R2,
  erreurs du client, parité des trois langues et absence de dépendance Supabase.
- `tests/browser-private` : Chromium sur le bundle compilé, vrai backend Hono/D1/R2
  local et identité signée de test. Création/modification et persistance des projets,
  bibliothèque, PDF/images, téléchargements/révisions et reprise de transfert,
  annotations et discussions, position au zoom/plein écran, remplacement de pages.
  Assertions sur les octets et données, pas uniquement sur HTTP 200 ou les captures.
- `tests/browser` : routes, bundle, langues/thèmes/mobile et aperçu `/demo`
  sans appels au backend. L’absence d’API sur cette fixture statique est volontaire.

Les dossiers de données et buckets de ces tests sont temporaires et distincts
pour chaque fixture. Leur nettoyage ne supprime que les ressources locales dont
les tests sont propriétaires. Aucune écriture de test ne vise la production.
Le serveur privé n’écoute qu’en loopback ; les identités et clés sont éphémères,
jamais importées par le Worker ou Vercel en production.

## Rapports et diagnostic

Les configurations Playwright conservent une capture et `trace.zip` sur chaque
échec. Elles produisent `test-results/private-results.json` et
`test-results/preview-results.json` ; les dossiers de sortie sont séparés.
Ouvrir une trace avec `npx playwright show-trace <chemin>/trace.zip`.

GitHub Actions exécute `npm run verify` sur PR et `main`, avec Node 24 et Chromium,
sans secret Cloudflare, puis publie les traces/rapports comme artefacts pendant
sept jours. La configuration de CI ne prouve pas à elle seule son exécution distante.

## Dernière validation observée — phase 3

**47 tests Vitest et 8 scénarios Chromium réussis ; 0 échec, 0 ignoré et aucun
scénario navigateur instable.** Types, lint et les deux builds réussissent.
Voir [preuves détaillées](docs/PHASE3_TEST_RESULTS.md) et la correspondance des
22 scénarios demandés dans [PHASE3.md](PHASE3.md).

Les erreurs injectées (HTTP de sauvegarde, coupure de transfert, contraintes,
rollback, signature/accès invalides) sont attendues et vérifient les refus et la
reprise. Elles ne constituent pas des échecs de tests.

Les tests distants de Cloudflare Access/JWKS, Vercel et R2 de production n’ont pas
été exécutés dans cette session faute d’accès et d’isolation de staging confirmés.
Le contrôle d’accès distant ne doit jamais être déduit du seul build local.
