# Phase 5 — approbations internes par révision

## Audit et réutilisation

Base inspectée : `main` 7a474ca, PR nº 11 de phase 4 fusionnée. Présents et vérifiés
par lecture du code : passerelle Access privée, identité administrateur résolue côté
serveur, permissions de projet, documents/révisions immuables, stockage R2 privé,
annotations et points indépendants, conversations, demandes techniques et audit.
Aucune approbation officielle par révision n'existait. Le champ documentaire
`documents.status='approved'` ne contient ni demandeur, ni usage, ni décision
historique et ne peut pas servir de preuve d'approbation d'une révision.

Cette phase conserve ce workflow documentaire et le nomme explicitement dans la
fiche. Elle ajoute un registre de décisions internes ; elle ne duplique pas les
actions techniques de phase 4. Une approbation peut référencer une demande technique
existante, un message source et plusieurs points, sans les recopier ni modifier
leurs statuts. Sont réutilisés : priorités, profils, permissions, `Store.write`,
audit/outbox, sélecteur documentaire, rendu de message et visionneuse existante.

## Architecture et garanties

Migration additive **0007_revision_approvals.sql**, après 0006. Trois tables :

- `approval_requests` : identité UUID, numéro APR stable, projet/document/révision
  exacts, demandeur, approbateur futur facultatif, responsable libre, échéance,
  usage, priorité, version et état courant du cycle.
- `approval_points` : références stables vers les points de la révision exacte.
- `approval_events` : événements append-only, auteur logique, date, action et
  données utiles, avec snapshots des numéros/titres/pages des points.

Les identités projet/document/révision/demandeur sont fixées à la création ; le
serveur dérive le projet et le document depuis la révision. Aucun ID administrateur
fourni par le navigateur n'est accepté comme autorisation. Le demandeur et le
décideur proviennent du principal Access existant. Les routes sont internes aux
rôles owner/project_admin. L'approbateur facultatif est un vrai profil réservé à
une future affectation ; s'il est renseigné, la décision exige cette identité.
Aucun compte fournisseur, nouvelle authentification ou signature certifiée ajouté.

Les batches D1 enregistrent atomiquement projection, événements, points et audit.
Les versions empêchent les écrasements concurrents. Chaque opération possède un
identifiant d'événement unique utilisé comme garde pour ses écritures liées :
un enregistrement périmé ne peut pas retirer ou ajouter les points d'une autre
opération, même si une version suivante existe déjà.

Les triggers interdisent la suppression physique des demandes, les modifications
ou suppressions d'événements, le changement de cible, la réécriture des décisions
finales et de l'ordre de soumission. Les informations d'une demande soumise sont
figées. Une suppression de brouillon reste logique et tracée. Les messages utilisés
comme contexte d'une approbation active sont préservés de la suppression logique.

## Cycle autorisé

| État initial                                  | Actions autorisées                                      | Résultat                                              |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Brouillon                                     | Modifier, supprimer, soumettre, annuler avec motif      | Brouillon, suppression logique, en attente ou annulée |
| En attente                                    | Approuver, refuser, demander des modifications, annuler | Décision finale ou annulée                            |
| Approuvée / refusée / modifications demandées | Annuler avec motif, créer un nouveau cycle              | Annulation explicite ou nouvelle demande liée         |
| Annulée                                       | Créer un nouveau cycle                                  | Nouvelle demande liée                                 |

Refus, modifications et annulation exigent une justification côté API. Toute action
est confirmée dans l'interface sur la révision exacte. Après décision, aucune action
ne la remplace silencieusement. L'annulation conserve auteur/date/commentaire de la
décision originale et ajoute son propre événement justifié. Le nouveau cycle possède
un autre UUID et pointe vers le précédent ; celui-ci reste consultable. Les
instructions, usage et priorité sont proposés à nouveau, jamais la validation.
Un seul cycle peut être en attente par révision/usage ; un seul successeur actif
par demande. Supprimer un successeur encore brouillon permet d'en recréer un,
sans perdre sa trace historique.

## Révision, usage et fabrication

Deux usages explicites : validation technique interne et préparation interne à la
fabrication. Approuver une validation technique seule ne valide pas la fabrication.
Un texte de conversation ou le statut documentaire « approuvé » ne crée aucune
approbation. Les notices et badges indiquent toujours le caractère interne de la
décision, sans prétendre qu'un fournisseur réel a donné son autorisation.

L'état d'une révision est calculé depuis le dernier cycle **soumis** pour cet usage.
L'ordre est donné par la séquence immuable des événements de soumission, pas par
l'ordre de création des brouillons ni par une comparaison ambiguë de dates égales.
Les brouillons non soumis ne changent pas une approbation existante. En revanche,
une nouvelle soumission remplace l'ancien cycle comme référence courante ; si elle
est annulée, une ancienne approbation n'est pas réactivée silencieusement.

