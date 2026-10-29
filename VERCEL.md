# Afficher ForgeBridge sur Vercel

Aucun déploiement n’est effectué par ces instructions. Le code de phase 1 est déjà sur `main` (PR GitHub nº 1 fusionnée). La configuration Vercel est ajoutée sur une branche distincte à fusionner avant l’import de `main`, ou à sélectionner explicitement pour un aperçu.

## Chemin le plus rapide : afficher l’interface

1. Dans Vercel, choisir **Add New → Project**, puis importer le dépôt GitHub `Francbouch/Plateforme-Communication-Chine`. Autoriser l’application GitHub Vercel à lire ce dépôt si nécessaire.
2. Choisir un nom de projet disponible, par exemple `forgebridge`. Sélectionner **Vite** comme Framework Preset.
3. Laisser **Root Directory** à la racine du dépôt (`./`). **Ne pas sélectionner `apps/web`** : les dépendances sont gérées par le lockfile racine et le frontend partage des types avec `packages/shared`.
4. Dans Build and Output Settings, vérifier les valeurs ci-dessous (déjà définies dans `vercel.json`). Dans Project Settings → Build and Deployment, sélectionner **Node.js 24.x**.

| Réglage          | Valeur                              |
| ---------------- | ----------------------------------- |
| Root Directory   | `./` (racine Git)                   |
| Framework Preset | Vite                                |
| Install Command  | `npm ci`                            |
| Build Command    | `npm run build -w @forgebridge/web` |
| Output Directory | `apps/web/dist`                     |
| Node.js          | 24.x                                |

5. Pour voir immédiatement la structure de l’interface, les langues et le thème, **ne saisir aucune variable fictive**. Le frontend est compilable sans backend et affichera honnêtement « Configuration Supabase requise ». Cette page ne donne pas accès au dashboard authentifié.
6. Vérifier que la branche déployée contient `vercel.json`. Pour la configuration définitive, fusionner la branche `forgebridge/vercel-frontend` dans `main` et utiliser **Production Branch = main**. Pour un aperçu préalable, ouvrir GitHub sur cette branche puis, une fois le projet Vercel connecté, déclencher son déploiement de branche depuis Vercel (ou pousser un commit autorisé sur cette branche). Un déploiement d’aperçu est distinct du déploiement Production.
7. Cliquer **Deploy** lorsque vous souhaitez autoriser le déploiement frontend. Choisir ensuite **Visit** et ouvrir l’URL fournie par Vercel dans Chrome. Aucune URL n’est réservée à l’avance. Si un contrôle d’accès Vercel est activé, se connecter au compte Vercel autorisé.
8. Recharger directement `/projects` et `/admin` : la règle SPA de `vercel.json` renvoie `index.html` pour que React Router traite ces routes. Les fichiers statiques existants restent servis par Vercel. Les pages métier demeurent protégées par l’authentification et l’API.

**Ce déploiement publie uniquement des fichiers frontend.** Vercel ne démarre ni Wrangler, ni PostgreSQL, ni Supabase Docker. Les comptes Cloudflare/Supabase et leurs éventuels coûts nécessitent une décision séparée. Un build réussi n’établit pas que la connexion ou les données fonctionnent.

## Variables Vercel

Dans Project Settings → Environment Variables, sélectionner les environnements concernés (Preview et/ou Production). Ajouter les valeurs réelles, puis **redéployer** : les variables `VITE_*` sont incorporées au JavaScript au moment du build.

| Variable                        | Valeur à fournir                                                                     | Portée                                    |
| ------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `VITE_SUPABASE_URL`             | URL HTTPS du **nouveau** projet Supabase dédié                                       | Publique                                  |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clé publishable/anon publique de ce même projet                                      | Publique, autorisations protégées par RLS |
| `VITE_API_BASE_URL`             | Origine HTTPS du Worker, p. ex. `https://forgebridge-api.<sous-domaine>.workers.dev` | Publique ; sans `/api/v1`, sans chemin    |

Ne jamais mettre de clé `service_role`, token Cloudflare, mot de passe SQL, clé R2 ou secret SMTP dans une variable `VITE_*`. Marquer une variable VITE comme sensible dans Vercel ne l’empêche pas d’être incluse dans le bundle public. Voir `.env.example` pour les noms, sans secrets.

