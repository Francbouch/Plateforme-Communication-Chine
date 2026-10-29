# Base de données

## Tables actives

`profiles` référence `auth.users` (UUID, nom, langue, fuseau, statut, création). Le trigger Auth ne crée aucun droit métier. `organizations` possède les projets. `organization_memberships` lie compte et organisation, rôle et activation. `suppliers` contient les coordonnées ; `supplier_notes` isole les notes internes accessibles aux seuls propriétaires MFA. `supplier_memberships` contient l’appartenance active et un champ de délégation réservé (non activé en phase 1).

`projects` possède code unique dans l’organisation, nom, description, statut, dates. `project_suppliers` autorise explicitement une entreprise sur un projet. `project_memberships` autorise un compte sur un projet, avec rôle et fournisseur éventuel. Les clés étrangères composites interdisent de lier différentes organisations. Un rôle fournisseur exige un fournisseur ; les autres rôles n’en acceptent pas.

`invitations` contient courriel, projet, fournisseur éventuel, rôle, empreinte SHA-256, auteur, expiration et dates d’acceptation/révocation. Le jeton aléatoire possède deux UUID ; seul son hash est conservé. Acceptation verrouillée `FOR UPDATE`, vérification du courriel confirmé, délai et usage unique ; appartenance et audit sont transactionnels. Une invitation ne réactive ni ne remplace silencieusement un accès existant révoqué : le responsable doit gérer cet accès explicitement.

`audit_events` est append-only pour les utilisateurs ; `outbox` n’est pas lisible par les clients. Index sur appartenances par utilisateur, projets par organisation/date, invitations, audit et événements non livrés.

Les RPC sont les seuls chemins d’écriture autorisés. Les droits EXECUTE implicites de PUBLIC sont révoqués. Les fonctions SECURITY DEFINER ont un `search_path` vide et des noms de tables qualifiés. Les scripts de test Auth ne doivent **jamais** être appliqués à Supabase réel.

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

La position d’une page n’est jamais son identité. Les révisions et actifs publiés sont conservés et interdits de UPDATE/DELETE par trigger, y compris leurs pages et références. Une substitution crée un nouveau brouillon, partage les actifs inchangés et attribue de nouveaux identifiants de page de révision en conservant les identifiants logiques.

Publication : verrouiller le document, vérifier le brouillon et l’état clean de tous les actifs, assembler/valider hors transaction, puis dans **une transaction** figer le manifeste/pages/métadonnées/hash, publier la révision, avancer current_revision_id, écrire audit et outbox. Un objet R2 immuable existe avant commit ; une transaction SQL ne peut pas rendre R2 transactionnel. Un collecteur séparé traite les objets orphelins après délai et vérifie les références avant suppression. Une révision publiée ne doit jamais être écrasée.

Les annotations restent attachées à leur page et révision d’origine. Une projection vers une nouvelle révision est explicite et traçable, jamais un déplacement silencieux.