Chaque révision garde son historique. B approuvée puis C créée : C est non soumise ;
B reste historiquement approuvée mais est signalée obsolète pour la fabrication
courante. L'indicateur de préparation courante exige à la fois la dernière révision
et une approbation interne valide pour l'usage fabrication. Aucun PDF, original,
révision R2 ou point technique n'est modifié ou fermé par une décision.

## Interface et suivi

Accès depuis la fiche et sa visionneuse, la révision choisie dans l'historique, les
références d'une conversation et les demandes techniques existantes. Le registre
possède une liste paginée, recherche document/numéro/révision/objet/responsable,
filtres de statut/usage/priorité/révision, tri par date/échéance/décision/priorité,
panneau de détail, historique chronologique paginé et liens vers la révision exacte,
les points, le contexte de discussion et les cycles précédent/suivant.

Les décisions liées sont consultables dans un volet « Approbations » de chaque
message, chargé seulement lorsqu'il est ouvert. Une discussion seule y est
explicitement distinguée d'une décision. Pour une demande de modifications,
l'utilisateur peut associer des points existants ou ouvrir la visionneuse existante
pour en créer un explicitement ; aucun point n'est créé automatiquement par un refus.

Les statistiques viennent de requêtes D1 et correspondent aux filtres du registre :
les nombres par état incluent les cycles historiques non supprimés ; les échéances
comptent les demandes encore en attente dont la date est passée, selon
America/Toronto, changement d'heure compris. Les décisions bloquantes concernent
uniquement le dernier cycle soumis de l'usage fabrication sur la révision courante,
en attente, refusé ou demandant des modifications. Chaque indicateur ouvre sa liste.

## Performance, migration et périmètre distant

Listes et historique : 30 éléments, pagination et filtres côté serveur. Index de
projet/état, échéance, révision/usage/ordre de soumission, contexte et historique.
Validation des points par une requête groupée et écritures bornées (20 points par
opération). Ni registre, ni statistiques, ni décision ne lisent les fichiers R2.
Les originaux sont chargés uniquement par la visionneuse lorsque l'utilisateur
ouvre une référence. Aucun nouveau service temps réel ou service payant.

Le contrôle de migration existant reconnaît 0007 à partir des fichiers SQL et a été
rejoué en local. Il conserve le baseline console et la reconnaissance de 0004
manuelle, puis applique uniquement les migrations manquantes. Ne jamais réinitialiser
D1 ni rejouer une initialisation. Ordre : 0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007.

La fusion reste au propriétaire. Le workflow principal doit terminer `migrate` avec
succès avant l'utilisation de cette phase. Le déploiement Worker intégré au workflow
est conditionné à la migration. Un Cloudflare Build indépendant ne l'attend pas
automatiquement : sa commande de publication doit appeler le même contrôle avant
le déploiement pour garantir cet ordre, comme décrit dans [D1_AUTOMATION.md](D1_AUTOMATION.md).
Aucune configuration Access/Vercel, variable de protection, bucket, ressource d'un
autre projet, donnée industrielle ou connexion fournisseur n'est changée ici.

## Validation exécutée

Le 30 octobre 2026, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify`
a terminé avec succès : TypeScript, ESLint, 78 tests Vitest dans 8 fichiers,
build web, build Worker, 4 parcours navigateur de prévisualisation et 13 parcours
privés (dont 3 nouveaux parcours d'approbation). Les 14 nouveaux tests backend
couvrent notamment permissions, transitions, concurrence, historique immuable,
révision exacte, pagination, sources, statistiques et conservation des octets R2.
Les parcours privés vérifient formulaires et confirmations, persistance après
rechargement, erreur API puis reprise, liens PDF et absence d'héritage B → C.
La capture mobile du registre a également été examinée.

Les 10 tests Python du contrôle D1 et son intégration Wrangler locale ont réussi :
0004 manuelle reconnue, migrations manquantes jusqu'à 0007 appliquées, schéma,
historique de migration, clés étrangères et intégrité vérifiés, deuxième passage
sans changement. Les données de départ et protections restent présentes.

Les échecs intermédiaires ont été corrigés : une clé React partagée entre deux
composants pouvait conserver le badge d'une autre révision ; le test de lien doit
distinguer les références actuelles de leurs instantanés historiques ; le test R2
conserve ses clés avant l'arrêt de son environnement. Les traces disponibles ont
été conservées dans l'espace de travail temporaire. La suite complète ci-dessus
a été rejouée après ces corrections.

Ces écritures concernent exclusivement des bases et buckets locaux isolés.
Aucune migration distante, publication de production, fusion, connexion fournisseur
ou modification R2 distante n'a été exécutée. La validation en production reste
conditionnée à l'application réussie de 0007 après la fusion par le propriétaire.