Sans les deux variables Supabase, l’interface affiche la configuration manquante. Avec Supabase mais sans backend fonctionnel, les pages métier afficheront une erreur : cela ne doit pas être présenté comme une application complète. Sur Vercel, `VITE_API_BASE_URL` est nécessaire pour le backend ; le proxy `server.proxy` de Vite sert uniquement au développement local. La règle SPA n’est pas un proxy d’API.

## Connecter Cloudflare Workers et Supabase

Architecture choisie : **Chrome → Vercel (frontend statique)**, puis **Chrome → Worker (API Bearer avec CORS exact)** et **Chrome → Supabase Auth**. Le Worker appelle PostgreSQL/Supabase avec le JWT utilisateur ; aucune clé administrative ne contourne RLS.

1. Après autorisation de préparer les services distants, configurer un **nouveau** Supabase selon `DEPLOYMENT.md` et appliquer les trois migrations dans l’ordre. Aucun ancien projet ne doit être réutilisé.
2. Configurer le Worker ForgeBridge dédié. Variables du Worker : `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` et `APP_ORIGIN=https://<nom-exact-du-projet>.vercel.app` (origine exacte, sans slash final ni chemin). Conserver `RATE_LIMITER`. Le bucket R2 n’est pas requis pour afficher cette phase.
3. Le déploiement du Worker reste une action distincte nécessitant votre autorisation ; Vercel ne l’effectue pas. Après déploiement autorisé, relever son URL HTTPS et renseigner `VITE_API_BASE_URL` dans Vercel. Ne pas utiliser `localhost` : depuis Chrome, il désignerait la machine du visiteur.
4. Le middleware CORS autorise uniquement `APP_ORIGIN`, les méthodes utilisées et les en-têtes Authorization/Content-Type. Les requêtes OPTIONS de prévol ne nécessitent pas de session ; les opérations métier restent authentifiées et soumises à RLS. Les mutations rejettent les autres origines. Les sessions utilisent un Bearer JWT, sans cookie cross-site.
5. Pour tester un aperçu Vercel dont l’URL diffère, utiliser une origine d’aperçu stable et un Worker/configuration de test séparé. Ne pas autoriser globalement `*.vercel.app` : d’autres utilisateurs contrôlent leurs propres domaines Vercel. Ne pas remplacer l’origine du Worker de production à chaque aperçu.
6. Dans Supabase Authentication → URL Configuration, régler **Site URL** sur l’origine Vercel choisie et ajouter les URLs de redirection exactes nécessaires. Activer confirmation des courriels et TOTP ; configurer SMTP et protections anti-abus. Ajouter uniquement des aperçus de confiance. Créer/confirmer le compte, configurer MFA dans Administration, puis créer l’organisation.
7. Vérifier l’API `/api/v1/health` sur le Worker : `configured:true` confirme uniquement la présence des variables, pas les permissions. Dans Chrome → Network, vérifier OPTIONS puis les réponses API ; tester connexion, MFA, projets et isolation avec de vrais comptes. Les critères Auth réels de phase 1 restent à valider.

L’autre architecture décrite historiquement dans DEPLOYMENT.md (frontend et API sous la même origine via routage) reste possible mais nécessite un proxy explicite. Cette configuration Vercel utilise le Worker directement ; aucun proxy n’est inventé et aucune URL backend fictive n’est enregistrée.

## Diagnostic rapide

- **404 au rechargement de `/projects`** : vérifier présence de `vercel.json` dans la branche choisie et Root Directory `./`.
- **Workspace/package introuvable** : Root Directory incorrecte ; utiliser la racine et `npm ci`.
- **Écran de configuration** : variables Supabase absentes au moment du build ; ajouter puis redéployer.
- **Connexion visible mais erreur de compte/projets** : vérifier migrations, Worker, `VITE_API_BASE_URL` et session ; consulter le statut HTTP dans Chrome.
- **Erreur CORS** : `APP_ORIGIN` doit correspondre exactement à l’origine affichée dans Chrome ; redéployer le Worker après modification.
- **Réponse HTML au lieu de JSON** : appels `/api` dirigés vers Vercel faute de `VITE_API_BASE_URL` ; la réécriture SPA ne fournit aucune API.
- **Confirmation par courriel sur une mauvaise adresse web** : corriger Site URL et les redirect URLs Supabase.

Les tests locaux valident le build et le rendu ; aucun déploiement Vercel ni URL distante n’est validé tant que vous n’avez pas déclenché cette étape.
