# Déploiement privé ForgeBridge — D1 / R2 / Access

Phase 8 : voir le [rapport de stabilisation et récupération](docs/PHASE8_STABILIZATION.md).
Aucune nouvelle migration ; utiliser le runner contrôlé pour la D1 existante.
La préparation d’un export de restauration et le contrôle séparé des objets R2
sont décrits dans ce rapport. Les étapes de création ci-dessous sont historiques
et ne doivent pas être rejouées sur les ressources existantes.

Phase 5 : appliquer la migration additive 0007 via le contrôle existant avant
de publier le Worker correspondant. Voir [approbations internes et tests](docs/PHASE5_APPROVALS.md).

Avant de déployer la phase 4, suivre [les migrations contrôlées](docs/D1_AUTOMATION.md)
et [le rapport de phase 4](docs/PHASE4_COMMUNICATIONS.md). La migration additive
0006 doit suivre 0005 ; ne pas rejouer 0004 manuelle.

## Configuration active après raccordement manuel

Le propriétaire a confirmé le fonctionnement de l’interface privée à
`https://forgebridge-api.francbouch.workers.dev` et une réponse positive de
`/api/v1/health`. Ces observations ne remplacent pas un test de sauvegarde en ligne.
La D1 existante `forgebridge-db` est initialisée : ne pas la recréer ni rejouer
le script d’initialisation pour une base vide.

Le fichier Wrangler active maintenant `workers_dev: true`, garde les previews
fermées et déclare les deux origines de production. La politique Access existante
**All traffic** doit rester active ; elle est gérée séparément dans Cloudflare.
`keep_vars: true` conserve les variables du tableau de bord lors des déploiements.
Les variables explicitement déclarées dans `vars` restent pilotées par le dépôt.

Dans **Runtime variables and secrets → Production**, conserver `ACCESS_ISSUER`,
`ACCESS_AUD`, `ADMIN_EMAIL` (adresse vérifiée par Access) et `ADMIN_USER_ID`
(UUID stable). `ORIGIN_SHARED_SECRET` reste un secret identique côté Vercel et
Worker, jamais dans Git. Les variables de Builds ne configurent pas le Worker.
Pour développer localement, placer `APP_ORIGIN=http://localhost:5173` dans
`apps/api/.dev.vars` ignoré par Git, avec les autres paramètres locaux requis.

Vérification après chaque déploiement : `/api/v1/health`, `/api/v1/me`, puis
l’interface à la racine du Worker. Créer un projet de test, recharger et le modifier,
puis recharger à nouveau pour confirmer la persistance sur la D1 distante.
La route Vercel `/demo` contient uniquement des données fictives ; elle ne teste
pas la connexion D1. Ses fichiers `/assets/` sont publics. Les autres pages et
routes API restent protégées par le middleware.

Les instructions suivantes décrivent aussi l’installation initiale : les étapes
de création des ressources déjà présentes ne sont plus à effectuer.

## État initial et limites

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

Vérifier l’offre, les quotas gratuits et l’éventuelle activation de facturation R2 avant de confirmer. Ne pas créer de ressource payante sans décision explicite. Le bucket R2 est requis pour les originaux documentaires et les pièces jointes actuels. Désactiver tout domaine public/r2.dev et ne pas distribuer de clés S3.

Dans `apps/api/wrangler.jsonc`, ajouter le **vrai** `database_id` retourné à l’entrée `DB`. Le nom logique est `forgebridge-db`, le bucket privé `forgebridge-documents`, les bindings sont `DB` et `DOCUMENTS`. Aucun faux UUID n’est livré. Lors de la préparation initiale, garder le Worker fermé ; la configuration active ci-dessus utilise maintenant `workers_dev:true` derrière Access et `preview_urls:false`. Ne pas publier avant d’avoir choisi les valeurs Access et préparé la protection.

```sh
# Racine du dépôt, validation locale préalable
npm ci
python3 scripts/d1/migrate.py --apply
npm run typecheck
npm run lint
npm test
npm run build
npm run build:worker
# Racine du dépôt : inspection et réconciliation contrôlées, revue/sauvegarde requises pour 0009
python3 scripts/d1/migrate.py --remote --apply
```

Les migrations sont incrémentales et suivies par Wrangler. Ne pas utiliser de reset destructif. Si une ancienne base contient des données réelles, préparer séparément un export/import en lecture seule puis une validation sur une nouvelle D1 ; aucun import automatique n’est inclus.

