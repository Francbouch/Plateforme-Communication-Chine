# Phase 7 — identités, invitations et collaboration contrôlée

## Diagnostic initial et périmètre

Audit réalisé sur `main` ac7af99, après fusion de la phase 6 (PR nº 13). Les routes
Hono de `index`, `documents`, `review`, `messages`, `approvals` et `translations`,
les bindings, le stockage, la passerelle Vercel et les migrations 0001–0008 ont été
examinés. La liste des points d’entrée inspectés couvrait lectures, recherches,
statistiques, mutations, téléchargements, fichiers temporaires et traductions.

Avant cette phase :

- Toutes les routes Worker, y compris HTML, assets et health, vérifiaient un JWT
  Cloudflare Access signé, l’émetteur, l’audience, l’expiration et le type `app`.
  Aucun endpoint industriel public ni mot de passe local n’était présent.
- L’identité applicative était limitée au couple `ADMIN_EMAIL` / `ADMIN_USER_ID`
  configuré côté serveur. Aucun premier visiteur ne devenait administrateur.
- D1 possédait déjà profils, identités, organisations, appartenances, fournisseurs,
  invitations préparatoires, audit et permissions de projet partielles. Les anciens
  liens d’invitation étaient délibérément non acceptables.
- Les documents R2 étaient servis par le Worker après contrôle de projet ; aucune
  URL publique ou présignée de bucket n’était fabriquée. Le caractère réellement
  privé du bucket dans le tableau de bord ne peut pas être confirmé sans cet accès.
- Plusieurs fonctions de revue, messagerie et approbation supposaient un
  administrateur interne. Donner simplement une session à un fournisseur aurait
  été insuffisant : listes, historiques et références nécessitaient un périmètre
  supplémentaire, distinct du droit de voir le projet.

L’architecture retenue conserve ces modèles, documents, révisions et protections.
Les lectures de collaboration sont filtrées côté serveur dans `/collaboration` ;
les écritures compatibles réutilisent les routes métier existantes après une
liste d’autorisations explicite. Une route historique non examinée n’est jamais
ouverte globalement aux nouveaux utilisateurs.

## Solution d’authentification

| Option examinée                                    | Intérêt et limites                                                                                                                                                                                                                                                           | Choix                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Cloudflare Access existant                         | JWT RS256/JWKS déjà vérifiés dans le Worker, session gérée par le fournisseur, OTP ou IdP, possibilité de MFA via l’IdP et les politiques. Pas de migration des identités ni de mot de passe applicatif. Le coût des sièges dépend du plan réel du compte, non inspecté ici. | Conservé.                        |
| Auth0 / fournisseur OIDC distinct                  | Identité et sessions éprouvées, mais nouvelle application IdP, secrets, configuration et migration de session. Prix et quotas du compte non vérifiés ; aucune offre activée.                                                                                                 | Non nécessaire pour cette phase. |
| Système local de mots de passe / ajout de Supabase | Réinitialisation, stockage de secrets et sessions supplémentaires, sans justification dans l’architecture actuelle.                                                                                                                                                          | Non introduit.                   |

Documentation officielle consultée le 30 octobre 2026 :

