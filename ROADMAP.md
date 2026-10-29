# Feuille de route

## Phase 1 — livraison actuelle

Fondations React/Worker, authentification Supabase câblée, TOTP, projets, fournisseurs, membres, invitations nominatives et préférences. RLS, transactions d’audit et outbox. Aucune statistique fictive. Les comptes/services réels restent à configurer et leur intégration à valider avant de considérer la phase acceptée.

## Phase 2 — priorité documentaire

1. Migrer Document/Grant/Asset/Revision/Page avec invariants et tests RLS par document.
2. Nouveau R2 privé, uploads en quarantaine, vérification type/checksum, limites configurables, antivirus et nettoyage contrôlé ; multipart pour gros fichiers.
3. PDF visualisable via streaming authentifié/Range, autres formats seulement téléchargeables.
4. Brouillons et remplacement d’une page ; conserver logical_page_id, actifs originaux et anciennes révisions.
5. Publication atomique du manifeste en SQL et objets immuables ; tester course concurrente, échec upload/commit et reprise idempotente.
6. Tests de téléchargement interdit par modification d’UUID/clé, accès expiré/révoqué et fournisseurs du même projet avec grants différents.

## Phase 3

Annotations géométriques normalisées, historique page/révision exact, comparaison, demandes d’approbation et accusés de réception. Les annotations ne modifient pas les PDF sources. Événements `document.created`, `document.revision.drafted`, `document.revision.published`, `document.annotation.created`, `document.approval.requested`, `document.acknowledged`.

## Phases suivantes

Consommateurs idempotents de notifications, traduction via interface `TranslationProvider.translate(text,source,target,glossary)` séparée des traductions UI, décisions techniques, glossaires, coffre contractuel, fabrication, puis messagerie complète. Réserver les interfaces `NotificationDispatcher.dispatch(event,idempotencyKey)` et les événements de demandes techniques/approbations ; aucun fournisseur externe de traduction ni envoi n’est activé.

## Décisions en attente

Région/résidence des données et accès réseau Chine ; compte/projet Supabase dédié ; SMTP ; politique de récupération MFA ; domaine ; RPO/RTO et rétention ; antivirus et service PDF isolé ; tailles maximales des fichiers ; règles fines de publication et délégation fournisseurs. La facturation SaaS est hors portée.
