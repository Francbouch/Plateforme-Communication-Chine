# Phase 8 — audit, stabilisation et lancement

Audit du 31 octobre 2026, basé sur `main` après fusion de la PR #14 (phase 7).
Le code des phases 1 à 7 existe dans le dépôt ; leur activation distante n’est
pas déduite de leur présence. Le runtime de cette intervention n’expose aucun
secret Cloudflare, Vercel, R2, Resend ou DeepL. Le secret GitHub Actions existant
n’est ni lu ni remplacé.

**Évaluation : prêt pour test interne dans l’environnement isolé validé.**
Le pilote fournisseur reste conditionné aux vérifications distantes de la phase 7,
à une sauvegarde réelle restaurée/vérifiée, et à un essai autorisé non confidentiel.
Aucune restauration, migration, activation fournisseur ou publication sensible
n’est exécutée en production pendant cette phase. La fusion reste au propriétaire.

## Audit et priorités

| Priorité | Constat et preuve                                                                                                                                                       | Traitement                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Aucun accès horizontal non autorisé reproduit dans les contrôles exécutés. Cela ne certifie pas les réglages distants.                                                  | JWT vérifiés, isolation projets/organisations, lectures et écritures directes, retrait de partage et révocation rejoués.                                                                                       |
| P1       | Un export local Wrangler complet ne se restaure pas directement : `foreign key mismatch` sur les références de révisions, car un index unique arrive après les données. | Copie préparée avec tables/indexes avant données et triggers d’origine après données ; contraintes conservées, restauration dans une seconde D1. Export brut inchangé.                                         |
| P1       | Les révisions et points fournisseur sont paginés côté API, mais l’interface s’arrêtait aux 30 premiers.                                                                 | Navigation entre pages, réinitialisation de la sélection lors des changements de document/révision. Test réel avec 31 révisions partagées et 31 points publiés ; une révision non partagée reste inaccessible. |
| P1       | Changer la langue relançait le chargement du PDF et remettait sa page à 1.                                                                                              | La session du PDF dépend de la ressource, pas de la traduction des libellés. Page conservée et zéro téléchargement supplémentaire vérifiés.                                                                    |
| P1       | Échec PDF sans reprise dédiée, erreurs serveur parfois affichées telles quelles, expiration de session peu explicite.                                                   | Réessai PDF explicite, messages FR/EN/zh-CN compréhensibles, avertissement de session avec lien de reconnexion, saisie conservée sans redirection automatique.                                                 |
| P1       | Audit npm initial : 4 alertes hautes dans la chaîne Vercel/Zod ; 2 critiques dans la chaîne de test Vitest/Tinypool, plus des alertes modérées.                         | Zod transitif ciblé en 4.6.7 ; Vitest 4.1.12. Audit après : aucune alerte de production, aucune haute/critique au total.                                                                                       |
| P2       | Les routes de fichiers fournisseur et pièces jointes ne géraient pas les plages d’octets, contrairement aux révisions administrateur.                                   | Lecteur privé commun, streaming et plages simples/suffixes, 416 sans lecture R2 pour une plage invalide, aucun cache public. Autorisation toujours avant lecture.                                              |
| P2       | L’espace fournisseur et la visionneuse entraient inutilement dans le graphe initial de chargement.                                                                      | Chargement différé sans nouvelle bibliothèque de production. Mesures ci-dessous.                                                                                                                               |
| P2       | Anciennes instructions de déploiement encore adaptées à l’installation initiale, pas aux ressources actuelles.                                                          | Clarification du runner de migration obligatoire et du rôle réel de R2 ; procédure de récupération ci-dessous.                                                                                                 |
| P3       | Refonte générale, animations, nouveaux modules.                                                                                                                         | Non entrepris. Identité graphique et fonctionnement métier conservés.                                                                                                                                          |

L’audit a parcouru frontend, routes Hono et validations, schéma/migrations D1,
stockage R2, vérification Access/session, modèles de permissions et références,
client HTTP/erreurs, navigation, PDF/annotations, cache React Query, tests,
dépendances et procédures de déploiement. Aucune migration 0010 n’est nécessaire.
Aucun index, coordonnées historiques ou format de document existant n’est modifié.

## Données, cohérence et sécurité

