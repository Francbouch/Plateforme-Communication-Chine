# Vercel — origine frontend privée derrière Cloudflare Access

## Changement de fonctionnement

React/Vite reste sur Vercel, sans changement visuel inutile. Le navigateur doit désormais ouvrir le **domaine privé du Worker**, pas l’URL Vercel directe. Access protège ce domaine, le Worker valide le JWT puis récupère les fichiers Vercel avec une clé serveur. Le middleware Vercel bloque l’origine directe. Aucun compte ou écran de connexion intégré à ForgeBridge.

Aucun déploiement Vercel n’a été effectué dans cette tâche. Ne pas considérer le site privé avant les tests distants de DEPLOYMENT.md. Aucun achat ni modification d’un autre projet n’est autorisé implicitement.

## Réglages du projet ForgeBridge existant

| Réglage               | Valeur                                         |
| --------------------- | ---------------------------------------------- |
| Root Directory        | `./` (racine du dépôt)                         |
| Framework             | Vite                                           |
| Install               | `npm ci`                                       |
| Build                 | `npm run build -w @forgebridge/web`            |
| Output                | `apps/web/dist`                                |
| Node.js               | 24.x                                           |
| Branche de production | `main` uniquement après revue/fusion autorisée |

`vercel.json` conserve le repli SPA. `middleware.ts` à la racine doit être détecté et déployé par Vercel comme Routing Middleware ; il utilise le paquet maintenu `@vercel/functions`. Tous les chemins sont couverts, y compris les assets. Si le middleware n’est pas détecté ou si un asset reste public, **arrêter la publication privée**, corriger la configuration et refaire les tests négatifs. Un build Vite seul ne compile ni ne prouve ce middleware sur Vercel.

Dans Settings → Environment Variables, sur chaque environnement concerné :

| Variable               | Portée                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `ORIGIN_SHARED_SECRET` | Serveur uniquement, au moins 32 octets aléatoires encodés ; même valeur dans le Worker |

Supprimer les anciennes variables ForgeBridge `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` et `VITE_API_BASE_URL`. **Aucune variable VITE n’est nécessaire.** Ne pas renommer le secret avec le préfixe VITE. Les variables publiques Vite finissent dans le bundle même si leur champ est masqué dans le tableau de bord.

Le frontend appelle désormais `/api/v1` sur l’origine du navigateur. L’URL de l’API est donc celle du **domaine privé Worker**, automatiquement ; aucune requête du navigateur n’a besoin de viser un autre hostname. Ne pas revenir au Worker cross-site avec cookies Access : cela provoquerait des prévols et redirections d’authentification difficiles à sécuriser.

## Ordre de raccordement

1. Revoir la branche de migration, définir le secret serveur Vercel, préparer un aperçu à publier uniquement après autorisation. Ne pas fusionner automatiquement une branche pouvant déclencher un déploiement de production.
2. Vérifier que l’URL directe Vercel et un asset JS refusent les requêtes sans la preuve serveur. Le site direct est **volontairement inaccessible** dans Chrome.
3. Mettre l’hôte HTTPS Vercel canonique dans `VERCEL_ORIGIN` du Worker, sans slash final, chemin ni redirection vers un autre alias. Donner le même secret au Worker. Un déploiement Vercel protégé n’a pas besoin de connaître le domaine Access.
4. Configurer D1, Access, l’allowlist administrateur et le Custom Domain Worker selon DEPLOYMENT.md.
5. Après publication autorisée et tests de refus, ouvrir **ce Custom Domain privé** dans Chrome. Access effectue la connexion externe ; ForgeBridge crée uniquement le profil réel associé et permet la création du workspace.

Chaque aperçu Vercel possède son propre environnement serveur : ne pas oublier la variable dans Preview et ne pas exposer un ancien alias non protégé. Éviter les liens de preview en tant qu’entrée utilisateur. Le Worker répond 502 si l’origine redirige ; choisir son hostname canonique et diagnostiquer la protection Vercel native si elle interfère, sans rendre les assets publics.

Le serveur `vite preview` des tests ne déploie pas le middleware Vercel. Son contrôle est testé séparément et dans le parcours local de passerelle ; seule une vérification distante prouve son activation sur les alias réels.