- [Jeton applicatif et courriel vérifié Access](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token.mdx).
- [Sessions, expiration, révocation et déconnexion](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/access-controls/access-settings/session-management.mdx).
- [OTP vers les adresses autorisées par la politique](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/integrations/identity-providers/one-time-pin.mdx).
- [IdP OIDC](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/integrations/identity-providers/generic-oidc.mdx).
- [Limites du compte Zero Trust](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/cloudflare-one/account-limits.mdx).
- [API Auth0 officielle](https://github.com/auth0/node-auth0), option de comparaison non intégrée.
- [SDK et exemples officiels Resend](https://github.com/resend/resend-node), transport d’invitation préparé sans dépendance SDK.

Aucun abonnement ni nouvelle facturation n’a été activé. Aucun tarif de siège ou
quota gratuit Resend n’est supposé. Vérifier les plans et conditions du compte avant
l’ajout d’utilisateurs ou l’activation de l’envoi. Un OTP courriel n’est pas, à lui
seul, une preuve de MFA : si le MFA est requis, configurer l’IdP et sa politique.

## Identités et sessions

Le navigateur ne choisit ni son identifiant utilisateur ni celui du décideur. Le
serveur résout la paire émetteur/sujet vérifiée vers `identity_links`. Le compte
initial conserve son UUID et ses appartenances existantes ; son courriel et son
sujet ne sont pas remplacés par une première connexion publique. Même en mode
collaboratif, une configuration administrateur absente bloque la connexion.

Une nouvelle identité non administratrice n’est provisionnée qu’avec une invitation
active correspondant au courriel certifié par Access. La création de profil
n’accorde aucun projet : l’acceptation du jeton reste indispensable. Un courriel
existant ne peut pas être rattaché silencieusement à un autre sujet IdP. Un tel
changement exige une revue d’identité séparée par l’administrateur.

Access garde la gestion des cookies de session et de la connexion. Vérifier dans
sa configuration les cookies Secure/HttpOnly, le SameSite approprié et la durée de
session. Le Worker vérifie la signature, les claims et le profil actif à chaque
requête ; aucun JWT ni secret de service n’est stocké dans le navigateur applicatif.
Les mutations exigent l’origine exacte et CORS reste limité à `APP_ORIGIN`.
Le rate limiter existant est conservé ; l’authentification OTP/IdP et ses tentatives
relèvent également des protections du fournisseur, à confirmer dans sa politique.

En mode multiutilisateur actif, D1 enregistre seulement une empreinte du JWT pour
les sessions observées/révoquées. Déconnexion : POST protégé, révocation locale du
jeton puis navigation vers `/cdn-cgi/access/logout`. La documentation Access décrit
un délai de 20–30 secondes pour sa révocation globale ; le refus applicatif D1 du
jeton déconnecté est immédiat aux requêtes suivantes. L’administrateur peut aussi
invalider les sessions d’un membre par une date minimale d’émission. Reconnexion
nécessaire avec un jeton plus récent. Ces opérations ne suspendent pas l’IdP lui-même.

Les pages HTML refusées affichent seulement une page fixe de reconnexion, sans
contenu industriel. Un jeton révoqué ne reçoit ni les données ni les fichiers.
La révocation ne peut pas effacer un fichier déjà téléchargé ou des octets déjà
reçus par le navigateur : il ne s’agit pas d’un dispositif DRM.

## Rôles et autorisations

Les rôles réutilisent les valeurs existantes : propriétaire initial (`owner`),
administrateur de projet (`project_admin`), collaborateur interne (`designer`),
fournisseur (`supplier_engineer`) et lecteur (`reviewer`). L’invitation n’attribue
jamais le rôle propriétaire. L’organisation et les projets de chaque appartenance
restent vérifiés ; plusieurs organisations sont possibles.

| Rôle                     | Valeurs par défaut                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Propriétaire initial     | Administration de ses organisations, invitations, partages et paramètres ; aucun droit sur une autre organisation sans appartenance.                                                                                                                                                       |
| Administrateur de projet | Collaborateur interne sur les projets assignés et gestion des membres de ces projets ; aucune promotion de lui-même, des autres administrateurs ou vers propriétaire.                                                                                                                      |
| Collaborateur interne    | Documents et échanges internes de ses projets, ajout de documents/révisions, annotations, points, réponses et demandes. Décision d’approbation non accordée par défaut.                                                                                                                    |
| Fournisseur              | Projet explicitement activé, documents/révisions partagés, points publiés, conversations partagées et messages partagés ; réponses et participation autorisées. Pas d’ajout de fichiers, d’annotation, de création de points/demandes, d’approbation ou de gestion des membres par défaut. |
| Lecteur                  | Vue limitée aux contenus partagés, téléchargement et traduction autorisés ; aucune modification, correction de traduction ou décision.                                                                                                                                                     |

Seize permissions explicites par projet couvrent projet, documents, téléchargement,
ajout de documents/révisions, annotation, création/réponse aux points, lecture et
participation aux conversations, demandes, lecture/décision d’approbation, gestion
des membres et traduction/correction. Un lecteur ne peut pas recevoir de permission
d’écriture par simple surcharge JSON ; un fournisseur ne peut pas gérer les membres.
Les utilisateurs ne modifient jamais leurs propres permissions.

Les anciennes appartenances de projet restent présentes mais `access_enabled=0`
par défaut. Elles ne deviennent donc pas actives rétroactivement. Une acceptation
d’invitation ou un enregistrement explicite par l’administrateur active le périmètre
concerné. Les modifications sont versionnées, revérifiées côté serveur et auditées.
Toute modification de permissions invalide les invitations encore en attente pour
ce membre et ce projet, afin qu’un ancien jeton ne rétablisse pas d’anciens droits.

### Visibilité des ressources

- Document : `externally_shared=0` par défaut. Le partage sélectionne les révisions
  exactes dans `revision_shares`. C n’hérite jamais du partage de B. Retirer le
  partage retire l’accès aux prochains téléchargements, y compris les anciens liens.
- Points et dessins : seuls les points publiés d’une révision accessible et leurs
  dessins associés sont visibles à l’extérieur. Brouillons et dessins non associés
  restent internes. Une annotation fournisseur doit viser un point publié exact ;
  elle conserve le véritable auteur. La visionneuse et le moteur de dessin existants
  sont réutilisés ; les dessins d’un autre auteur ne sont pas modifiables.
- Commentaires : accès hérité du point exact. Une permission de réponse est requise
  pour écrire ; un lecteur ne voit pas les commandes d’écriture.
- Conversations : partage explicite de la conversation **et** du message. Un message
  privé reste privé dans une conversation partagée. Les réponses du fournisseur sont
  partagées. Les références inaccessibles ne renvoient ni titre, ni identifiant, ni URL.
- Pièces jointes : vérification du message parent et du droit de téléchargement,
  accès par flux Worker authentifié. Aucun lien R2 permanent public n’est créé.
- Demandes : source autorisée et, pour l’extérieur, assignation explicite au membre
  ou création par ce membre. L’assignation n’ouvre pas une conversation interne.
- Approbations : lecture des décisions non brouillon autorisées ; à l’extérieur,
  partage explicite et utilisateur assigné exact. Une décision exige permission
  `approve`, assignation et confirmation explicite dans le parcours collaborateur.
  L’approbateur est assigné avant soumission ; les protections SQL de gel restent
  intactes. Une autre identité ne peut pas se substituer à l’approbateur.
- Traductions et corrections : même contrôle que la source, y compris lors d’un hit
  de cache. Retirer l’accès à la source bloque aussi son cache et ses corrections.
  Les contrôles de correction sont masqués pour les lecteurs.

Les nouveaux événements de décision stockent l’identité serveur vérifiée. Les
anciennes décisions restent inchangées et sont présentées comme historiques du
mode administrateur, sans authentification fournisseur rétroactive ni signature
certifiée. Les instantanés de décision sont immuables après décision.

## Invitations et courriel

Une invitation contient un courriel, rôle, un à vingt projets de la même
organisation, fournisseur lorsque nécessaire, message facultatif et expiration
1–14 jours. Le jeton aléatoire a environ 244 bits d’entropie ; seule son empreinte
SHA-256 est stockée. Le lien utilise un fragment URL retiré de l’adresse par
l’interface ; aucun jeton n’est conservé dans localStorage ou les listes D1.
L’acceptation vérifie le courriel Access, l’expiration et la révocation, puis réclame
l’invitation et crée les appartenances dans un batch D1. Un identifiant d’opération
unique empêche une seconde requête concurrente de réutiliser la première acceptation.

Les états sont attente, acceptée, expirée, révoquée. Renvoyer remplace le jeton et
fixe une nouvelle expiration de sept jours. Une invitation acceptée ou révoquée
n’est pas renvoyée. Les invitations préparatoires des premières phases ne sont
jamais acceptées par ce nouveau protocole.

Transport Resend préparé côté Worker : `RESEND_API_KEY` et `INVITATION_FROM` requis,
ainsi que le mode multiutilisateur activé. Le domaine d’expédition doit être vérifié
chez le fournisseur. Sans cette configuration, aucune requête d’envoi n’est faite :
l’interface annonce « Aucun courriel envoyé » et retourne une seule fois le lien à
transmettre au destinataire dans un canal approprié. Un échec d’envoi est distingué
d’un accusé d’acceptation du fournisseur ; celui-ci ne garantit pas la réception.
Les délais sont bornés, aucune relance automatique ou campagne de masse n’est lancée.

## Interface

L’administrateur dispose de « Utilisateurs et accès » dans l’administration :
invitations, renvoi/révocation, membres, rôles, permissions, révocation des sessions,
partage exact des révisions, conversations, approbateur et assignation de demandes,
événements de sécurité. Les anciens contrôles de modification des rôles sont
remplacés dès que le schéma 0009 est présent, pour ne pas conserver deux chemins de gestion.

Les autres membres reçoivent un espace réduit aux projets et fonctions autorisés,
avec documents/PDF, points et commentaires, conversations et demandes, décisions
assignées et traduction. L’administrateur de projet dispose de la gestion de ses
membres. Interface FR/EN/chinois simplifié ; la préférence linguistique du membre
est enregistrée sur son propre profil. Les erreurs d’écriture conservent les textes
saisis. Les lectures sont paginées et ne chargent pas les fichiers R2 pour compter
ou rechercher. La sélection des projets utilise un contrôle SQL commun en une
requête, sans une requête de permission supplémentaire par projet.

Les messages regroupent leurs références et pièces jointes en requêtes bornées ;
les demandes privées sont filtrées avant pagination. Le compte administrateur initial
ne reçoit aucun privilège de propriétaire dans une autre organisation où il est
fournisseur, y compris lorsque le mode multiutilisateur est désactivé après 0009.

Le glossaire brut est réservé au propriétaire. Les traductions externes utilisent
uniquement le texte partagé, sans termes du glossaire interne. Leur cache est distinct
lorsque ces termes interviennent ; une correction recontrôle le contexte courant
et refuse un ancien cache interne. Aucun partage de glossaire implicite.

## Déploiement préparé, non exécuté

La migration additive `0009_secure_collaboration.sql` conserve données, identités,
révisions, liens, fichiers et protections existants. Aucun partage de masse ni
rattachement automatique de contenus à un nouveau compte. L’organisation et l’UUID
administrateur actuels restent l’autorité de rattachement des données existantes.

**Le code n’active pas le mode multiutilisateur.** Sans `MULTIUSER_ENABLED=true`,
l’administrateur conserve le fonctionnement de phase 6, même si 0009 n’est pas
encore appliquée. Ce cas a été testé avec le nouveau Worker sur un schéma 0008,
y compris lecture R2 et décision d’approbation. Les contrôles D1 de sessions et la
nouvelle provenance sont activés avec le mode collaboratif ; le mode privé utilise
la déconnexion Access existante.

Le contrôle de migration refuse toute écriture distante de 0009 sans :

- `PHASE7_SECURITY_REVIEWED=true` ;
- `PHASE7_BACKUP_PROOF` égal au SHA-256 (64 caractères hexadécimaux) de la sauvegarde
  restaurée et vérifiée par l’opérateur.

Ces valeurs sont transmises depuis les variables du dépôt au job de migration.
Le contrôle ne peut pas certifier à distance le contenu d’une sauvegarde à partir
de son empreinte : renseigner les variables uniquement après les étapes suivantes.
Le workflow garde sa dépendance validation → migration → déploiement demandé.
Un Cloudflare Build indépendant ne remplace pas cette procédure d’activation.

### Interventions indispensables, regroupées

1. **Avant fusion et activation**, confirmer sur `forgebridge-api` que
   `MULTIUSER_ENABLED` est absent ou `false`. Conserver `ACCESS_ISSUER`, `ACCESS_AUD`,
   `ADMIN_EMAIL`, `ADMIN_USER_ID`, l’origine et le secret de passerelle existants.
   Confirmer que la connexion propriétaire correspond au bon UUID/organisation et
   qu’aucune politique Access `Bypass` ne rend l’application publique.
2. Exporter une sauvegarde complète de `forgebridge-db` avec un accès autorisé,
   dans un emplacement privé hors du dépôt et des artefacts publics. Exemple de
   syntaxe préparée, **non exécutée à distance pendant cette tâche** :

   ```sh
   npx wrangler d1 export forgebridge-db --remote --output /secure/forgebridge-before-phase7.sql
   ```

   Restaurer cet export dans un D1 local isolé avec `--local --persist-to`, comparer
   les nombres et identifiants de projets, documents, révisions, points, messages et
   décisions, les clés R2 et les clés étrangères. Exécuter le contrôle/migration 0009
   sur cette copie. Vérifier le schéma, l’intégrité et un second passage inchangé.
   Calculer ensuite le SHA-256 de l’export. Ne pas réinitialiser la base distante.

3. Vérifier dans Cloudflare que le bucket `forgebridge-documents` n’a ni accès
   public `r2.dev`, ni domaine public non contrôlé. Conserver le binding existant
   et tous les objets ; aucune suppression ou modification d’un autre projet.
4. Après tests et sauvegarde vérifiés, renseigner les deux variables de revue du
   dépôt, puis laisser le contrôle appliquer 0009. Vérifier le succès de migration
   avant le déploiement activé. Ne pas adopter manuellement le numéro 0009 ni
   ignorer un contrôle de schéma divergent.
5. Vérifier la politique Access de **cette application uniquement** : adresses
   destinataires autorisées explicitement, compte administrateur maintenu, IdP/OTP,
   cookies Secure/HttpOnly/SameSite, audience et durée. Le jeton d’invitation ForgeBridge
   ne remplace pas l’autorisation de se connecter chez Access. Les conditions/sièges
   du plan et le MFA éventuel doivent être vérifiés avant d’élargir la politique.
6. Pour l’envoi réel, configurer uniquement sur ce Worker `RESEND_API_KEY` et
   `INVITATION_FROM` après vérification du domaine et du plan. Aucun secret Vite,
   clé dans le chat ou compte payant n’est nécessaire pour les tests réalisés ici.
   Sans transport, transmettre manuellement le lien unique reste possible.
7. Déployer le Worker validé, puis définir `MULTIUSER_ENABLED=true` **après** les
   vérifications précédentes. Confirmer le propriétaire, inviter d’abord un compte
   de staging avec textes non confidentiels, accepter avec le courriel attendu,
   tester révocation et téléchargement refusé. Ne pas utiliser de vraies données
   industrielles comme fixture destructible. Les identités du fournisseur réel et
   l’envoi de courriel réel n’ont pas pu être validés dans cet environnement.

### Retour arrière et récupération

Désactiver d’abord `MULTIUSER_ENABLED` : seuls l’administrateur configuré et les
chemins privés précédents restent accessibles. Cette désactivation conserve les
nouvelles données et invitations, sans accorder de rôle propriétaire. Vérifier le
compte administrateur avant tout autre changement. Si nécessaire, revenir au binaire
Worker précédent sans rejouer un ancien script de migration sur le nouveau schéma.
Ne pas supprimer les tables/colonnes 0009 ni les objets R2.

Conserver le manifeste de version, les réglages Access/admin/origine et la sauvegarde
vérifiée. En cas d’incident D1, restaurer et examiner la sauvegarde dans une base
isolée avant toute décision de récupération de production ; ne pas écraser la base
courante à l’aveugle. Un changement de sujet IdP ou la perte d’un accès Cloudflare
nécessite une vérification du propriétaire, pas un bypass administrateur public.

## Validation et limites

Validation locale du 30 octobre 2026 : `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify`
a réussi avec TypeScript, ESLint, **110 tests Vitest dans 10 fichiers**, builds web
et Worker, **4 parcours preview et 21 parcours privés** (25 au total). Cette phase
ajoute **20 scénarios backend et 4 parcours navigateur multiutilisateurs**.

Les **13 tests Python** du contrôle de migration ont réussi, y compris le refus
d’une application distante sans revue/sauvegarde, l’inspection sans écriture et le
passage d’un runner simulé après revue. L’intégration avec le vrai Wrangler/D1 local
a appliqué seulement les migrations manquantes jusqu’à 0009, reconnu 0004 manuelle,
préservé les données initiales et vérifié schéma, ledger, clés étrangères et intégrité.
Le second passage n’a rien changé.

Les réponses de fichiers de collaboration conservent la politique CSP `sandbox`,
le cache privé et la protection anti-sniffing ; les fichiers non prévisualisables
restent des téléchargements. Les tests comparent les originaux R2 octet par octet.
Les reprises d’écriture sont aussi contrôlées après changement de rôle, retrait de
partage ou révocation : un ancien identifiant ne contourne pas les vues filtrées.
La compatibilité du compte initial avant migration 0009 a été testée sur un vrai
schéma 0008 isolé, sans réinitialiser une base distante.

La capture mobile de l’espace fournisseur a été examinée. Les échecs intermédiaires
ont été analysés et corrigés : contrôle conservateur du lecteur, libellés d’interface,
identités de fixture séparées entre parcours, sélecteurs et gel de l’approbateur
respecté. Les protections SQL préexistantes n’ont pas été supprimées pour faire
passer un test. Les traces et captures restent dans `/tmp/forgebridge-phase7-browser-*-failures`.
Aucun échec critique ne reste dans les contrôles exécutés. Les avertissements de
chunks volumineux et de directives de dépendances ne bloquent pas les builds.
Les bundles web ont été vérifiés sans clés de service ni courtier d’identité de test.

**État distant :** aucune migration distante 0009, activation multiutilisateur,
modification Access/R2 ou fusion n’a été exécutée. Aucun courriel réel envoyé.
La sauvegarde distante, les paramètres du fournisseur et le MFA ne sont pas présentés
comme vérifiés ; la procédure sensible reste arrêtée aux prérequis documentés.

Les tests créent administrateur A, collaborateur interne, fournisseurs A/B et lecteur
avec des JWT RS256 signés par des clés éphémères de test, puis utilisent le véritable
vérificateur, Worker, D1 et R2 locaux. Le navigateur simule l’arête Access dans une
fixture liée à loopback ; aucun endpoint de test ni clé de signature n’est importé
par le Worker de production. Le transport courriel est déterministe uniquement
dans le test dédié : son état `sent` signifie une réponse simulée, **aucun courriel
réel n’a été envoyé**. Les textes et fichiers de test sont non confidentiels.

| Cas demandés                                                       | Vérification                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3 : connexion administrateur, déconnexion, sans authentification | JWT signé, signature falsifiée, audience/expiration, compte initial et réponse sans session ; parcours navigateur et replay après logout.                       |
| 4–6 : invitation, expiration, usage unique                         | Création UI, courriel non configuré annoncé, empreinte seule dans D1, identité/courriel, expiration/révocation, concurrence et deuxième acceptation refusée.    |
| 7–10 : projet autorisé/non autorisé, URL directe, R2               | Requêtes API directes croisées projets/organisations, ancien endpoint et flux R2, anciennes URLs après retrait/révocation.                                      |
| 11–15 : interne/partagé, brouillons, conversations, pièces jointes | Révision B seule partagée, C interne, points publiés seulement, dessins liés, messages privés et attachments privés refusés, références filtrées.               |
| 16 : approbation sans permission                                   | Permission, assignation, confirmation et identité serveur ; tentative d’usurpation et décision historique non écrasable.                                        |
| 17–18 : accès/session révoqués                                     | Permission modifiée en cours de session, texte conservé après refus, projet retiré, hash de session et date minimale invalidants.                               |
| 19–21 : recherches, statistiques, changement de rôle               | Recherches/listes filtrées avant pagination, compteurs filtrés, lecteurs sans écriture, accès horizontal et rôle désactivé ; aucune route non examinée ouverte. |
| 22–23 : données existantes et régression                           | Originaux R2, historique et auteurs conservés, redémarrage D1, migration additive locale et suite complète des phases précédentes.                              |

Limites explicites : les configurations réelles Access/R2, les sièges du compte,
le MFA, le domaine d’envoi et une sauvegarde distante restaurée n’ont pas été inspectés
ou validés ici. Aucun fournisseur réel n’a été connecté. Les listes de gestion sont
bornées (200 membres/invitations/projets, pages courantes pour le partage) ; les routes
collaboratives paginent à 30 éléments. Il n’y a pas de SSO interentreprises autonome,
de provisionnement SCIM, de DRM ou de certification de signature. Aucun incident
critique connu ne doit être masqué par ces limites : l’activation reste conditionnée
à la configuration réelle et aux vérifications ci-dessus.