| Module                           | Vérification isolée                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projets, fournisseurs, membres   | Création/modification/rechargement, appartenance réelle, projets distincts, permissions optimistes et révocation.                                                                  |
| Dossiers/documents               | Création, déplacement, cycles refusés, recherche, archivage et persistance après rechargement.                                                                                     |
| Révisions/R2                     | Original immuable, B conservée après création de C, checksum, import incomplet refusé, plages d’octets, références exactes et refus après retrait.                                 |
| PDF/annotations/points           | Pages, zoom, rotation, déplacement/redimensionnement, sélection multiple, association, publication/suppression logique, rechargement, changements rapides et reprise après erreur. |
| Messages/pièces jointes/demandes | Envoi/édition/réponse, recherche, archivage, référence document-révision-page, fichier conservé, échec réseau avec brouillon conservé et persistance.                              |
| Approbations                     | Révision exacte, assignation et identité du décideur, confirmation, décision immuable, nouvelle révision non approuvée automatiquement.                                            |
| Traductions                      | Original inchangé, valeurs techniques, cache/correction, source recontrôlée, glossaire interne privé, erreurs du fournisseur simulé.                                               |
| Invitations/sessions             | Courriel vérifié, token haché à usage unique, expiration/révocation, identité réelle signée, refus des anciennes URLs et reconnexion explicite après 401.                          |

Les routes fournisseur restent une liste autorisée fermée ; les anciennes API
administrateur ne sont pas rendues accessibles pour faciliter la navigation.
Le lecteur de fichiers commun n’effectue pas l’autorisation à la place des routes :
chaque route vérifie d’abord la ressource et ses permissions actuelles. Les réponses
conservent `private, no-store`, `nosniff`, CSP `sandbox`, noms encodés et accès via
Worker. Les fichiers techniques restent des téléchargements. `If-Range` entraîne
un retour conservateur du fichier entier ; les plages multiples sont refusées.
Aucune URL publique R2, aucun cache partagé ni accès par clé choisie par le client.

Les champs masqués ne sont pas considérés comme une protection. Les tests attaquent
les API et contenus directement, avec administrateur, interne, fournisseurs et lecteur,
ainsi que signature/audience/expiration invalides. Les clés de signature, courriels,
traductions et identités des tests sont uniquement des fixtures isolées. L’expiration
supplémentaire est provoquée par une vraie révocation serveur, puis un envoi UI :
le brouillon reste visible et aucune écriture n’est enregistrée.

## Performance et limites des mesures

Build Vite dans le même environnement, avant/après sur les sources de cette phase :

| Mesure                                        |                        Avant |                                               Après |
| --------------------------------------------- | ---------------------------: | --------------------------------------------------: |
| Entrée JS initiale minifiée                   |                    621,92 ko |                                           575,87 ko |
| Entrée JS initiale gzip                       |                    192,41 ko |                                           180,33 ko |
| Réduction                                     |                            — |                          7,4 % minifié ; 6,3 % gzip |
| Téléchargement PDF après changement de langue | Rechargement de la ressource | Aucun nouveau téléchargement dans le parcours testé |
| Plage fournisseur `bytes=0-7`                 |         Fichier entier (200) |                           Exactement 8 octets (206) |

Le PDF.js et l’outil de remplacement des pages restent chargés à la demande.
Les listes restent paginées ; pas de chargement global de tous les documents,
révisions ou pièces jointes. Le regroupement SQL des références/messages et les
recherches temporisées existantes sont conservés. Pas de nouvelle boucle de polling,
préchargement R2 massif ou traduction automatique. Chaque requête de plage conserve
ses contrôles D1 : la réduction d’octets ne signifie pas une baisse garantie du nombre
de requêtes Worker. Aucun chiffre de facture, de latence en production ou de charge
multiutilisateur réelle n’est revendiqué. Les gros chunks différés restent signalés
par Vite ; ils constituent une recommandation, pas une panne corrigée artificiellement.

## Contrôles de livraison

- `CI=true GITHUB_ACTIONS=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify` : TypeScript, ESLint, Vitest, builds web/Worker, Playwright preview et privé.
- 120 tests Vitest dans 11 fichiers : 110 existants conservés, 9 cas du lecteur de fichiers et 1 scénario d’accès fournisseur aux plages après retrait de partage.
- 27 parcours navigateur : 4 preview, 23 privés, dont 2 nouveaux parcours regroupant pagination longue, PDF en échec, changement de langue et expiration avec brouillon.
- 15 tests Python : les 13 contrôles de migration existants plus 2 cas de préparation d’export (cause réelle de l’échec et refus de SQL incomplet/non pris en charge).
- Intégration native Wrangler/D1 locale : reconnaissance de 0004 manuelle, application des seules migrations manquantes jusqu’à 0009, second passage inchangé ; export, copie préparée, restauration distincte, données/ledger/triggers/intégrité (`quick_check` et clés étrangères) et refus de suppression d’une révision immuable.
- `npm audit --omit=dev --json` : 0 alerte. Audit complet : 11 alertes modérées de la chaîne ESLint/minimatch, 0 haute et 0 critique.

