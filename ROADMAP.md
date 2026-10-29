# Feuille de route

## Migration actuelle

Supprimer les dépendances d’exécution Supabase, déplacer les 12 tables métier vers D1, ajouter identity_links, conserver le frontend, protéger le Worker par validation Access et l’origine Vercel par middleware. Le seul utilisateur actif est l’administrateur réel autorisé ; les fournisseurs ne peuvent pas se connecter. Les projets/fournisseurs/préférences et invitations préparatoires sont persistants ; l’acceptation des invitations reste désactivée.

Avant utilisation réelle : configurer les ressources ForgeBridge dédiées, Access, le domaine privé et le verrou Vercel, puis exécuter les tests distants de refus et de persistance. Aucune bascule automatique, aucun import ni suppression de données anciennes.

## Ensuite : comptes fournisseurs

Ajouter un fournisseur d’identité maintenu derrière l’abstraction existante. Définir lien sujet/compte, récupération, MFA, révocation et invitations atomiques à usage unique. Ne pas autoriser tous les courriels Access à devenir propriétaires. Tester les cinq fournisseurs et les comptes individuels avant activation. Conserver contrôles tenant/projet/entreprise et audit ; ne pas remplacer ces contrôles par des rôles seuls.

## Priorité documentaire

Créer Document/Grant/Asset/Revision/Page selon DATABASE.md. Bucket R2 dédié privé, upload avec limites et quarantaine, type réel/hash/antivirus, multipart contrôlé et nettoyage des uploads incomplets. PDF seulement visualisable, autres formats seulement stockés/téléchargés sans exécution serveur. Remplacement de page en brouillon, publication atomique du manifeste D1 et objets immuables, tests d’IDOR par document et de publication concurrente.

Puis annotations normalisées par page/révision, historique, accusés de réception et approbations. Les annotations ne modifient pas le PDF d’origine. Événements `document.created`, `document.revision.drafted`, `document.revision.published`, `document.annotation.created`, `document.approval.requested`, `document.acknowledged` et consommateurs idempotents pour notifications. Les contrats de traduction, notifications et approbations sont réservés dans packages/shared.

## Décisions à prendre avant l’ouverture externe

Domaine privé, offre/quotas gratuits, accès Chine, rétention et sauvegarde/restauration, politique MFA de l’IdP, futur fournisseur d’identité, limites de fichiers, antivirus et service PDF isolé. Aucun système de facturation SaaS requis.
