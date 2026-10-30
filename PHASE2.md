# Phase 2 — projets et bibliothèque documentaire

## Existant conservé

Le Worker Hono, Cloudflare Access déjà opérationnel, l’identité administrateur,
les organisations, projets, fournisseurs et leurs permissions sont réutilisés.
La D1 existante est conservée. Le frontend Vite garde son shell, ses thèmes et ses
trois langues. `/demo` reste un aperçu fictif ; les fichiers réels n’y sont jamais simulés.

## Fonctionnement livré

- Projets : création, édition, dates, statuts actif/en attente/terminé/archivé,
  archivage avec confirmation, recherche et filtres paginés côté serveur, nombre
  de documents et fournisseurs associés, accès à la bibliothèque.
- Dossiers et sous-dossiers : création, renommage, déplacement avec rejet des
  cycles et destinations d’un autre projet ; archivage récursif confirmé.
- Documents : recherche par nom, numéro, extension, projet et nom du dossier ;
  filtres de statut/type/date/révision, tri nom/date/taille/type et pages de 50.
  Recherche dans le dossier actuel ou tous les dossiers du projet.
- Importation multiple et glisser-déposer : transferts séquentiels, progression,
  erreurs, nouvelle tentative et annulation d’une réservation échouée.
  Maximum **50 Mio par fichier**, minimum 1 octet ; les gros fichiers doivent
  être réduits ou séparés. Le multipart R2 au-delà de cette limite n’est pas livré.
- PDF.js chargé à la demande : pages, zoom, ajustement largeur/page, téléchargement.
  CMaps, polices standard et WASM sont servis depuis le même domaine ; aucun CDN.
- Images : aperçu, zoom et ajustement. CAO/Office/ZIP : fiche et téléchargement
  uniquement, sans visionneuse 3D ni exécution de contenu actif.
- Révisions immuables : identité du document stable, UUID et clé R2 uniques,
  numéro de révision unique par document, description, historique et accès aux anciens fichiers.
- Métadonnées, déplacement et statuts documentaires éditables ; historique
  transactionnel des changements de statut. L’archivage conserve les fichiers.

## Raccordement indispensable avant fusion / déploiement

Aucune modification distante de D1, R2, Access ou Vercel n’a été effectuée par
cette phase. Le serveur est validé dans un environnement local workerd/D1/R2.
Les accès de cette session ne permettent pas d’appliquer la migration distante.

1. **Créer uniquement le bucket ForgeBridge**, si absent : Cloudflare →
   Storage & databases → R2 Object Storage → Create bucket →
   nom exact `forgebridge-documents`. Garder l’accès public **désactivé** :
   ni domaine public, ni r2.dev. Aucune clé S3 ni URL présignée à fournir au navigateur.
   Si Cloudflare demande une activation de facturation, examiner les conditions
   avant de confirmer ; ce dépôt ne l’active pas automatiquement.
2. **Appliquer la migration additive** sur `forgebridge-db`, avant de déployer
   le nouveau Worker. Depuis une machine déjà autorisée, à la racine du dépôt :
   `npx wrangler d1 migrations apply forgebridge-db --remote --config apps/api/wrangler.jsonc`.
   Wrangler suit les migrations déjà enregistrées ; il ne doit appliquer que
   `0003_document_library.sql` sur la base existante. Ne jamais exécuter un reset.
   Autre possibilité sans terminal : ouvrir le fichier
   `apps/api/migrations/0003_document_library.sql` de cette branche et copier son
   contenu complet dans **D1 → forgebridge-db → Console**, puis Execute **une fois**.
   Après réussite, enregistrer le marqueur Wrangler avec :
   `INSERT INTO d1_migrations(name) VALUES ('0003_document_library.sql');`.
   Ne pas copier le script `initialize-empty-d1.sql` : il est réservé à une base vide.
3. **Fusionner la pull request**. Les déploiements Git existants pourront alors
   construire le frontend et le Worker. Aucune commande de déploiement Vercel
   supplémentaire n’est nécessaire. Le fichier Wrangler déclare maintenant
   `DOCUMENTS → forgebridge-documents`, afin de conserver le binding à chaque déploiement.
4. Vérifier **Worker → Settings → Bindings** : `DB → forgebridge-db` et
   `DOCUMENTS → forgebridge-documents`. Conserver Access **All traffic** et toutes
   les variables Runtime de production. `keep_vars:true` reste actif ; aucun
   secret n’a changé et aucun `VITE_*` n’est requis.
5. Ouvrir **https://forgebridge-api.francbouch.workers.dev/**, choisir un projet,
   puis **Ouvrir les documents**. Utiliser d’abord un PDF et une image de test
   non confidentiels. Vérifier après rechargement dossier, fichier et révisions.

Si R2 manque, la bibliothèque indique précisément que le stockage est absent et
l’importation est désactivée ; les dossiers restent utilisables. Si la migration
manque, les nouvelles requêtes SQL ne peuvent pas fonctionner : respecter l’ordre.

## Variables et stockage

