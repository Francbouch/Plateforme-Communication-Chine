# Tests et preuves de validation

## Résultats exécutés dans l’environnement cloud

| Vérification                        | Résultat         | Portée                                                                                                                              |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`       | Réussi           | Réinstallation finale depuis le lockfile, CLI Supabase inclus                                                                       |
| `npm run typecheck`                 | Réussi           | TypeScript strict frontend/API/contrats/tests                                                                                       |
| `npm run lint`                      | Réussi           | ESLint TypeScript                                                                                                                   |
| `npm test`                          | 16 tests réussis | 15 tests API/validation, 1 parité des dictionnaires fr-CA/en/zh-CN                                                                  |
| `npm run build`                     | Réussi           | Bundle Vite et types ; avertissements de directives `use client` et annotations de dépendances, sans échec                          |
| `npm run test:db`                   | Réussi           | PostgreSQL 17 éphémère, les 3 migrations et assertions RLS/mutations/invitations                                                    |
| Tests Chromium                      | 2 réussis        | État sans configuration, langues persistantes, thème persistant, absence de débordement horizontal mobile                           |
| Démarrage Vite + Wrangler           | Réussi           | HTML HTTP 200 ; santé API via proxy Vite HTTP 200 avec `configured:false`                                                           |
| Supabase Auth local                 | Bloqué           | Le registre officiel `public.ecr.aws` retourne Forbidden avec la politique réseau actuelle ; aucune authentification réelle validée |
| Supabase cloud, SMTP réel, MFA réel | Non exécutés     | Aucun nouveau service ni compte cloud configuré                                                                                     |
| R2 upload/download                  | Non exécutés     | Hors phase 1, aucune route documentaire disponible                                                                                  |

Les tests API remplacent le SDK Supabase par un mock : ils couvrent absence/invalidation de session, compte suspendu, origine interdite, validation des projets, refus d’autorisation sans fuite SQL, RPC de création, hash des jetons, rôle fournisseur incohérent, limitation de requêtes et absence d’endpoint fichier. Ils ne prouvent pas que GoTrue ou PostgREST est configuré.

Les tests SQL utilisent un vrai moteur PostgreSQL avec des fonctions **de test** reproduisant le contrat `auth.uid()`/`auth.jwt()`, et des claims explicitement injectées. Ils ne remplacent pas la vérification de signature JWT ou la connexion réelle. Ils testent lecture de projet par fournisseur, identifiant de projet adverse, autre organisation, notes internes/outbox invisibles, refus de mutation fournisseur et de modification directe des appartenances, MFA AAL1 et AAL absent refusés, création de projet, invitation nominative, mauvais courriel, acceptation, usage unique, révocation d’organisation/fournisseur/projet, expiration/révocation d’invitation, création d’organisation et propriétaire, association fournisseur, notes, préférences et audit.

## Rejouer

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:db
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:browser
```

`test:db` utilise uniquement `/var/run/docker.sock`, crée une base sans port publié et détruit son conteneur via trap. Aucun serveur distant ni donnée existante n’est réinitialisé. Docker et accès au registre PostgreSQL sont nécessaires. Les scripts conservent les codes de sortie et `ON_ERROR_STOP` arrête tout échec SQL. Le test s’exécute dans une transaction annulée.

Le test navigateur doit être lancé sans variables VITE Supabase pour vérifier l’état non configuré. Avec une installation Playwright standard, omettre PLAYWRIGHT_CHROMIUM_EXECUTABLE après `npx playwright install chromium`. Dans cet environnement le téléchargement Playwright est refusé par le réseau ; Chromium système a permis les tests. Un défaut `html.lang` après rechargement a été détecté et corrigé, puis les deux tests ont été relancés avec succès.

## Parcours réel encore requis avant acceptation de la phase 1

Autoriser le registre officiel pour `npm run supabase:start`, ou configurer un nouveau Supabase dédié selon DEPLOYMENT.md. Vérifier inscription, confirmation du courriel, connexion, enrôlement/challenge MFA, création d’organisation/projet/fournisseur, association, invitation et acceptation avec un autre compte. Refaire les accès croisés via API et PostgREST avec de vrais JWT ; tester révocation de droits et sessions, protection Auth brute-force et langues sauvegardées par compte.

Les critères d’acceptation liés à la connexion réelle et aux opérations navigateur authentifiées restent **non validés**. La phase 1 ne doit pas être annoncée entièrement acceptée avant ces contrôles.

## Préparation Vercel

Le frontend est dans `apps/web`, installé depuis le workspace racine et compilé vers `apps/web/dist`. `vercel.json` configure ce build et le repli SPA. Une configuration Playwright distincte teste les fichiers **compilés** via `vite preview`, sans réutiliser le serveur de développement :

```sh
npm run build -w @forgebridge/web
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:preview
```

Résultats : build, types et lint réussis ; **21 tests unitaires/API** (dont CORS exact et routage du client vers le Worker) et **3 tests navigateur du bundle compilé** réussis. Les accès directs `/`, `/projects`, `/admin`, `/documents`, les assets JavaScript, les langues, le thème et la largeur mobile sont vérifiés. Les tests de rendu utilisent l’état sans Supabase, pas une session métier simulée. Le CORS accepte le prévol depuis APP_ORIGIN, ne l’accorde pas à un domaine tiers et conserve les erreurs d’authentification lisibles par le frontend autorisé.

Ces contrôles ne constituent pas une exécution sur l’infrastructure Vercel : la réécriture distante devra être confirmée après le déploiement autorisé. Aucun backend cloud, compte Supabase réel ni URL Vercel n’est créé par ces tests. Aucune modification de migration SQL n’a été nécessaire.
