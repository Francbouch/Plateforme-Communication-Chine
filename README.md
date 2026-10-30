# ForgeBridge

Plateforme privée de collaboration industrielle Canada–Chine. React/Vite sur Vercel, API Hono sur Workers, données D1/SQLite et bibliothèque R2 privée. Aucun service Supabase n’est utilisé au runtime ou à l’installation.

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

Les tests navigateur nécessitent Chromium système au chemin indiqué, ou Playwright Chromium installé (omettre la variable dans ce cas). `test:private` démarre une **fixture de test en loopback** avec des clés temporaires et une base isolée, pas un fournisseur d’identité de développement utilisable en production. Elle teste la création/modification et le rechargement des projets, les dossiers, les transferts R2, les PDF/images, les téléchargements et les révisions. Le Worker publié n’importe jamais cette fixture et ne contient aucun bypass.

## Développer avec une vraie identité Access

Configurer les valeurs Worker listées dans [.env.example](.env.example), migrer D1 local et utiliser `npm run dev`. Les commandes ne fabriquent pas de session : sans JWT Access valide, l’API locale refuse les requêtes et le frontend affiche « Accès privé requis ». Pour des opérations interactives réelles, utiliser le domaine privé configuré selon [DEPLOYMENT.md](DEPLOYMENT.md), ou un tunnel local protégé par une application Access dédiée. Ne jamais exposer le serveur Vite de développement sur Internet.

## Phase 3 : révision technique

La visionneuse PDF propose annotations normalisées, points numérotés, commentaires
et réponses, statuts et historique, et remplacement de pages avec aperçu puis
nouvelle révision. [PHASE3.md](PHASE3.md) décrit le fonctionnement, la migration
`0004_pdf_review.sql` **à appliquer avant fusion**, les preuves et limites.

`npm run verify` exécute désormais la validation complète. GitHub Actions reprend
cette chaîne en isolation ; traces et captures sont conservées lors des échecs.
La règle de développement autonome est enregistrée dans [AGENTS.md](AGENTS.md).

## Fonctionnalités et limites

Fonctionnel en tests locaux : organisation, profil/préférences, projets, fournisseurs et notes internes, association projet-fournisseur, rôles/activation, invitations préparatoires/révocation, audit/outbox. L’interface conserve ses trois langues, thème et navigation. Les sauvegardes échouées ne sont pas présentées comme réussies.

La phase 2 ajoute la bibliothèque documentaire persistante : dossiers, importations R2 privées (50 Mio par fichier), PDF.js, images, téléchargements, révisions immuables, statuts et historique, recherche/filtres paginés. Voir [PHASE2.md](PHASE2.md) pour la migration additive et le raccordement du bucket avant fusion. Notifications, approbations complètes et messagerie restent à développer. Les annotations et discussions techniques sont livrées dans la phase 3. Les invitations ne peuvent pas encore être acceptées et aucun fournisseur ne peut ouvrir de session.

Le propriétaire a déjà raccordé Access, Vercel et D1 et confirmé la sauvegarde de ses projets. Le bucket R2 et la migration documentaire restent à raccorder avant le déploiement de la phase 2 ; cette session n’a pas d’accès distant Cloudflare/Vercel. La confidentialité du **déploiement réel** doit être vérifiée après configuration d’Access et du verrou Vercel ; les tests locaux ne la prouvent pas.

## Documentation

- [Phase 2 : fonctionnement, mise à jour et tests](PHASE2.md)
- [Audit initial](docs/MIGRATION_AUDIT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md)
- [PERMISSIONS.md](PERMISSIONS.md), [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md)
- [DEPLOYMENT.md](DEPLOYMENT.md), [VERCEL.md](VERCEL.md), [ROADMAP.md](ROADMAP.md)

Les anciennes migrations PostgreSQL et les précédentes instructions restent récupérables dans l’historique Git (phase 1 : f9d59c2). Cette migration ne lit, n’importe ni ne détruit aucune donnée distante existante.
