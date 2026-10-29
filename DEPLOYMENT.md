# Configuration et déploiement

Aucune dépense, création de service ou publication n’a été effectuée. Obtenir l’autorisation avant création payante et déploiement public. Ne jamais réutiliser les clés, tables ou buckets du configurateur 3D.

## Supabase dédié

1. Créer un **nouveau** projet ForgeBridge, ou utiliser Supabase local pour développer. Choisir région, offre et politique de sauvegarde explicitement.
2. Appliquer `supabase/migrations/0001_foundations.sql` puis les migrations suivantes via SQL Editor ou Supabase CLI (`supabase db push` après liaison explicite au bon projet). Ne jamais appliquer `tests/auth-schema.sql` à Supabase.
3. Configurer Auth : courriels confirmés obligatoires, SMTP de confiance, URL du site et redirect autorisé exact, mots de passe d’au moins 12 caractères, quotas de connexion/inscription, CAPTCHA selon l’exposition, TOTP MFA activé, JWT courts (15 minutes recommandées). Tester les courriels et limites. Le formulaire ne remplace pas ces réglages serveur.
4. Copier URL et clé **publishable/anon publique** dans `apps/web/.env.local` : `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`. Dans `apps/api/.dev.vars` : `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN=http://localhost:5173`. Pour un navigateur utilisé sur une autre origine de développement, adapter APP_ORIGIN exactement. Ni `.env.local` ni `.dev.vars` ne sont versionnés.
5. S’inscrire via l’interface et confirmer le courriel. Le trigger crée le profil sans droits. Depuis Administration, enrôler TOTP et valider la session, puis utiliser « Créer une organisation » : le compte devient son propriétaire. Autre chemin pour un provisioning contrôlé : via une session SQL d’administration, en remplaçant le UUID utilisateur :

```sql
begin;
with org as (
 insert into public.organizations(name) values ('Mon organisation') returning id
)
insert into public.organization_memberships(organization_id,user_id,role)
select id, 'UUID_DU_COMPTE_CONFIRME'::uuid, 'owner' from org;
commit;
```

6. Se connecter, aller dans Administration, enrôler TOTP et vérifier le code. Le propriétaire ne voit pas ses projets et ne peut pas administrer sans session AAL2. Aux connexions suivantes, utiliser « Valider la session MFA ». Créer un projet et un fournisseur, les associer depuis les collaborateurs du projet, puis inviter un ingénieur avec ce fournisseur. Le jeton est affiché une seule fois et doit être transmis manuellement par canal sûr.
7. Utiliser un deuxième compte confirmé pour accepter l’invitation. Tester une deuxième entreprise et une deuxième organisation, les accès refusés, expiration/révocation d’invitation, puis désactivation d’accès. Vérifier les notes internes via REST directe avec le JWT fournisseur : elles doivent être invisibles.

## Développement

Depuis la racine : `npm ci`, `npm run dev`. Tester le Worker par GET `/api/v1/health` ; `configured` doit être vrai avec les variables. Le frontend relaie `/api` ; pas de CORS cross-site nécessaire. Les serveurs sont des processus à redémarrer après restauration d’un environnement cloud. Les dépendances, fichiers et migrations sont persistants ; les processus ne le sont pas. Chaque tâche est déjà isolée : utiliser le checkout existant, sans créer de worktree.

Si le réseau de l’environnement est restreint, autoriser uniquement le domaine du **nouveau** projet Supabase (`<project-ref>.supabase.co`), plus les domaines existants npm/GitHub nécessaires. Ne pas fournir de secret dans le chat. Le Worker utilise une clé publique avec JWT utilisateur, aucun secret administrateur n’est nécessaire au runtime.

## Production — à exécuter uniquement après autorisation

- Prévoir une origine HTTPS unique. Servir le build Vite et router `/api/*` vers le Worker sur la même origine. Configurer le repli SPA sur `index.html` hors API. Le dépôt n’a pas de route ni de domaine public préconfiguré.
- `npm ci && npm run typecheck && npm run lint && npm test && npm run test:db && npm run build`. Exécuter aussi les tests Auth réels ci-dessus. Les seuls tests à mocks ne constituent pas un feu vert.
- Régler APP_ORIGIN sur l’origine HTTPS exacte dans Wrangler et les valeurs Supabase via les variables sécurisées de l’environnement Worker. Configurer les mêmes valeurs publiques Vite lors de la compilation. Ne jamais mettre service_role dans les variables VITE.
- Conserver le binding `RATE_LIMITER` de `wrangler.jsonc`, 60 requêtes/minute/utilisateur. Les limites Cloudflare sont distribuées et approximatives ; configurer en plus les limites Auth Supabase. Contrôler quotas/offre avant activation.
- Configurer les en-têtes frontend : `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://<project-ref>.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS sur HTTPS. Tester le SDK avec la CSP et ne pas l’assouplir sans diagnostic.
- Préparer observabilité, sauvegardes/restauration et revue sécurité. Publier séparément le frontend et le Worker uniquement après validation humaine.

## R2 — phase 2

Créer un nouveau bucket privé après autorisation, sans r2.dev/domaine public. Ajouter `r2_buckets: [{binding: 'DOCUMENTS', bucket_name: '<nouveau-bucket-forgebridge>'}]` au Worker. Aucun endpoint de fichier n’est livré dans cette phase : un binding seul ne rend pas les fichiers disponibles. Implémenter et tester d’abord les grants documentaires, validation/quarantaine, multipart et streaming autorisé selon DATABASE.md et SECURITY.md.

## Option Supabase entièrement locale

Le CLI Supabase est installé comme dépendance de développement et `supabase/config.toml` configure un projet local indépendant `forgebridge-local`, PostgreSQL 17, confirmations de courriel, JWT 15 min, mots de passe 12 caractères et TOTP. Aucun compte ni projet métier n’est préchargé.

```sh
npm run supabase:start
# Consulter les valeurs locales par le CLI, sans les copier dans les logs ou le chat.
# Reporter URL/clé publique dans les fichiers ignorés décrits plus haut.
npm run dev
# Arrêter ultérieurement uniquement ces services :
npm run supabase:stop
```

Le démarrage applique les migrations sur cette base locale et utilise une boîte SMTP locale : aucun courriel ne quitte l’environnement. Les services inutiles (Studio, Realtime, stockage Supabase, fonctions Edge et analytics) sont exclus. **Démarrage non validé ici** : le registre officiel `public.ecr.aws` est refusé par la politique réseau. L’ajout de ce domaine a été enregistré dans le brouillon de l’environnement pour révision, sans application au runtime. Enregistrer ce changement dans les paramètres, puis relancer et diagnostiquer d’éventuelles destinations de téléchargement supplémentaires, sans contourner le proxy.

## Frontend hébergé sur Vercel

La procédure spécifique au monorepo est dans [VERCEL.md](VERCEL.md). Pour cette variante, `VITE_API_BASE_URL` pointe directement vers l’origine HTTPS du Worker et son CORS n’autorise que `APP_ORIGIN`. La variante Vercel ne requiert donc pas le routage sous une origine unique décrit plus haut. Le frontend et le Worker restent deux déploiements distincts, soumis à autorisation.