Les résultats finaux et les liens CI de la branche sont reportés dans la PR.
Les échecs intermédiaires sont conservés dans `/tmp` : traces navigateur et journaux
de sauvegarde, sans donnée industrielle. Les assertions d’erreur vérifient les nouveaux messages traduits plutôt que le
texte technique injecté ; les contrôles du brouillon, de l’absence d’écriture et
de la reprise restent actifs. D1 autorise `quick_check` dans cette interface, pas
`integrity_check` : la procédure utilise le contrôle réellement disponible.
Les premiers points de fixture étaient
encore brouillons : le test les publie maintenant explicitement au lieu de modifier
les règles métier. La suite conserve ses vrais contrôles de persistance et permissions.

## Sauvegarde et récupération : procédure opérateur

**Vérifié ici :** restauration d’un export contenant des données sentinelles dans
une D1 locale séparée, avec les protections SQL. Ce test ne crée aucune sauvegarde
persistante de production. Les exports temporaires sont privés et supprimés après
le test. **Non vérifié :** existence/âge d’une sauvegarde distante, couverture R2,
paramètres Time Travel, clés opérateur et exercice de reprise du vrai environnement.

Depuis une machine déjà autorisée, confirmer le compte et le nom de la D1 ForgeBridge.
Ne pas recréer les ressources. Prévoir une fenêtre cohérente sans écriture pour un
couple D1/R2 concordant, dans le processus opérateur existant. Utiliser un stockage
privé chiffré et ne jamais joindre l’export à la PR ou aux artefacts CI.

```sh
# Racine du dépôt. Répertoire opérateur sécurisé, pas un chemin du site web.
umask 077
mkdir -p /secure/forgebridge-backup
cd apps/api
npx wrangler d1 export forgebridge-db --remote --output /secure/forgebridge-backup/d1-raw.sql
cd ../..
sha256sum /secure/forgebridge-backup/d1-raw.sql
python3 scripts/d1/prepare_restore.py /secure/forgebridge-backup/d1-raw.sql /secure/forgebridge-backup/d1-restore.sql
```

La copie préparée réordonne des instructions d’un export complet connu ; elle ne
corrige pas des données corrompues et ne doit pas remplacer le fichier brut. Elle
refuse les instructions inconnues/incomplètes et un fichier de sortie déjà existant.
Aucune désactivation des contraintes ni suppression de trigger. Conserver les deux
empreintes. Un nouveau format d’export refusé doit être examiné, pas contourné.

```sh
# Toujours une D1 LOCALE DISTINCTE ET VIDE. Jamais --remote pour l’exercice.
cd apps/api
npx wrangler d1 execute forgebridge-db --local --persist-to /secure/forgebridge-backup/isolated-state --file /secure/forgebridge-backup/d1-restore.sql
npx wrangler d1 execute forgebridge-db --local --persist-to /secure/forgebridge-backup/isolated-state --command 'PRAGMA quick_check; PRAGMA foreign_key_check;'
npx wrangler d1 execute forgebridge-db --local --persist-to /secure/forgebridge-backup/isolated-state --command "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name; SELECT name FROM d1_migrations ORDER BY id;"
```

Comparer aux lectures de la source : nombre de projets/documents/révisions/messages,
échantillons de données et identités, valeurs et clés R2, appartenance et permissions,
ledger et liste/SQL des triggers. Vérifier que les révisions et historiques restent
immuables sur la copie, puis démarrer une instance de test isolée avec le vrai compte
administrateur de test. Ne jamais faire cet essai de suppression sur la production.
Le test natif automatisé démontre ce contrôle sur des sentinelles, pas sur vos données.

L’export D1 **ne contient aucun octet R2**. Avec des accès S3 R2 déjà configurés sur
la machine opérateur, sauvegarder séparément le bucket privé, sans `--delete` :

```sh
aws s3 sync s3://forgebridge-documents /secure/forgebridge-backup/r2 --endpoint-url https://5b91da32c6ac0121968ee821e875ce7d.r2.cloudflarestorage.com
```

