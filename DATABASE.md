# Base de données D1 / SQLite

## Schéma actif

`apps/api/migrations/0001_d1_foundations.sql` crée les 12 tables métier de la phase 1 : profiles, organizations, organization_memberships, suppliers, supplier_notes, supplier_memberships, projects, project_suppliers, project_memberships, invitations, audit_events et outbox. `identity_links` est ajoutée pour dissocier l’identité Access du compte interne. `0002_profile_email.sql` ajoute le courriel vérifié du profil et son index unique, sans fabriquer d’adresse pour des lignes historiques.

Les UUID deviennent TEXT générés par le Worker, pas des entiers auto-incrémentés. Rôles/états/langues sont des CHECK ; booléens INTEGER 0/1 ; dates ISO UTC par strftime ; payload outbox JSON validé. Les clés étrangères composites empêchent les associations inter-organisations, les codes projet sont uniques par organisation, les pages futures restent hors migration. Les index couvrent les utilisateurs/appartenances, projets récents, invitations, audit et outbox non livrée. Les triggers interdisent UPDATE/DELETE des événements d’audit.

Il n’existe ni auth.users, ni enum PostgreSQL, ni fonction/RPC, ni RLS. Les gardes SQL paramétrées du Store reproduisent les contrôles nécessaires ; D1 reste accessible uniquement au Worker. Les mutations, notes, audit et outbox sont groupés par D1.batch : un échec de contrainte ou d’audit annule le lot. Les gardes sont incluses dans les statements pour éviter un contrôle d’autorisation uniquement préalable à la transaction.

`npm run db:migrate` applique seulement les migrations locales. Elles sont suivies par Wrangler et réapplicables sans réinitialiser les données. Aucune donnée de démonstration. Le profil initial et son identity_link ne sont créés qu’après une vraie identité Access validée correspondant à ADMIN_EMAIL et ADMIN_USER_ID. L’organisation est créée explicitement par l’utilisateur dans l’interface.

Les invitations conservent destinataire, projet, fournisseur, rôle, hash du jeton, expiration, acceptation et révocation. La génération et révocation fonctionnent ; **l’acceptation est désactivée** jusqu’à l’ajout des comptes fournisseurs. Ne pas présenter un jeton préparatoire comme un accès actif.

Aucune extraction ni suppression d’une base distante antérieure n’a eu lieu. Si des données réelles existent, préparer un export en lecture seule, une conversion contrôlée et un import dans une nouvelle D1 de test, vérifier toutes les relations/hashes et lier explicitement les anciennes identités. Ne pas importer automatiquement auth.users ou des secrets. Les migrations historiques sont dans Git, et non dans la chaîne active D1.

## Modèle documentaire prévu — phase 2, non migré

| Entité             | Champs et contraintes prévus                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document           | UUID, organisation/projet, numéro unique par projet, titre, type, description, confidentialité, état, current_revision_id                                       |
| DocumentGrant      | document, fournisseur autorisé, compte éventuel, droits lire/commenter/approuver, expiration ; FK composites de tenant et projet                                |
| DocumentRevision   | UUID, document, numéro unique, draft/published, auteur, création/publication, résumé, previous_revision_id même document, SHA-256 du fichier assemblé           |
| DocumentPage       | UUID, révision, position unique, source_asset_id, preview_asset_id, dimensions, rotation 0/90/180/270, logical_page_id stable entre révisions                   |
| DocumentAsset      | UUID, organisation/projet, clé R2 aléatoire unique, nom original, MIME déclaré et détecté, taille, SHA-256, auteur/date, état pending/quarantine/clean/rejected |
| DocumentAnnotation | UUID, page/révision avec FK composite, auteur, type, géométrie normalisée dans [0,1], contenu/langue originale, état/date                                       |
| DocumentChange     | UUID, anciennes/nouvelles révisions même document, pages logiques affectées, type, auteur/date, résumé, annotations associées                                   |

La position d’une page n’est jamais son identité. Les révisions et actifs publiés sont conservés et interdits de UPDATE/DELETE par des contraintes/triggers à implémenter, y compris leurs pages et références. Une substitution crée un nouveau brouillon, partage les actifs inchangés et attribue de nouveaux identifiants de page de révision en conservant les identifiants logiques.

Publication : verrouiller le document, vérifier le brouillon et l’état clean de tous les actifs, assembler/valider hors transaction, puis dans **un lot D1 transactionnel** figer le manifeste/pages/métadonnées/hash, publier la révision, avancer current_revision_id, écrire audit et outbox. Un objet R2 immuable existe avant commit ; une transaction SQL ne peut pas rendre R2 transactionnel. Un collecteur séparé traite les objets orphelins après délai et vérifie les références avant suppression. Une révision publiée ne doit jamais être écrasée.

Les annotations restent attachées à leur page et révision d’origine. Une projection vers une nouvelle révision est explicite et traçable, jamais un déplacement silencieux.
