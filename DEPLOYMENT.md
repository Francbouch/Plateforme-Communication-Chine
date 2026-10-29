# Déploiement privé ForgeBridge — D1 / R2 / Access

## État et limites

Aucun service distant n’a été créé ou publié pendant cette migration. `wrangler whoami` ne trouvait aucune session Cloudflare ; aucun token Cloudflare/Vercel n’était configuré. Les identifiants de compte, UUID D1, domaines et AUD ne sont pas inventés. Le code est testé localement, pas en production. Ne pas utiliser de ressource du configurateur 3D.

Le point d’entrée **final** sera un domaine Cloudflare Access privé, pas l’URL Vercel directe. Le Worker traite `/api/*` avec D1 et relaie les autres chemins au frontend Vercel. Le middleware Vercel bloque l’origine directe. Ne pas déclarer l’application privée avant les vérifications négatives ci-dessous.

## 1. Créer uniquement les ressources ForgeBridge manquantes

Depuis une machine autorisée, connecter Wrangler à **votre compte** via le mécanisme habituel (`wrangler login`) ou un token sécurisé limité à Workers/D1/R2 de ce compte. Ne pas coller de token dans le chat. Vérifier les noms/IDs des ressources avant création ; réutiliser uniquement une ressource confirmée ForgeBridge.

```sh
cd apps/api
npx wrangler d1 list
npx wrangler r2 bucket list
# Seulement si ces ressources ForgeBridge n’existent pas :
npx wrangler d1 create forgebridge-db
npx wrangler r2 bucket create forgebridge-documents
```

Vérifier l’offre, les quotas gratuits et l’éventuelle activation de facturation R2 avant de confirmer. Ne pas créer de ressource payante sans décision explicite. Aucun bucket R2 n’est requis pour les écrans actuels ; le binding prépare la suite. Désactiver tout domaine public/r2.dev et ne pas distribuer de clés S3.

Dans `apps/api/wrangler.jsonc`, ajouter le **vrai** `database_id` retourné à l’entrée `DB`. Le nom logique est `forgebridge-db`, le bucket privé `forgebridge-documents`, les bindings sont `DB` et `DOCUMENTS`. Aucun faux UUID n’est livré. Préserver `workers_dev:false` et `preview_urls:false`. Ne pas publier avant d’avoir choisi les valeurs Access et préparé la protection.

```sh
# Racine du dépôt, validation locale préalable
npm ci
npm run db:migrate
npm run typecheck
npm run lint
npm test
npm run build
npm run build:worker
# apps/api : appliquer seulement à la nouvelle D1 ForgeBridge vérifiée
cd apps/api
npx wrangler d1 migrations apply forgebridge-db --remote
```

Les migrations sont incrémentales et suivies par Wrangler. Ne pas utiliser de reset destructif. Si une ancienne base contient des données réelles, préparer séparément un export/import en lecture seule puis une validation sur une nouvelle D1 ; aucun import automatique n’est inclus.

## 2. Préparer le verrou Vercel avant d’y publier du contenu privé

Générer localement un secret aléatoire de 32 octets encodé base64url (au moins 43 caractères), le conserver dans un gestionnaire de secrets et le saisir via les paramètres sécurisés. Par exemple `openssl rand -base64 32` produit une valeur à protéger ; ne pas la committer, la publier ou la mettre dans une URL.

Définir **la même valeur** `ORIGIN_SHARED_SECRET` :

- dans Vercel, variable **serveur uniquement**, sur chaque environnement déployé (Preview et Production concernés) ;
- dans le Worker, via `wrangler secret put ORIGIN_SHARED_SECRET` ou le tableau de bord.

Aucune variable VITE n’est requise. Supprimer les anciennes variables `VITE_SUPABASE_*`, `SUPABASE_*` et `VITE_API_BASE_URL` de la configuration active ForgeBridge. Ne pas toucher aux variables d’un autre projet. `middleware.ts` protège tous les chemins Vercel ; sans le secret, le site répond 503 ; sans preuve valide, 403. Ne pas ajouter d’exception `/assets` ou `/index.html`.

Suivre VERCEL.md pour publier un aperçu **protégé**, après autorisation. Récupérer son hôte HTTPS canonique sans redirection. L’URL directe doit rester interdite à un navigateur anonyme. Si la protection Vercel native empêche aussi les appels de passerelle, ne pas contourner le verrou : ajuster cette protection selon les capacités de l’offre tout en conservant et testant le middleware d’origine. Ne payer aucun supplément automatiquement.

## 3. Créer la politique Cloudflare Access avant de rendre la route accessible

Sur une zone/domaine que vous contrôlez dans le compte ForgeBridge, choisir un sous-domaine réservé (aucun domaine n’est supposé existant).