Exporter aussi en privé le manifeste des références D1 (`document_revisions` :
`object_key,size,sha256` ; `message_attachments` attachées : mêmes colonnes).
Pour chaque entrée, vérifier présence, taille et SHA-256 du fichier sauvegardé ;
comparer le nombre d’objets et tester leur lecture dans un stockage isolé. Garder
les clés d’objets exactes : changer leur chemin casserait les références restaurées.
Une copie sans comparaison du manifeste n’est pas une sauvegarde R2 vérifiée.
Confirmer dans Cloudflare que r2.dev et les domaines publics restent désactivés ;
ne pas changer les politiques ou activer une offre payante pendant cet exercice.

Pour les sauvegardes périodiques, fréquence, rétention chiffrée, propriétaire,
alertes d’échec et objectif de reprise restent à fixer par l’opérateur. Contrôler
la fenêtre réelle de Time Travel dans le compte ; ne pas supposer sa rétention.
Tester la restauration périodiquement sur une ressource isolée autorisée. Aucune
restauration distante n’est exécutée par l’outil de préparation ou cette PR.

## Migration et retour arrière

Aucune nouvelle migration n’est ajoutée. Le runner reconnaît toujours 0004 manuelle
et applique seulement les migrations manquantes. Les conditions de sécurité de 0009
restent actives (`PHASE7_SECURITY_REVIEWED` et empreinte d’une vraie sauvegarde
restaurée/vérifiée). Ne jamais utiliser l’empreinte d’une fixture de CI comme preuve
opérateur. Aucun secret GitHub, binding ou autre projet Cloudflare n’est modifié.

Le rollback de cette phase consiste à redéployer le Worker et le frontend du même
commit précédent approuvé, avec les bindings, UUID administrateur et secrets actuels
inchangés. Pas de reset D1, suppression R2 ou migration inverse. Vérifier avant
publication le compte initial, `/api/v1/me`, lecture PDF autorisée et refus d’un
contenu interdit. Si l’activation phase 7 doit être interrompue, suivre son rapport
et `MULTIUSER_ENABLED=false` ; cela ne remplace pas le test de reconnexion et ne
retire aucune donnée. La restauration d’un ancien état métier exige une procédure
d’incident séparée : un rollback de code n’annule pas les écritures des utilisateurs.

## Checklist de lancement et travaux reportés

| Élément                                                       | État                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| Fonctions des phases 1–7 et parcours essentiels isolés        | Vérifiés par suites locales et CI de la PR                   |
| Permissions API/fichiers, révocation, révisions exactes       | Vérifiées localement ; politique Access réelle à vérifier    |
| Compilation, lint, tests, dépendances de production           | Contrôlés ; aucun service payant ajouté                      |
| Sauvegarde/restauration D1 réelle et manifeste R2             | Non vérifiés ; bloquants pour le pilote fournisseur          |
| Connexion réelle administrateur et fournisseur de test        | À confirmer dans un staging autorisé après revue phase 7     |
| Access : audience/politique, MFA/expiration et origine Vercel | Réglages distants non inspectés ici                          |
| DeepL/Resend : offre, quotas, clés et délivrabilité           | Non testés en réel ; simulations seulement ; mail facultatif |
| Déploiement sensible et fusion                                | Non exécutés ; fusion au propriétaire                        |

Recommandations P2 : corriger la chaîne ESLint/minimatch dans une mise à jour
compatible validée (pas d’override incompatible de son API v3), mesurer une charge
réaliste sur staging, observer les erreurs par identifiant sans texte métier,
compléter les sélecteurs de gestion encore limités aux 200 premiers éléments et
lister les conversations fournisseur au-delà de leur première page, étudier FTS
uniquement après mesure, réduire les gros chunks différés si leur coût réel le
justifie. Définir une politique de conservation des journaux/sessions avec l’opérateur
avant d’ajouter une purge ; aucune donnée existante n’est supprimée ici.

Limites : PDF/collaboration validés sur Chromium, pas de certification Safari/Firefox,
pas de test de charge ni de récupération de production, pas de garantie DRM sur des
octets déjà téléchargés, pas de SLA ou de coût cloud mesuré. Les 200 premiers projets
et sélecteurs de gestion restent une limite documentée ; les révisions/points de
consultation ont désormais une navigation paginée. Aucun nouveau module majeur.