Les variables Runtime existantes restent `APP_ORIGIN`, `VERCEL_ORIGIN`,
`ACCESS_ISSUER`, `ACCESS_AUD`, `ADMIN_EMAIL`, `ADMIN_USER_ID` et le secret serveur
`ORIGIN_SHARED_SECRET` identique dans Vercel et le Worker. Ne jamais mettre de
secret dans Git, React, les URL ou le chat. Le binding R2 ne nécessite pas de
variable contenant une clé d’accès.

Les objets suivent `organizations/<uuid>/projects/<uuid>/documents/<uuid>/assets/<revision-uuid>`.
D1 garde dossiers, documents, révisions, historique et réservations d’importation.
Le statut terminé utilise une colonne additive pour préserver la contrainte des
anciens projets et leurs clés étrangères ; aucune table existante n’est remplacée.

Chaque opération vérifie les droits côté serveur, y compris téléchargements et
requêtes Range. Les mutations vérifient l’origine et les permissions dans leurs
requêtes SQL. Les écritures D1, audit et outbox sont transactionnelles ; un échec
ne produit pas de faux succès. R2 et D1 ne partagent pas de transaction : un
transfert réserve une clé, vérifie la taille et le SHA-256 dans R2, puis finalise
les métadonnées. Les révisions finalisées ne sont jamais écrasées ni supprimées.

Les transferts interrompus gardent une réservation 24 h, afin de permettre une
nouvelle tentative dans l’onglet. Lors des importations suivantes, les réservations
expirées du même projet/acteur sont annulées et leurs objets non finalisés sont
nettoyés par lots de dix ; aucune révision finalisée n’est concernée. Ne pas quitter la page pendant le transfert.
La suppression d’un bucket ou une politique de suppression globale R2 effacerait
les anciennes révisions : ne pas en configurer. Prévoir des sauvegardes séparées.
Aucun antivirus, compte fournisseur, annotation ou circuit d’approbation n’est
ajouté dans cette phase.

## Validation reproductible

`npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run build:worker`, puis
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:private`
et `npm run test:preview` (adapter le chemin Chromium à la machine).

Les tests documentaires tournent sur le vrai runtime workerd avec D1/R2 isolés
et JWT signés. Les tests navigateur utilisent une identité de test signée uniquement
sur loopback et un stockage temporaire, sans accès à la production.

## Tables et routes ajoutées

Les tables déjà présentes (`profiles`, `identity_links`, `organizations`,
`organization_memberships`, `suppliers`, `supplier_notes`, `supplier_memberships`,
`projects`, `project_suppliers`, `project_memberships`, `invitations`, `audit_events`,
`outbox`) et leurs routes sont conservées. La migration ajoute
`document_folders`, `documents`, `document_revisions`, `document_status_history`,
`document_mutation_actor` (acteur des changements transactionnels) et
`document_uploads`. Les clés de révision permettent les futures annotations
et discussions sans changer l’identité documentaire.

| Route `/api/v1`                  | Usage                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| `GET /projects/search`           | Recherche et pagination des projets                         |
| `GET /projects/:id/library`      | Disponibilité du stockage et limite de transfert            |
| `GET/POST /projects/:id/folders` | Dossiers enfants paginés / création                         |
| `GET /folders/:id/path`          | Fil d’Ariane                                                |
| `PATCH /folders/:id`             | Renommage / déplacement                                     |
| `POST /folders/:id/archive`      | Archivage récursif confirmé par l’interface                 |
| `GET /projects/:id/documents`    | Recherche / filtres / tri paginés                           |
| `GET/PATCH /documents/:id`       | Métadonnées, révisions et historique paginés / modification |
| `POST /projects/:id/uploads`     | Réservation d’une importation ou révision                   |
| `PUT /uploads/:id/content`       | Flux binaire privé avec SHA-256                             |
| `POST /uploads/:id/complete`     | Finalisation transactionnelle et idempotente                |
| `DELETE /uploads/:id`            | Annulation d’un transfert non finalisé                      |
| `GET /revisions/:id/content`     | Aperçu, Range et téléchargement (`download=1`)              |

## Résultats de cette livraison

- Installation propre `npm ci` : réussie.
- TypeScript strict, ESLint et vérification des espaces Git : réussis.
- **34 tests automatisés réussis**, dont cinq scénarios documentaires workerd/D1/R2 :
  stockage réel, révisions immuables, SHA-256, téléchargement/Range, dossiers,
  cycles interdits, recherche/pagination, statuts/historique et refus d’accès.
- Conservation des documents et octets R2 après arrêt/redémarrage du runtime : vérifiée.
- Migration sur une base contenant déjà projets et membres : vérifiée sans perte.
- **Six scénarios Chromium réussis** : deux parcours privés (projets et bibliothèque)
  et quatre contrôles de l’aperçu existant. Le parcours documentaire couvre PDF à
  deux pages, zoom/ajustement, téléchargement, révision A puis B et lecture de A,
  image, fichier STEP, importation multiple, coupure réseau/reprise et mobile.
- Builds Vite/PDF.js et Worker en dry-run : réussis.

Les erreurs réseau provoquées dans les tests sont volontaires et servent à
vérifier les messages d’échec et la reprise. Ces résultats sont locaux : aucun
test de fichier réel sur votre bucket distant n’est revendiqué avant raccordement.
