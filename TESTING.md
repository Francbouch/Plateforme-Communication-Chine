# Tests — migration D1 / Access

## Commandes

```sh
npm ci
npm run db:migrate
npm run db:migrate   # seconde exécution : aucune migration en attente
npm run typecheck
npm run lint
npm test
npm run build
npm run build:worker
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:preview
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:private
```

Chromium système est utilisé dans cet environnement. Ailleurs, installer normalement Chromium Playwright puis omettre la variable. Aucune désactivation de vérification TLS/signature/checksum.

## Portée des tests

Les 21 tests historiques ont été exécutés avant migration et passaient. Les tests liés aux mocks SDK et aux fonctions Auth PostgreSQL sont remplacés par des tests de la nouvelle architecture ; les dictionnaires et le navigateur existants sont conservés/adaptés.

- `d1-api.test.ts` : **vrai moteur D1 Miniflare/workerd**, migrations réellement appliquées, API Hono avec des JWT RSA réellement signés et clés éphémères. Le JWKS resolver de test est injecté seulement dans la factory de test ; le Worker livré utilise uniquement le JWKS distant de son domaine Access configuré.
- Vérification signature falsifiée, expiration, issuer/AUD erronés, tokens non applicatifs, absence de jeton sur API/santé/HTML/assets, absence de configuration, autre courriel, profil suspendu et en-têtes d’identité falsifiés.
- Création organisation/projet, modification, lecture, restart du runtime sur stockage D1 persistant, erreurs de saisie/contrainte, intégrité inter-tenant, fournisseurs/notes, associations, préférences, audit/outbox, rollback si l’audit échoue.
- Isolation future des fournisseurs : même organisation avec projets différents, notes privées, refus d’édition, révocation ; ces fixtures ne constituent pas des comptes fournisseurs activés dans l’application.
- Invitations hashées, révocation et refus explicite d’acceptation ; CORS exact, origines hostiles, quota et verrou de l’origine frontend.
- `origin-storage.test.ts` : middleware Vercel refuse secret absent/faux, accepte la preuve correcte ; clés R2 scoped, client same-origin sans secret et gestion des erreurs non-JSON/écriture.
- `test:preview` : bundle compilé, état « Accès privé requis » sans session, langues/thème/mobile, routes directes et fichiers JS. Ce serveur statique **local** n’est pas une preuve de protection Vercel.
- `test:private` : Chromium → passerelle Hono → D1 réel et build compilé. Crée une organisation et un projet, recharge, modifie et recharge, vérifie la langue. Le serveur de fixture n’écoute qu’en loopback, utilise des clés temporaires et une base de test, et n’est importé ni par le Worker ni par Vercel. Il simule l’injection de JWT par la frontière Access, dont la validation est testée séparément ; il ne simule pas la persistance ou les réponses métier.

Les tests D1 sont isolés et détruisent uniquement leurs dossiers temporaires. Ils utilisent l’adaptateur de compatibilité officiellement exporté `convertV4MiniflareOptions` de Miniflare 5 fourni par Wrangler. Le CLI de migration local valide aussi les fichiers SQL et leur suivi incrémental.

## Vérifications distantes non effectuées

Aucun compte Cloudflare/Vercel configuré dans la session, aucune création D1/R2 distante, aucun `wrangler deploy` réel. Le build Worker est un **dry-run**. Aucune politique Access/rotation JWKS distante, aucun middleware Vercel déployé ni accès Chine n’est validé. Les étapes de recette négative/positive sont dans DEPLOYMENT.md.

Les résultats locaux ne prouvent pas que le domaine en production est privé. L’authentification externe, les alias Vercel/Worker et la politique Access doivent être testés avant les données confidentielles. Les uploads, scans, downloads et révisions restent hors de cette migration.

## Résultats exécutés

- Migrations D1 locales `0001` et `0002` : appliquées ; réexécution après `0001` sans migration en attente, puis évolution `0002` appliquée sans reset.
- TypeScript strict, lint, build frontend : réussis.
- Build Worker : réussi en dry-run, sans upload réel.
- Tests unitaires/intégration : **28 réussis** (22 D1/Access/R2, 4 origine/client, 1 dictionnaires, 1 absence Supabase).
- Chromium bundle compilé : **3 réussis** (état sans accès, langues/thème, mobile/routes/assets).
- Chromium API/D1 privé isolé : **1 réussi**, création/modification/rechargements et langue sauvegardée.
- R2 local : checksum, refus d’écrasement, lecture et nettoyage de quarantaine vérifiés. Un flux R2 doit avoir une longueur connue (corps Request/Response ou FixedLengthStream) ; le test local utilise des octets de longueur connue.

Le test a détecté le retour intempestif à la langue de profil et l’interface a été corrigée ; le parcours a été rejoué avec succès. Une erreur volontaire d’audit dans le test produit un log de classe Error et un refus, tout en confirmant le rollback des données : ce n’est pas un échec du test.
