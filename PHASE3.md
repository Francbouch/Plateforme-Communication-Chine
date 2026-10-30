# Phase 3 — révision technique PDF

## Livré sur l’architecture existante

La bibliothèque, les projets, le stockage R2 et le contrôle d’accès existants sont
conservés. Aucun nouveau service d’authentification, compte fournisseur, bucket ou
secret n’est ajouté. La phase 3 ajoute uniquement une migration D1 et du code.

### Annotations et coordonnées

La visionneuse garde PDF.js, le zoom et la navigation. Sa barre compacte ajoute
sélection, marqueur numéroté, rectangle redimensionnable, flèche, dessin libre,
surlignage et texte, avec rouge/orange/jaune/vert/bleu. On sélectionne une annotation
pour la déplacer et ouvrir son point ; couleur, note et commentaire sont éditables
sur le panneau droit. La suppression est confirmée et retire le graphique seulement :
le numéro historique, la discussion et l’historique restent conservés.

Les coordonnées D1 sont normalisées entre 0 et 1 dans la boîte de recadrage PDF
**non tournée**. La transformation affine du viewport PDF.js convertit les gestes
et les dessins, y compris pour les pages tournées, recadrées ou de tailles différentes.
Zoom, largeur, rotation et plein écran ne changent pas les coordonnées enregistrées.
Une seule mutation est envoyée à la fin d’un tracé/déplacement, pas à chaque pixel.
Les réponses confirmées du serveur mettent à jour les petits caches de listes ;
seul le fil sélectionné est relu pour son historique. Les listes paginées plus
longues sont revalidées. Le quota existant reste à 60 requêtes/minute.
Un brouillon en échec reste visible et peut être réessayé ou annulé. Les UUID de
création permettent une reprise idempotente ; les versions empêchent les écrasements
concurrents. L’état de sauvegarde reflète la réponse du serveur.

### Un seul système pour commentaires et points techniques

`review_items` porte annotation éventuelle, numéro stable par document, page,
révision, commentaire principal, auteur, responsable facultatif et statut.
`review_messages` porte les réponses ; `review_events` garde les modifications et
anciens contenus dans un historique immuable. Une nouvelle révision possède son
propre espace ; aucun point n’est transféré automatiquement depuis une ancienne.

Les statuts sont ouverte, en cours, en attente de réponse et résolue. Les points
résolus restent consultables, avec filtre pour les masquer. Le panneau propose
filtres de statut/page et vue de la révision actuelle ou de toutes les révisions du
document. Un clic navigue vers la page et l’annotation ; le clic sur une annotation
ouvre son fil. Le panneau peut être masqué. Les listes et historiques sont paginés.

Le responsable est une indication textuelle, pas une attribution de permissions.
Les auteurs utilisent les profils existants et des identifiants distincts ; les
comptes fournisseurs ne sont pas activés. Le serveur vérifie les droits de projet
et réserve la modification d’un commentaire/graphique ou réponse à son auteur.

### Remplacement de pages

Dans la fiche d’un PDF, ouvrir **Remplacer des pages du PDF**. Indiquer par exemple
`4,7`, puis fournir un PDF de deux pages : elles remplaceront les pages 4 et 7 dans
cet ordre. **Préparer l’aperçu**, inspecter la nouvelle version, saisir son numéro,
puis confirmer. L’opération utilise `@cantoo/pdf-lib`, fork maintenu de PDF-lib,
chargé uniquement quand nécessaire. Les dimensions de recadrage et orientations
sont vérifiées ; les écarts supérieurs à 1 point PDF ou orientations différentes
sont refusés avec un message clair. Le nombre de pages de remplacement doit être exact.

Le résultat est reparsé, prévisualisé puis enregistré comme PDF complet dans une
nouvelle révision par le pipeline R2/SHA-256 existant. Les originaux et leurs
annotations ne sont jamais réécrits. Les pages non remplacées sont conservées.
Les PDF chiffrés/invalides sont refusés. Limites : 50 Mio par fichier/résultat,
2 000 pages pour le remplacement ; le traitement et sa mémoire sont côté navigateur.

## Migration et publication : ordre indispensable

Cette session ne dispose pas d’accès connecté à Cloudflare/Vercel. Elle ne modifie
ni la D1 distante ni les fichiers R2 réels. Aucun déploiement de production n’est
lancé. **Appliquer la migration D1 avant de fusionner cette branche**, afin que
les premières requêtes d’annotation trouvent leurs tables.

1. Depuis une machine déjà autorisée, à la racine du dépôt :
   `npx wrangler d1 migrations apply forgebridge-db --remote --config apps/api/wrangler.jsonc`.
   La migration attendue après la phase 2 est **`0004_pdf_review.sql`**.
2. Sans terminal, utiliser **Cloudflare → D1 → forgebridge-db → Console** : copier
   le contenu complet de `apps/api/migrations/0004_pdf_review.sql`, puis Execute
   **une seule fois**. Aucun commentaire SQL n’est placé en tête pour éviter les
   problèmes de collage sur une seule ligne. Après réussite, enregistrer le suivi :
   `INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0004_pdf_review.sql');`.
   Vérifier ensuite `SELECT name FROM d1_migrations ORDER BY id;`.
   En cas d’erreur, diagnostiquer la partie appliquée avant de relancer l’ALTER TABLE.
