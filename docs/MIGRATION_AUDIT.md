# Audit avant migration D1 / Access

Base inspectée : `main` ff82612 (PR nº 1 et nº 2 fusionnées). Aucun workflow GitHub n’est présent. Workspace npm : frontend `apps/web`, API `apps/api`, contrats `packages/shared`. Vercel compile le frontend depuis la racine ; Wrangler n’a encore ni binding D1 ni R2.

Supabase est utilisé dans les deux manifests applicatifs et le CLI racine, `client.ts`, `main.tsx`, Login/Mfa, toutes les routes API (Auth/getUser, PostgREST, RPC), les tests à mocks, les scripts Docker/PostgreSQL et les variables d’environnement. Les trois migrations PostgreSQL définissent 12 tables, un enum, fonctions SECURITY DEFINER, trigger Auth, RPC transactionnelles et policies RLS. Rien ne prouve qu’un service distant contient des données ; aucune donnée distante n’est lue, importée ou supprimée par cette migration.

Implémenté : organisations/profils, projets CRUD sans suppression, fournisseurs/notes, associations projet-fournisseur, rôles/activation, invitations nominatives, préférences, audit/outbox. Prévu uniquement : documents/révisions/pages/annotations, uploads, antivirus, visualisation PDF, traductions métier et notifications. L’adaptateur R2 n’a aucune route publique.

Décisions : remplacer PostgreSQL/RPC/RLS par D1/SQLite avec clés étrangères composites, CHECK et requêtes paramétrées ; `D1.batch` pour mutations + audit + outbox atomiques. Chaque accès porte ses conditions de tenant/projet/fournisseur dans l’API. Aucune identité de navigateur n’est prise pour preuve sans vérification cryptographique. Un seul compte est lié au vrai sujet Access autorisé ; les comptes et invitations fournisseurs restent inactifs. Supprimer Login/Mfa applicatifs, conserver les écrans métier et leurs traductions.

Protection : Access devant un Worker passerelle qui valide RS256, issuer, audience, exp/iat, sujet et email administrateur. Le Worker proxy les assets Vercel après validation ; le middleware serveur Vercel refuse l’origine directe sans secret partagé serveur-à-serveur. Aucun token ou secret dans Vite. Ne pas déclarer le déploiement privé avant vérification distante des deux protections.

Documentation officielle consultée dans le dépôt Cloudflare `cloudflare/cloudflare-docs`, branche production, le 29 octobre 2026 :

- https://developers.cloudflare.com/d1/worker-api/d1-database/ — batch séquentiel transactionnel avec rollback.
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ — bindings et API privées R2.
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ — header Cf-Access-Jwt-Assertion, JWKS distant/rotation, issuer et AUD ; exemple jose. Le mode ctx.access actuel est possible, mais la validation JWT explicite est retenue pour satisfaire la migration et tester les revendications.
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ — créer la protection avant publication et protéger aussi l’origine.

Accès observés : `wrangler whoami` non authentifié ; aucun token/account ID Cloudflare ni token Vercel configuré. Git HTTPS fonctionnel ; l’API GitHub restait interdite par le réseau lors du dernier contrôle. Développement local possible sans ces intégrations. Aucune ressource d’un autre projet ne doit être modifiée.
