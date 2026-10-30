# Dessins et points techniques indépendants

Les dessins libres utilisent `graphical_annotations`. Une création ou un déplacement ne crée ni point ni discussion et ne touche pas `documents.review_counter`. Les coordonnées restent normalisées par page et révision ; les fichiers R2 ne sont pas modifiés.

Les véritables points restent dans `review_items` avec `is_point=1`, un titre, une description, un statut, un état draft/published et un historique append-only. Un point reçoit son numéro interne stable à sa création ; l'interface affiche le numéro public uniquement après publication. Les numéros réservés, y compris ceux des brouillons supprimés et des anciennes annotations, ne sont jamais réutilisés. L'incrément et la création sont dans la même transaction D1.

`graphical_annotations.point_id` est nullable : une annotation appartient au maximum à un point. La création d'un point avec une sélection et les associations multiples sont atomiques. Les triggers refusent les associations entre documents ou révisions différents. Les versions empêchent un chargement ancien d'écraser une modification récente. Une association conserve l'UUID et la géométrie du dessin. Le détachement ne supprime aucun point.

## Utilisation

Dessiner avec les outils habituels. Le panneau Annotations permet l'édition du texte et de la couleur, la suppression, la sélection multiple (Ctrl/clic ou Cmd/clic), la sélection des dessins chargés de la page et le détachement. La section « Créer un point technique » crée explicitement un brouillon, avec les annotations sélectionnées ou sans annotation. Un dessin déjà lié doit être détaché avant de créer un autre point depuis la sélection. L'association à un point existant est disponible dans l'onglet Annotations.

Le panneau Points techniques propose les filtres publication/statut et toutes les révisions. Chaque fiche indique titre, état, révision, pages, auteur/date et compteurs. Un point ouvre son fil et sa révision/page ; les dessins liés sont mis en évidence. Supprimer un dessin lié conserve le point et les messages. Supprimer un brouillon le retire de la liste et détache ses dessins ; ses références internes sont conservées. Un point publié ne peut être supprimé : il peut être annulé avec confirmation et historique.

L'état Brouillon n'est pas présenté comme une garantie de confidentialité fournisseur. Les routes de review restent limitées aux administrateurs de projet/propriétaires par les contrôles serveur existants. Aucune nouvelle authentification fournisseur n'est activée. Une future ouverture des permissions devra explicitement filtrer les publications, les dessins libres et les associations ; ne pas ouvrir globalement ces routes aux fournisseurs.

## Migration non destructive et ordre de livraison

Appliquer `apps/api/migrations/0005_separate_annotations.sql` avant de publier le nouveau Worker et le frontend compatible. L'ancienne migration 0004 doit déjà être entièrement présente. Ne jamais rejouer aveuglément une migration partielle : inspecter les colonnes/tables avant toute reprise. Les migrations manuellement exécutées doivent être enregistrées dans `d1_migrations` après vérification complète afin que Wrangler ne tente pas de répéter les ALTER TABLE.

La migration 0005 ajoute des colonnes et une table ; elle ne supprime ni ne reconstruit de table. Elle copie tous les anciens objets graphiques avec leurs UUID, coordonnées, couleurs, textes, auteurs, dates, versions et marqueurs de suppression. Les anciennes lignes et tous leurs événements/messages restent intacts.

Un ancien enregistrement comportant une discussion, une description de suivi, un responsable, un statut différent de ouvert, des messages ou des échanges significatifs dans l'historique reste un point **brouillon à examiner**, jamais publié automatiquement. Son dessin est lié au même point quand il existe encore. Les anciens dessins sans ces signaux deviennent des dessins libres ; leur ancienne ligne historique est conservée mais ne pollue plus la liste active des points. Les anciens dessins supprimés sans contenu de suivi restent supprimés et n'affichent plus de fiche fantôme. Les cas ambigus sont conservés pour examen humain ; aucune décision industrielle n'est déduite du tracé ou du texte graphique seul.

La migration a un test sur une copie locale peuplée au schéma 0004 : comparaison de toutes les anciennes colonnes, messages et événements, conservation des numéros et compteur, vérification du classement et des liens. Les tests ne touchent jamais la D1 ni le R2 de production.

## Limites de publication

Sans jeton Cloudflare disponible dans l'environnement, cette livraison prépare et teste la migration localement mais ne l'applique pas à la base distante. Ne pas fusionner avant la préparation de la migration distante : les déploiements automatiques ne doivent pas exposer le nouveau code avec l'ancien schéma. Aucun nouveau lien de production n'est revendiqué avant déploiement. L'adresse d'entrée de production reste le Worker protégé existant.

## Validation de livraison

`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify` : 50 tests Vitest (dont API/D1/R2 et migration peuplée), 4 tests Playwright de prévisualisation et 7 scénarios Playwright privés. Les scénarios couvrent les dessins libres, texte/couleur/déplacement/redimensionnement, Ctrl-sélection, un point pour trois dessins, commentaire, détachement, suppression liée/libre, publication/numéro/annulation, suppression de brouillon, rechargement, A/B/C/D, réponses et changements rapides, échec/reprise d'enregistrement et remplacement de pages. Le test API de sélection associe et détache 100 dessins ; les opérations acceptent au maximum 100 annotations par requête (plusieurs opérations peuvent viser le même point). Les listes sont paginées ; le bouton de sélection vise les dessins déjà chargés.

Types, ESLint, build Vercel/frontend et compilation Worker dry-run sont inclus. Les anciens tests supposant un point créé automatiquement par dessin ont été remplacés par les scénarios de séparation ; les régressions révisions, géométrie, accès, documents et remplacement PDF restent vérifiées. Le journal de la suite finale est `/tmp/forgebridge-separation-release-verify.log`. Les échecs initiaux de navigateur sont conservés dans `/tmp/forgebridge-separation-failure-2` (données exclusivement fictives). Aucune vérification de production n'est revendiquée.