3. Fusionner ensuite la pull request. Les déploiements Git existants construiront
   les deux parties ; aucune nouvelle configuration Vercel ni clé n’est requise.
4. L’adresse reste `https://forgebridge-api.francbouch.workers.dev/`. Les outils
   apparaissent dans la visionneuse des PDF. `/demo` conserve ses données fictives.

Les anciennes migrations et le script d’initialisation d’une base vide ne sont
**pas** à rejouer. Les bindings `DB`/`DOCUMENTS`, `keep_vars`, la protection Access
et les variables Runtime existantes restent inchangés.

La migration ajoute `documents.review_counter`, un index composite des révisions,
`review_items`, `review_messages`, `review_events`, leurs index et protections
SQL. Aucune table ni donnée métier n’est supprimée. Les numéros ne sont jamais
réattribués après suppression ; les références de révision/page/auteur sont immuables.

## Tests autonomes et preuves

La règle permanente est enregistrée dans `AGENTS.md`. La commande `npm run verify`
exécute types, lint, tests Vitest, builds Vite/Worker, tests de prévisualisation et
parcours privés Chromium. La CI GitHub Actions exécute la même chaîne sur PR et sur
`main`, sans secret Cloudflare et exclusivement avec des stockages locaux isolés.
L’exécution de la CI distante n’est pas supposée réussie avant observation de GitHub.

Les tests d’écriture créent une D1/R2 temporaires, une identité de test signée sur
loopback et leurs propres données. Le nettoyage détruit seulement ces répertoires
isolés. Aucun appel d’écriture de test ne vise l’API de production.

Les rapports machine sont `test-results/preview-results.json` et
`test-results/private-results.json`. En cas d’échec, Playwright conserve capture,
contexte et `trace.zip` dans les sous-dossiers de `test-results/`. La CI les publie
comme artefact pendant sept jours. Lire une trace avec
`npx playwright show-trace <chemin>/trace.zip`.

| Scénarios demandés                                            | Vérification automatisée                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1–6 PDF, page 3, marqueur, commentaire, fermeture/réouverture | Chromium sur PDF réellement importé dans R2 local et assertions D1/API/interface                                                |
| 7 zoom et position                                            | Comparaison du centre normalisé du marqueur, plein écran et rotations ; tests affine/crop/échelles                              |
| 8–10 rectangle, déplacement, persistance                      | Gestes de souris, redimensionnement, une seule écriture par geste, rechargement et comparaison des coordonnées D1               |
| 11–12 flèche et texte                                         | Tracé, édition et présence du texte dans le SVG ; dessin libre et surlignage aussi couverts                                     |
| 13–15 réponse, résolution, filtre                             | Création/édition de réponse, changement de statut, masquage/affichage et navigation réciproque                                  |
| 16–17 nouvelle révision et historique                         | Révision B sans anciens points, retour à A avec points et réponses conservés                                                    |
| 18–20 remplacement de page et originaux                       | Aperçu réel, téléchargement, validation du flux PDF remplacé, autres pages inchangées, nouveaux octets R2 et original identique |
| 21 erreurs de sauvegarde/transfert                            | Échec HTTP injecté, brouillon conservé, nouvelle tentative sans doublon ; coupure réseau des imports dans la régression phase 2 |
| 22 régressions                                                | Création/édition et persistance de projets, dossiers, fichiers, révisions, téléchargements, langues, thèmes, mobile et `/demo`  |

Les tests backend exécutent les routes dans workerd, vérifient les contenus,
la persistance après redémarrage, les refus d’accès et d’édition d’autrui,
les limites de géométrie, les conflits de versions, les numéros historiques et
le rollback intégral si l’écriture de l’historique échoue. Les tests PDF vérifient
les opérateurs et textes réels des flux de pages, pas seulement leur nombre.

Les vérifications distantes restent impossibles sans accès Cloudflare autorisé
et environnement d’écriture isolé. Les résultats locaux ne sont jamais présentés
comme une validation de production. Aucune vérification ordinaire déjà automatisée
n’est déléguée au propriétaire.

## Résultats observés de cette livraison

La commande complète `npm run verify` a terminé avec succès :

- TypeScript strict et ESLint : réussis.
- **47 tests Vitest réussis, 0 échec** (six fichiers de tests).
- **8 scénarios Chromium réussis, 0 échec, 0 ignoré, 0 instable** :
  quatre scénarios de prévisualisation et quatre parcours privés.
- Builds Vite et Worker dry-run : réussis.
- Vérification de données et fichiers conservés après redémarrage local : réussie.
- Console/réseau contrôlés dans les deux scénarios phase 3 ; le seul échec HTTP
  injecté intentionnellement a été compté et sa reprise a été vérifiée.
- Gestes de déplacement/redimensionnement : exactement une écriture par geste,
  malgré plusieurs événements de souris ; une erreur de sauvegarde conserve le
  brouillon et la reprise ne crée pas de doublon.

D1/R2 **locaux de test** : vérifiés. D1/R2 **distants** : non modifiés par cette
livraison ; accès de déploiement et isolation de staging absents. Les tests de
production et l’exécution distante de GitHub Actions ne sont pas annoncés comme
réalisés. Aucun problème fonctionnel bloquant n’est restant dans les parcours testés.
