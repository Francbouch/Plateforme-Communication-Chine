# Connexion par courriel — activation progressive

## Audit et choix

La phase 7 fournit déjà les profils stables, appartenances organisation/projet,
entreprises fournisseurs, invitations, révocations et contrôles des révisions.
L'identité provient jusqu'ici exclusivement de Cloudflare Access (JWT signé,
issuer/audience exacts). Ce n'est pas une connexion native de ForgeBridge.
Les projets, rôles, liens Access, documents et objets R2 sont réutilisés.
Aucun service Supabase n'est ajouté.

Better Auth **1.7.23**, son adaptateur D1 officiel intégré et le plugin Email OTP
fonctionnent dans les tests Workerd avec la vraie API D1. Le Worker requiert
`nodejs_compat`. Les courriels passent par l'API HTTPS Resend, compatible avec
`fetch` Workers, déjà utilisée pour les invitations. Aucun serveur Node séparé,
OAuth tiers ou bibliothèque d'authentification artisanale n'est nécessaire.

Références : [Email OTP](https://www.better-auth.com/docs/plugins/email-otp),
[Cloudflare](https://www.better-auth.com/docs/guides/cloudflare),
[Resend](https://resend.com/docs/api-reference/emails/send-email).
La compatibilité a été vérifiée avec la version installée, pas seulement supposée
à partir de ces pages.

## Protections

- Code de **8 chiffres**, valable **5 minutes**, **5 tentatives**. Le renvoi
  remplace le code précédent. Consommation atomique : une seule connexion réussit
  avec deux présentations concurrentes. Stockage HMAC-SHA256 avec secret serveur.
- Inscription publique fermée. Seul un compte explicitement approuvé ou une
  invitation encore valide peut recevoir un code. Un courriel identique à celui
  d'un ancien profil ne suffit jamais à le rattacher.
- Réponse générique d'envoi pour les adresses inconnues et les erreurs de livraison ;
  événement `email.delivery_failed` sans code ni secret. Cela ne garantit pas une
  indistinguabilité parfaite des temps de réponse. Surveiller les événements et
  le tableau de bord Resend pour les rejets et rebonds.
- Quotas D1 atomiques, fenêtres fixes : ensemble des requêtes auth 300/minute et
  2 000/heure ; IP 30/minute et 200/heure ; courriel 15/15 minutes ; envoi par
  courriel 1/minute, 3/15 minutes et 10/jour ; envoi par IP 20/heure ; ensemble des
  codes éligibles 100/jour. Le SDK limite aussi à 30/minute. Pas de dépendance à un
  CAPTCHA externe ; les limites peuvent refuser momentanément un réseau partagé.
- Session de **7 jours fixes**, sans renouvellement automatique ni cache de
  session : D1 est consultée à chaque authentification. Cookie HTTPS
  `__Secure-forgebridge.session_token`, Secure, HttpOnly, SameSite=Lax, host-only,
  chemin `/`. HTTP sans Secure est réservé aux tests sur loopback.
- Aucun jeton de session dans le JSON de connexion, le stockage local ou le code
  React. Les jetons opaques en base et les sauvegardes restent des secrets.
  Déconnexion et révocation suppriment les sessions D1 ; une copie du cookie
  cesse d'autoriser les requêtes suivantes.
- Toutes les API privées et tous les téléchargements R2 conservent leurs gardes
  serveur : profil actif, organisation, projet, rôle et partage de **révision
  exacte**. Une invitation ne donne pas accès à toutes les révisions ou aux notes
  internes. Aucune URL publique R2 n'est créée.
- Les mutations exigent l'Origin exact, y compris connexion et récupération.
  Les routes SDK inutilisées (inscription, changement de courriel, introspection,
  mot de passe, etc.) ne sont pas exposées. La page de connexion et les ressources
  génériques deviennent publiques uniquement lorsque le mode natif est actif.
  Le middleware de protection de l'origine Vercel demeure en place.

## Configuration externe à préparer

Ne jamais mettre les valeurs secrètes dans Git, dans une capture ou dans le chat.

| Variable                       | Emplacement et fonction                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`           | Secret Worker aléatoire, au moins 43 caractères ; par exemple généré avec `openssl rand -base64 48`. Ne pas réutiliser le secret d'origine.                                        |
| `RESEND_API_KEY`               | Secret Worker ; clé Resend autorisée à envoyer depuis le domaine vérifié.                                                                                                          |
| `AUTH_FROM`                    | Variable Worker ; expéditeur validé par Resend. `INVITATION_FROM` reste prioritaire pour les invitations, sinon `AUTH_FROM` est utilisé.                                           |
| `EMAIL_AUTH_ENABLED`           | Variable Worker : absent/`off` conserve Access ; `staging` ouvre le test protégé ; `true` exige aussi l'activation en base.                                                        |
| `RECOVERY_ACCESS_AUD`          | Variable Worker ; audience d'une **seconde application Access**, dédiée à `/recovery` et `/recovery/*`, réservée à l'administrateur avec MFA.                                      |
| `EMAIL_AUTH_SECURITY_REVIEWED` | Variable GitHub Actions **et** variable Worker, `true` uniquement après revue effective.                                                                                           |
| `EMAIL_AUTH_BACKUP_PROOF`      | Variable GitHub Actions **et** variable Worker ; SHA-256 hexadécimal de 64 caractères du manifeste privé de sauvegarde/restauration vérifié. Ce champ n'exécute pas la sauvegarde. |

Conserver `APP_ORIGIN` (origine HTTPS canonique sans slash final), `ADMIN_EMAIL`,
`ADMIN_USER_ID`, `ACCESS_ISSUER`, **l'ancien `ACCESS_AUD`**, et les secrets de
passerelle Vercel existants. `MULTIUSER_ENABLED=true` et la phase 7 sont requis.
Les nouvelles variables ne sont pas préremplies dans Wrangler : le déploiement
du code seul ne doit pas activer une nouvelle méthode de connexion.
Les secrets GitHub ne deviennent pas automatiquement des secrets Worker.

## Migration et rattachement sans perte

`0010_email_auth.sql` ajoute uniquement les tables `email_auth_*`. Aucun projet,
profil, lien Access ou objet R2 historique n'est supprimé ou réassigné.
Le lien natif vers `profiles.id` est distinct du lien Access, unique et protégé
contre les modifications. Les appartenances existantes restent la source des
permissions. Un ancien courriel NULL n'est renseigné qu'après approbation
explicite puis preuve de possession par OTP.

1. Vérifier que la connexion Access administrateur fonctionne, noter l'UUID
   `ADMIN_USER_ID` existant et vérifier qu'il possède bien les organisations des
   anciens projets. Ne jamais générer un nouvel UUID pour contourner un conflit.
2. Effectuer une sauvegarde privée D1 et une copie R2 avec manifeste/checksums.
   Tester la restauration dans des ressources **séparées** selon
   [la procédure de phase 8](PHASE8_STABILIZATION.md). Vérifier comptes, droits,
   FK et fichiers. Ne pas exposer les exports dans les artefacts GitHub.
3. Revoir le code et la procédure de récupération. Renseigner les deux variables
   de revue/sauvegarde GitHub seulement après ces vérifications. Exécuter le
   runner de migration habituel, en conservant l'authentification native OFF.
   Les gardes `PHASE7_*` restent nécessaires si 0009 manque encore.
4. Configurer les secrets Worker et l'expéditeur Resend. Garder la protection
   Access actuelle de tout le domaine et passer en `staging`. Depuis la page
   Administration, connecté par **Access**, autoriser son propre courriel.
   Cela enregistre l'approbation pour l'UUID actuel, sans changer ses rôles.
5. Tester `/login` et le code réellement reçu. Vérifier le même UUID et les
   anciens projets après rechargement. Approuver séparément les anciens membres
   avec leur UUID/courriel vérifiés ; les nouveaux fournisseurs utilisent les
   invitations, puis leur acceptation conserve les portées prévues.
6. Créer l'application Access distincte de récupération, configurer son audience
   dans `RECOVERY_ACCESS_AUD`, ouvrir `/recovery`, puis cliquer **Confirmer le
   fonctionnement de la récupération**. Une simple visite GET ne suffit pas.
   Vérifier qu'un cookie natif seul n'autorise jamais cette page. Vérifier les
   actions de révocation et désactivation, puis réouvrir le test protégé si besoin.
7. Après revue, renseigner les preuves dans le Worker, passer le mode à `true`
   et activer depuis `/recovery`. Le serveur exige une connexion administrateur
   native déjà réussie, une session encore valable, et la récupération vérifiée.
   Tant que ces conditions manquent, il conserve le chemin Access historique.
8. **Seulement après validation réelle**, ajuster la politique Access des chemins
   ordinaires pour rendre `/login` accessible aux fournisseurs. Conserver
   `/recovery*` derrière sa propre application stricte. Conserver la configuration
   de l'ancienne application pour le retour arrière. Si le domaine actuel ne
   permet pas cette séparation de chemins Access, préparer un domaine personnalisé
   et valider la récupération sur celui-ci avant toute ouverture. Une règle Access protégeant
   encore tout le domaine empêcherait la connexion native des fournisseurs.
   Vérifier alors connexion admin, refus anonymes API/R2 et comptes fournisseurs
   réellement limités aux projets/révisions partagés avant ouverture générale.

La procédure ne valide pas les réglages Cloudflare/Resend à votre place. Ne pas
ouvrir l'accès externe tant que ces essais et le retour arrière ne sont pas faits.
L'interface de rattachement initial refuse l'auto-approbation par session native.
Une divergence de propriété ou de courriel bloque : l'auditer, sans réattribuer
silencieusement les anciens projets.

## Récupération et retour arrière

Avec l'identité Access indépendante sur `/recovery` : révoquer ses sessions
natives, désactiver l'authentification native, remettre `EMAIL_AUTH_ENABLED=off`
et la politique Access initiale sur le domaine. Les liens, projets et fichiers
restent intacts. En mode staging, l'action de reprise réouvre seulement le test
protégé. Ne pas désactiver le profil administrateur pour tester la récupération.

Conserver hors ligne les accès du compte Cloudflare, les méthodes MFA de secours
et la configuration Access initiale. Une rotation du secret Better Auth invalide
les cookies et codes, mais ne remplace pas cette récupération indépendante.
Aucun reset D1/R2 n'est une étape de récupération.

## Ordre avant déploiement

Voir [D1_AUTOMATION.md](D1_AUTOMATION.md). La PR ne migre pas la production.
Après fusion, le job distant **bloque volontairement 0010** si les preuves de
revue/sauvegarde sont absentes ; ce refus n'est pas une invitation à contourner
la garde. Une exécution explicitement autorisée avec `deploy_worker=true` ne
publie qu'après validation/migration du même SHA. Les autres systèmes de build
Cloudflare doivent utiliser ce même garde ou attendre ce chemin unique.
La fusion seule n'active pas les courriels et ne valide pas la récupération.

## Chine et exploitation

La connexion utilise le domaine de ForgeBridge et des courriels : aucun Google,
OAuth social, CAPTCHA ou CDN supplémentaire côté navigateur. Resend est appelé
côté Worker, pas depuis la Chine par le navigateur. Cela réduit les dépendances
client, sans garantir l'accessibilité effective de Cloudflare ou la livraison
chez QQ/163. Vérifier domaine personnalisé, DNS SPF/DKIM/DMARC, rebonds et essais
réels avec les fournisseurs en Chine avant ouverture. Aucun test de livraison
réelle ou de réseau chinois n'a été effectué dans l'environnement local.

Les tables de quotas conservent des fenêtres expirées ; prévoir une rétention
bornée et revue pour ces seules nouvelles données techniques. Les quotas du
plan Resend restent applicables, indépendamment des limites du Worker.

## Validation reproductible

`npm run verify` inclut TypeScript, ESLint, Vitest, builds web/Worker et les trois
suites Playwright. `tests/email-auth.test.ts` vérifie l'adaptateur officiel dans
Workerd/D1 ; `tests/email-access.test.ts` couvre OTP, concurrence, invitations,
anciens UUID, refus, expiration, révocation et isolation R2. Les trois parcours
`tests/browser-email` utilisent l'interface compilée, un vrai OTP/session SDK et
une livraison simulée : admin/récupération, fournisseur/révisions/messages,
lecteur/déconnexion. Les réponses API 5xx font échouer ces parcours.

`python3 -m unittest discover -s scripts/d1 -p 'test_*.py' -v` vérifie aussi le
refus distant avant écriture sans revue. `python3 scripts/d1/integration.py`
applique 0004 manuelle puis les migrations manquantes sur une D1 temporaire,
vérifie l'idempotence, exporte/restaure dans une autre base, puis contrôle les
sentinelles historiques et l'immutabilité des nouveaux liens d'identité.
Tous les tests écrivent exclusivement dans D1/R2 locaux isolés. Ils ne prouvent
ni l'état des sauvegardes réelles, ni la configuration des fournisseurs externes.

Validation locale du 13 novembre 2026 : `npm run verify` réussi, **134 tests
Vitest** dans 13 fichiers et **30 tests Playwright** (4 preview, 23 privés,
3 natifs). **17 tests Python** réussis et scénario Wrangler de migration/
restauration réussi. Builds web/Worker réussis ; audit des dépendances de
production : **0 vulnérabilité**. Aucune migration ou activation distante.