1. Zero Trust → Access controls → Applications → Add application → **Self-hosted**.
2. Protéger **tout le hostname**, sans chemin partiel ni règle Bypass. Politique **Allow** limitée à votre courriel exact. Utiliser un IdP approprié ou le code à usage unique Access ; configurer MFA de l’IdP si disponible et une session courte (15 min recommandées). Aucun fournisseur dans la politique actuelle.
3. Copier l’**Application Audience (AUD) Tag** dans les paramètres de l’application et relever votre domaine d’équipe `https://<équipe>.cloudflareaccess.com`.
4. Définir ces valeurs dans les variables **Worker**, pas dans React :

| Variable Worker        | Valeur                                                                  |
| ---------------------- | ----------------------------------------------------------------------- |
| `ACCESS_ISSUER`        | URL HTTPS exacte du domaine d’équipe, sans slash final                  |
| `ACCESS_AUD`           | AUD réel de cette application Access                                    |
| `ADMIN_EMAIL`          | Votre courriel autorisé exact                                           |
| `ADMIN_USER_ID`        | UUID généré une seule fois, p. ex. `crypto.randomUUID()`, puis conservé |
| `ADMIN_NAME`           | Votre nom d’affichage (optionnel)                                       |
| `APP_ORIGIN`           | Origine HTTPS exacte du sous-domaine privé, sans chemin/slash final     |
| `VERCEL_ORIGIN`        | Origine HTTPS canonique du déploiement frontend protégé, sans chemin    |
| `ORIGIN_SHARED_SECRET` | Secret Worker identique à Vercel ; saisie sécurisée                     |

`ADMIN_USER_ID` n’est pas un mot de passe et ne donne aucun accès par lui-même. Le vrai sujet Access est lié à cet ID après validation. Aucun profil/fournisseur fictif n’est activé. Un profil suspendu n’est jamais réactivé par le bootstrap.

## 4. Publier uniquement le Worker protégé, après autorisation

Ajouter à Wrangler un **Custom Domain** correspondant au hostname protégé :

```json
"routes": [{ "pattern": "VOTRE_HOSTNAME_PRIVE_REEL", "custom_domain": true }]
```

Remplacer le placeholder par votre domaine réel ; ne pas copier ce texte tel quel. Vérifier d’abord la politique Access et les variables. Préserver les alias workers.dev/preview désactivés. Définir les variables non secrètes dans la configuration de l’environnement choisi, et le secret via saisie sécurisée.

```sh
cd apps/api
npx wrangler deploy
```

Cette commande n’a **pas** été exécutée par l’agent. Après publication autorisée, ouvrir le domaine privé : Access effectue la connexion puis le Worker valide le JWT et sert le frontend. Dans Administration, créer l’organisation, les projets et les fournisseurs. Les données restent en D1 après rafraîchissement. Les invitations sont préparatoires ; les comptes fournisseurs restent désactivés.

## 5. Vérifications indispensables du déploiement réel

- Incognito : hostname privé et `/api/v1/me` imposent Access. Sans session, aucun projet ni HTML applicatif ne doit être livré.
- Courriel non autorisé : refus par Access et par l’allowlist serveur.
- Appel Worker sans JWT ou avec `Cf-Access-Jwt-Assertion: forged` : refus ; tester aussi les alias s’ils existent.
- Appels directs à **tous** les alias Vercel, HTML et `/assets/...` sans secret : 403/503 ; aucune page du dashboard ni JS applicatif.
- JWT erroné/expiré, AUD ou issuer incorrect : refus. CORS ne doit pas autoriser un domaine tiers. Les prévols peuvent répondre 204 sans livrer de données.
- Après connexion réelle : santé API protégée, organisation, création/modification projet et rechargement, fournisseurs/notes, préférences et audit.
- Suspendre un compte de test et vérifier le refus avec un ancien JWT ; rétablir seulement selon la procédure administrateur autorisée.
- Vérifier absence de clés dans le bundle et dans Chrome Network, pas de cookie/JWT transféré à Vercel, pas de redirection d’origine, quotas et journaux sans secrets.

Tant que ces vérifications distantes ne sont pas réalisées, l’intégration est **préparée**, pas déclarée privée/opérationnelle en production. Préparer export/Time Travel et test de restauration avant les documents confidentiels. La gestion documentaire R2 n’est pas activée par ce déploiement.

## Réseau de l’environnement cloud

Pour automatiser depuis cet environnement, les accès Cloudflare/Vercel doivent être fournis par connexion sécurisée et les domaines réellement nécessaires autorisés (API Cloudflare, API Vercel, domaine d’équipe Access pour JWKS). Ne pas remplacer l’allowlist inconnue ni désactiver le proxy/TLS. L’absence d’un token Cloudflare a été confirmée par `wrangler whoami`, pas déduite seulement de variables absentes. Git HTTPS fonctionne ; l’API GitHub peut nécessiter `api.github.com` pour créer la PR.
