# Sécurité — mode développeur privé

## Défense en profondeur

1. Cloudflare Access protège **tout le domaine**, sans règle Bypass et avec une politique Allow limitée au courriel réel de l’administrateur. Le mécanisme de connexion est externe à ForgeBridge (IdP ou code Access). Définir une durée de session courte et MFA dans l’IdP lorsque disponible.
2. Le Worker valide lui-même `Cf-Access-Jwt-Assertion` avec jose : signature RS256, JWKS uniquement sur le domaine Access configuré, issuer HTTPS exact, AUD exact, `exp`, `iat`, `sub`, email et token applicatif `type=app`. Il ne fait confiance ni à `Cf-Access-Authenticated-User-Email` seul ni à un identifiant transmis par React. Aucune route santé, asset ou métier n’est publique. Le prévol OPTIONS ne renvoie que des métadonnées CORS, jamais des données.
3. Le courriel autorisé et l’UUID interne stable sont configurés côté serveur. Le lien avec le vrai sujet Access est persistant ; il n’est pas remplacé silencieusement. Le statut actif est relu en D1. Aucun `DEV_MODE=true` ne désactive les vérifications.
4. Vercel applique `middleware.ts` à tous les chemins et exige `ORIGIN_SHARED_SECRET` (au moins 32 octets aléatoires encodés base64url). Une comparaison des empreintes de taille fixe évite la comparaison naïve. Ce secret n’est connu que du Worker et de l’environnement serveur Vercel, jamais du bundle, d’une URL ou du navigateur. Le middleware refuse 503 s’il manque et 403 si la preuve est absente/fausse.
5. Le Worker ne conserve pas de réponse dans un cache public, ne transmet pas les cookies/JWT Access vers Vercel, ne suit pas les redirects avec le secret et retire les cookies de réponse. Il impose une CSP same-origin ; aucun service tiers ni ancienne connexion Supabase n’est nécessaire.

`workers_dev:false` et `preview_urls:false` limitent les alias d’accès ; toute route oubliée reste soumise à la validation JWT. Protéger tous les alias Vercel avec le middleware et vérifier ces refus à distance avant de charger des données confidentielles. La configuration locale n’établit pas que Cloudflare Access est actif en production.

## Autorisations et persistance

Chaque lecture/écriture vérifie l’état du profil, l’organisation et le rôle. Les projets exigent propriétaire ou appartenance individuelle ; les fournisseurs exigent aussi leur entreprise active et son association au projet. Les mutations sont paramétrées et portent leurs gardes d’autorisation dans la transaction D1. Aucune API SQL publique ou clé D1/R2 n’est fournie au navigateur. Les notes fournisseurs restent réservées au propriétaire ; l’outbox n’a pas de route de lecture.

CORS ne permet que `APP_ORIGIN`, sans wildcard et sans cookie cross-site. Les mutations exigent Origin exact. Avec la passerelle, les appels sont same-origin et les cookies Access sont gérés par Cloudflare ; ForgeBridge ne lit pas ces cookies dans React. La validation serveur du JWT protège aussi les accès directs au Worker. Le corps API est limité à 32 KiB ; le quota configuré est 60 requêtes/minute/utilisateur (approximation distribuée Cloudflare). Les listes sont plafonnées à 200 entrées.

React échappe le contenu ; aucune injection HTML. Erreurs API sans SQL, logs limités à identifiant/classe d’erreur. Pas de mot de passe applicatif, aucune clé d’admin frontend. Les secrets locaux, `.vercel`, dépendances et builds sont ignorés par Git.

## Révocation et restauration

Désactiver le profil administrateur en D1 bloque la requête suivante même avec un JWT encore valable : `UPDATE profiles SET status='suspended' WHERE id=...` via console D1 autorisée avec un paramètre/identifiant vérifié. Les changements d’appartenance bloquent les portées concernées à la prochaine requête. La révocation Access seule peut laisser un JWT déjà émis valable jusqu’à expiration ; utiliser session courte et désactivation D1 pour urgence.

Pour un changement légitime de sujet Access, sauvegarder puis modifier explicitement la ligne `identity_links` correspondante avec l’identité vérifiée ; ne pas supprimer tous les profils ni recréer les droits. Rotation du secret d’origine : coordonner Vercel et Worker, confirmer le refus de l’ancien secret, ne jamais le consigner dans le chat.

Configurer Time Travel D1 selon l’offre et vérifier la rétention disponible. Exporter périodiquement la base et stocker l’export de manière chiffrée avec accès restreint. Tester une restauration dans une **nouvelle base de récupération**, vérifier FK, comptes, permissions et audit avant toute bascule décidée. Ne pas restaurer sur une base d’un autre projet. Les sauvegardes SQL ne sauvegardent pas R2 : prévoir un manifeste et une copie indépendante des objets, avec vérification SHA-256. RPO/RTO à convenir avant usage réel.

## Fichiers futurs

R2 privé par binding uniquement, pas de r2.dev ou de domaine public. Clés opaques scoped et actifs immuables, uploads en quarantaine, vérification de signature réelle, taille/checksum et antivirus avant diffusion. Aucun endpoint de fichier n’est activé dans cette migration ; le pipeline documentaire reste à construire. Ne jamais exécuter de CAO non fiable, et isoler les transformations PDF avec ressources limitées.
