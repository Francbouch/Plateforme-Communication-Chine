# Permissions — Access et D1

Le mode développeur privé désactive l’accès des fournisseurs et l’acceptation des invitations. Les rôles et portées restent stockés et testés pour leur activation future. Les contrôles sont exécutés par Store dans l’API, pas par des policies PostgreSQL.

Toutes les cases autorisées exigent un compte actif, une appartenance organisation active et la portée correspondante. « Assigné » signifie ProjectMembership actif. Un fournisseur exige aussi SupplierMembership actif, Supplier actif et ProjectSupplier explicite. Le mode actuel n’admet qu’un administrateur vérifié par Access ; les autres colonnes décrivent la couche d’autorisation future, pas des comptes déjà ouverts.

| Opération phase 1                   | Owner                | Project Admin | Designer     | Supplier Manager      | Supplier Engineer     | Reviewer     |
| ----------------------------------- | -------------------- | ------------- | ------------ | --------------------- | --------------------- | ------------ |
| Lire projet                         | Son organisation     | Assigné       | Assigné      | Assigné + fournisseur | Assigné + fournisseur | Assigné      |
| Créer projet                        | Oui                  | Non           | Non          | Non                   | Non                   | Non          |
| Modifier projet                     | Son organisation     | Assigné       | Non          | Non                   | Non                   | Non          |
| Créer/modifier fournisseur et notes | Oui                  | Non           | Non          | Non                   | Non                   | Non          |
| Lire coordonnées fournisseur        | Organisation         | Organisation  | Organisation | Son entreprise        | Son entreprise        | Organisation |
| Associer fournisseur/projet         | Oui                  | Assigné       | Non          | Non                   | Non                   | Non          |
| Inviter/révoquer invitation         | Oui                  | Assigné       | Non          | Non                   | Non                   | Non          |
| Rôle/activation projet              | Oui                  | Assigné       | Non          | Non                   | Non                   | Non          |
| Rôle/activation organisation        | Oui, jamais soi-même | Non           | Non          | Non                   | Non                   | Non          |
| Lire audit                          | Oui                  | Non           | Non          | Non                   | Non                   | Non          |
| Préférences personnelles            | Soi                  | Soi           | Soi          | Soi                   | Soi                   | Soi          |

Le rôle d’organisation n’octroie pas à lui seul les projets, sauf Owner. Le rôle Project Admin dans l’organisation n’octroie rien sans assignation au projet. Modifier un rôle projet ne permet pas de convertir implicitement un ingénieur fournisseur en utilisateur interne. Les rôles d’organisation sont gérés par Owner ; un Owner peut désactiver un autre Owner, mais pas lui-même.

La délégation d’invitations aux Supplier Managers est réservée et désactivée. Le modèle documentaire prévoit lecture, édition brouillon, publication, annotation, approbation et accusé de réception, mais **aucun de ces droits documentaires n’est actif en phase 1**. La phase 2 exigera des grants par document et fournisseur/compte avant tout accès R2.

Les membres d’organisation ne sont listés intégralement qu’aux propriétaires ; les autres voient leur propre ligne. Les collaborateurs du projet sont visibles à ses administrateurs, les autres voient leur propre appartenance. Aucun courriel d’annuaire global n’est exposé.