## 2. Préparer le verrou Vercel avant d’y publier du contenu privé

Générer localement un secret aléatoire de 32 octets encodé base64url (au moins 43 caractères), le conserver dans un gestionnaire de secrets et le saisir via les paramètres sécurisés. Par exemple `openssl rand -base64 32` produit une valeur à protéger ; ne pas la committer, la publier ou la mettre dans une URL.

Définir **la même valeur** `ORIGIN_SHARED_SECRET` :

- dans Vercel, variable **serveur uniquement**, sur chaque environnement déployé (Preview et Production concernés) ;
- dans le Worker, via `wrangler secret put ORIGIN_SHARED_SECRET` ou le tableau de bord.

Aucune variable VITE n’est requise. Supprimer les anciennes variables `VITE_SUPABASE_*`, `SUPABASE_*` et `VITE_API_BASE_URL` de la configuration active ForgeBridge. Ne pas toucher aux variables d’un autre projet. `middleware.ts` protège les chemins privés Vercel (exceptions : `/demo`, ses sous-routes et `/assets/`) ; sans le secret, le site répond 503 ; sans preuve valide, 403. Ne pas ajouter d’exception `/index.html` ni aux routes API.

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

## Première base créée depuis le tableau de bord

Le propriétaire a créé `forgebridge-db`, UUID `eeafdf4e-7d5d-4ea2-8d1c-7984b749ecf3` ; cette valeur non secrète est maintenant dans Wrangler. La capture initiale indiquait zéro table. Aucun accès distant de l’agent n’est établi et aucune migration distante n’est déclarée exécutée.

Pour une **base encore vide uniquement**, `scripts/initialize-empty-d1.sql` permet une initialisation manuelle depuis Console : copier tout le fichier puis exécuter une seule fois. Ce baseline crée le schéma des migrations 0001/0002, sans compte/projet fictif, et enregistre les deux noms dans `d1_migrations` selon le format Wrangler. Les futures migrations CLI ne tenteront donc pas de recréer ces tables. Ne pas exécuter ce script sur une base déjà initialisée et ne pas le relancer après une erreur sans vérifier les tables existantes.

Le binding R2 est retiré de la configuration par défaut tant que le bucket dédié n’existe pas : aucun écran actuel ne l’utilise. Après création autorisée, ajouter `r2_buckets: [{binding: 'DOCUMENTS', bucket_name: 'forgebridge-documents'}]`.

### Collage dans la console D1

Le fichier `scripts/initialize-empty-d1.sql` est sans commentaires SQL pour supporter la console web qui peut regrouper les lignes du collage. Si elle affiche « No SQL statements detected », vérifier d’abord les tables avec `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;`. Appliquer le baseline uniquement si cette requête ne retourne aucune table applicative. Si des tables existent ou si une autre erreur apparaît, diagnostiquer avant de relancer ; ne supprimer aucune table.

## Phase 6 — traduction

Appliquer la migration additive `0008_integrated_translations.sql` avec le contrôle D1 existant avant publication du Worker. Les traductions restent désactivées sans secret serveur `DEEPL_API_KEY` et variable `TRANSLATION_ENABLED=true`. Aucun service payant n’est activé. Voir [la configuration, les limites et les tests de phase 6](docs/PHASE6_TRANSLATIONS.md).

## Phase 7 — activation contrôlée des comptes

Conserver `MULTIUSER_ENABLED` absent ou `false` avant la revue. Le code garde le
fonctionnement administrateur de phase 6 même avant migration 0009. Le contrôle
refuse l’application distante de `0009_secure_collaboration.sql` sans
`PHASE7_SECURITY_REVIEWED=true` et `PHASE7_BACKUP_PROOF` (SHA-256 de l’export restauré
et vérifié), transmis depuis les variables du dépôt. Ces valeurs ne remplacent
pas la vérification de la sauvegarde, du compte initial, des politiques Access et
de la confidentialité R2.

Après succès de migration/déploiement et validation de ces prérequis, activer
`MULTIUSER_ENABLED=true` sur le Worker. `RESEND_API_KEY` et `INVITATION_FROM` sont
facultatifs pour l’envoi réel ; sans eux aucun courriel d’invitation n’est annoncé
comme envoyé. Garder les secrets hors du navigateur. Le propriétaire conserve la
fusion et l’activation. Voir la [procédure complète, tests et retour arrière](docs/PHASE7_SECURITY.md).
