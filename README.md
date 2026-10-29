# ForgeBridge

Plateforme privée de collaboration industrielle Canada–Chine. React/Vite sur Vercel, API Hono sur Workers, données D1/SQLite et adaptateur R2 privé. Aucun service Supabase n’est utilisé au runtime ou à l’installation.

## Accès privé

Le domaine d’entrée est un Worker protégé par **Cloudflare Access**, qui valide chaque JWT et sert aussi les fichiers Vercel. L’origine Vercel refuse tout accès direct sans un secret partagé serveur-à-serveur. Le navigateur appelle `/api/v1` sous la même origine : aucun secret, compte fictif ou jeton applicatif dans Vite. Voir [SECURITY.md](SECURITY.md).

Le mode développeur privé permet **un seul administrateur réel**, identifié par Access. Les comptes fournisseurs ne sont pas activés. L’identité Access est liée à un UUID interne stable configurable ; elle est distincte du modèle futur de comptes. Aucun projet ni statistique de démonstration n’est créé. L’administrateur crée son organisation depuis Administration.

## Installer et valider localement

Node.js 24 LTS, npm 11. Chaque tâche cloud est déjà isolée : utiliser le checkout existant, sans créer de worktree.

```sh
npm ci
npm run db:migrate        # uniquement D1 local ; répétable
npm run typecheck
npm run lint
npm test                 # vrai D1 Miniflare + JWT signés isolés
npm run build
npm run build:worker     # Wrangler dry-run, aucun déploiement
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:preview
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:private
```

Les tests navigateur nécessitent Chromium système au chemin indiqué, ou Playwright Chromium installé (omettre la variable dans ce cas). `test:private` démarre une **fixture de test en loopback** avec des clés temporaires et une base isolée, pas un fournisseur d’identité de développement utilisable en production. Elle teste vraiment la création/modification et le rechargement des projets. Le Worker publié n’importe jamais cette fixture et ne contient aucun bypass.

## Développer avec une vraie identité Access

Configurer les valeurs Worker listées dans [.env.example](.env.example), migrer D1 local et utiliser `npm run dev`. Les commandes ne fabriquent pas de session : sans JWT Access valide, l’API locale refuse les requêtes et le frontend affiche « Accès privé requis ». Pour des opérations interactives réelles, utiliser le domaine privé configuré selon [DEPLOYMENT.md](DEPLOYMENT.md), ou un tunnel local protégé par une application Access dédiée. Ne jamais exposer le serveur Vite de développement sur Internet.

## Fonctionnalités et limites

Fonctionnel en tests locaux : organisation, profil/préférences, projets, fournisseurs et notes internes, association projet-fournisseur, rôles/activation, invitations préparatoires/révocation, audit/outbox. L’interface conserve ses trois langues, thème et navigation. Les sauvegardes échouées ne sont pas présentées comme réussies.

R2 est un adaptateur privé préparé, sans endpoint documentaire. Uploads, PDF, révisions, annotations, notifications et messagerie restent à développer. Les invitations ne peuvent pas encore être acceptées et aucun fournisseur ne peut ouvrir de session.

La création distante D1/R2 et les déploiements ne sont pas effectués : aucun accès Cloudflare/Vercel n’était configuré. La confidentialité du **déploiement réel** doit être vérifiée après configuration d’Access et du verrou Vercel ; les tests locaux ne la prouvent pas.

## Documentation

- [Audit initial](docs/MIGRATION_AUDIT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md)
- [PERMISSIONS.md](PERMISSIONS.md), [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md)
- [DEPLOYMENT.md](DEPLOYMENT.md), [VERCEL.md](VERCEL.md), [ROADMAP.md](ROADMAP.md)

Les anciennes migrations PostgreSQL et les précédentes instructions restent récupérables dans l’historique Git (phase 1 : f9d59c2). Cette migration ne lit, n’importe ni ne détruit aucune donnée distante existante.
