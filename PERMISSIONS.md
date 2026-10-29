# Matrice des permissions

Toutes les cases autorisées exigent un compte actif, une appartenance organisation active et la portée correspondante. « Assigné » signifie ProjectMembership actif. Un fournisseur exige aussi SupplierMembership actif, Supplier actif et ProjectSupplier explicite. Les propriétaires et administrateurs de projet doivent utiliser MFA AAL2 pour leurs droits d’administration.

| Opération phase 1                   | Owner                      | Project Admin | Designer     | Supplier Manager      | Supplier Engineer     | Reviewer     |
| ----------------------------------- | -------------------------- | ------------- | ------------ | --------------------- | --------------------- | ------------ |
| Lire projet                         | Son organisation + MFA     | Assigné + MFA | Assigné      | Assigné + fournisseur | Assigné + fournisseur | Assigné      |
| Créer projet                        | Oui + MFA                  | Non           | Non          | Non                   | Non                   | Non          |
| Modifier projet                     | Son organisation + MFA     | Assigné + MFA | Non          | Non                   | Non                   | Non          |
| Créer/modifier fournisseur et notes | Oui + MFA                  | Non           | Non          | Non                   | Non                   | Non          |
| Lire coordonnées fournisseur        | Organisation               | Organisation  | Organisation | Son entreprise        | Son entreprise        | Organisation |
| Associer fournisseur/projet         | Oui + MFA                  | Assigné + MFA | Non          | Non                   | Non                   | Non          |
| Inviter/révoquer invitation         | Oui + MFA                  | Assigné + MFA | Non          | Non                   | Non                   | Non          |
| Rôle/activation projet              | Oui + MFA                  | Assigné + MFA | Non          | Non                   | Non                   | Non          |
| Rôle/activation organisation        | Oui + MFA, jamais soi-même | Non           | Non          | Non                   | Non                   | Non          |
| Lire audit                          | Oui + MFA                  | Non           | Non          | Non                   | Non                   | Non          |
| Préférences personnelles            | Soi                        | Soi           | Soi          | Soi                   | Soi                   | Soi          |

Le rôle d’organisation n’octroie pas à lui seul les projets, sauf Owner (avec MFA). Le rôle Project Admin dans l’organisation n’octroie rien sans assignation au projet. Modifier un rôle projet ne permet pas de convertir implicitement un ingénieur fournisseur en utilisateur interne. Les rôles d’organisation sont gérés par Owner ; un Owner peut désactiver un autre Owner, mais pas lui-même.

La délégation d’invitations aux Supplier Managers est réservée et désactivée. Le modèle documentaire prévoit lecture, édition brouillon, publication, annotation, approbation et accusé de réception, mais **aucun de ces droits documentaires n’est actif en phase 1**. La phase 2 exigera des grants par document et fournisseur/compte avant tout accès R2.

Les membres d’organisation ne sont listés intégralement qu’aux propriétaires ; les autres voient leur propre ligne. Les collaborateurs du projet sont visibles à ses administrateurs, les autres voient leur propre appartenance. Aucun courriel d’annuaire global n’est exposé.
