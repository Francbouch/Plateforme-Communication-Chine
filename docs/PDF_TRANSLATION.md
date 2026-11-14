# Traduction des notes de mises en plan PDF

## Architecture et audit de l’existant

La visionneuse existante utilise **PDF.js 6.4.299** : canvas, chargement par plages,
polices/CMaps/worker servis depuis ForgeBridge. Elle reste en place. Les annotations
utilisent les coordonnées normalisées du crop box PDF non tourné, puis la matrice
à six composantes du viewport pour le zoom, la rotation et le redimensionnement.
Le nouveau module réutilise cette même matrice, y compris la rotation intrinsèque
PDF ; aucun recalcul ou déplacement des annotations historiques.

Les documents et révisions sont déjà persistés en D1 ; les originaux immuables
sont dans R2 privé. Les permissions de la phase 7 portent sur le projet, le
statut du profil et le **partage de la révision exacte**. La phase 6 fournit déjà
DeepL API Free, un adaptateur interchangeable, le glossaire et les quotas D1.
Ces services sont réutilisés, sans nouvelle dépendance ni Supabase.

Prototype livré : [mise en plan synthétique](fixtures/synthetic-technical-drawing.pdf),
produite par `tests/helpers/technical-pdf.ts`, avec notes anglaises, cotes, tolérances,
cartouche, textes verticaux/inclinés, page française, page sans texte et page
intrinsèquement tournée. C’est une simulation de mise en plan industrielle, **pas
un export SolidWorks réel validé**. Aucun document industriel réel n’a servi aux tests.

## Fonctionnement dans la visionneuse

1. Sélectionner la **Langue du document** : Original, English, Français ou 中文 (简体).
2. Seule la page consultée est extraite avec `PDFPageProxy.getTextContent()`.
   Les fragments adjacents, collinéaires et de taille proche sont regroupés ; les
   colonnes et les lignes différentes restent séparées pour préserver le dessin.
3. Les traductions enregistrées sont affichées sans appel au fournisseur. La
   détection locale est prudente : une note ambiguë reste « langue incertaine »
   jusqu’à choix manuel de la langue source. Les codes/cotes isolés sont exclus.
4. Pour générer les notes manquantes, cocher l’autorisation explicite puis cliquer
   **Traduire les notes manquantes**. Seul le texte nécessaire est transmis,
   jamais le PDF, une image ou ses coordonnées. Progression et erreurs sont
   indépendantes de la consultation du dessin ; Original reste immédiatement accessible.
5. Les repères transparents suivent les positions, le zoom, la rotation et le
   défilement. Le panneau latéral conserve original, traduction et statut lisibles.
   Des étiquettes transparentes peuvent être activées ; une traduction longue
   conserve un repère et son texte complet dans le panneau.
6. L’interaction directe avec les repères est volontairement optionnelle et limitée
   à l’outil Sélection. Les outils d’annotation gardent les événements du dessin.
   Les flèches de repositionnement du panneau enregistrent **le décalage personnel
   du repère**, sans toucher au PDF, aux cotes ou aux annotations.

Aucun rectangle opaque et aucun masquage automatique ne sont utilisés : le
rendu d’un texte sélectionnable ne prouve pas qu’une zone peut être effacée sans
masquer une ligne, une flèche ou une tolérance. Le panneau est le repli sûr.
La fonctionnalité n’exporte pas de « PDF traduit » et ne modifie aucun octet R2.

## Extraction et confiance

Chaque segment conserve texte, page, ancrage X/Y normalisé, largeur/hauteur,
angle, taille approximative, transformation PDF et ordre de lecture. Son ID est
le SHA-256 de la version de l’algorithme, de la révision/checksum source, de la
page, du texte **et** de sa géométrie. Les positions d’une autre révision ne sont
jamais recopiées.

L’extraction est faite dans le navigateur déjà autorisé à lire le PDF. Le serveur
traite ces valeurs comme une entrée non fiable : schéma strict, tailles et
coordonnées bornées, empreinte recalculée et contenu enregistré immuable. Chaque
lecteur refait l’extraction locale et demande les seules empreintes correspondantes.
Une extraction forgée avec un autre texte ou d’autres positions ne peut donc pas
remplacer celle normalement affichée par les autres lecteurs. Cela **n’est pas
une certification serveur** que le texte soumis existe dans les octets PDF ; un
client autorisé peut soumettre une extraction différente, bornée et soumise aux
quotas. Une validation d’extraction dans un environnement PDF isolé côté serveur
est une évolution possible si une telle certification est nécessaire.

Limites initiales : 10 000 fragments examinés, 200 notes par page, 600 caractères
par segment. Un avertissement indique la limite des 200 notes. Les paragraphes
multilignes restent des lignes indépendantes ; les ligatures, fontes atypiques,
textes vectorisés, tableaux serrés et anciens encodages peuvent nécessiter une
lecture de l’original. Aucun OCR automatique ni faux texte n’est créé.

## Intégrité technique et moteur

Les valeurs techniques sont remplacées par des jetons avant DeepL, puis restaurées
et vérifiées : nombres/signes, tolérances, diamètres, pas métriques, fractions,
filetages UNC/UNF, références ISO/AISI/etc., identifiants et noms de fichiers.
Aucune conversion d’unité, aucun arrondi, aucun reformatage des valeurs.
Les unités protégées restent exactes. Un jeton manquant/dupliqué ou une différence
technique bloque l’affichage automatique sur le dessin. L’original reste visible.
Les corrections manuelles qui changent ces valeurs sont refusées.

Le moteur reste `TranslationProvider` / `DeepLFreeProvider`, via `fetch` vers
`https://api-free.deepl.com/v2/translate`, avec protection XML et timeout existants.
La sélection du fournisseur passe par la factory du Worker, pas par une URL
fournie par le navigateur. Un autre adaptateur pourra remplacer DeepL ; son nom
et le texte de consentement devront alors être mis à jour explicitement.

**Confidentialité** : les notes manquantes sont des données industrielles
transmises à DeepL après l’action explicite d’un utilisateur ayant la permission
`translate`. Vérifier l’offre API Free, le contrat et les règles internes avant
usage réel : [protection des données DeepL](https://www.deepl.com/privacy),
[documentation API](https://developers.deepl.com/docs).
Ne pas présumer que les conditions du traducteur Web et celles de l’API sont
identiques, ni promettre une absence de conservation sans validation contractuelle.
Aucune transmission réelle à DeepL n’a été faite pendant ce développement.

## Glossaire, couches et corrections

- La couche **interne** peut utiliser le glossaire privé existant de l’organisation.
- La couche **partagée** utilise un cache distinct, sans glossaire privé. Seuls
  les utilisateurs autorisés sur la révision la consultent ; un fournisseur ne
  peut pas demander la couche interne en falsifiant le paramètre d’audience.
- Un fournisseur avec `correct_translations` peut proposer une correction. Le
  rôle lecteur ne peut pas corriger. Une proposition ne remplace pas le texte
  officiel. Seul un utilisateur interne ayant cette permission peut vérifier
  directement ou approuver/refuser une proposition. **Actualiser les notes**
  relit le cache sans appel externe.
- Le texte automatique initial reste conservé. L’historique montre texte corrigé,
  auteur/date et validation ; corrections et décisions sont append-only. Les
  conflits de version sont refusés, sans remplacement silencieux.
- Un changement de glossaire invalide les résultats automatiques concernés ;
  une correction vérifiée reste prioritaire, même sur une génération ultérieure.
- Un texte approuvé peut être réutilisé sur une nouvelle révision du **même
  document**, avec original/langues/audience identiques, uniquement si l’utilisateur
  a aussi accès à la révision source. Aucune nouvelle facturation de traduction.
  L’origine est conservée dans `reused_from`, la géométrie est celle nouvellement
  extraite et le résultat redevient **à vérifier dans le nouveau contexte** :
  la validation de l’ancienne révision n’est pas héritée automatiquement.

## Stockage et migration

`0011_pdf_translations.sql` ajoute exclusivement :

| Table                         | Contenu                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pdf_text_segments`           | Révision/page, original, géométrie et version d’extraction immuables.                                          |
| `pdf_translations`            | Langues, audience, machine, avertissements, fournisseur, clé de cache, glossaire, provenance de réutilisation. |
| `pdf_translation_corrections` | Texte corrigé, version, auteur, date, vérification directe.                                                    |
| `pdf_translation_reviews`     | Approbation/refus et identité/date du vérificateur.                                                            |
| `pdf_translation_positions`   | Décalages personnels des repères.                                                                              |

Les tables de verrouillage et de quotas de traduction existantes sont réutilisées.
Aucune table de documents, révision, approbation ou annotation n’est réécrite.
Aucun objet R2 n’est copié, supprimé ou modifié.

Appliquer les migrations dans l’ordre avec le runner existant, après sauvegarde
et validation appropriées : [D1_AUTOMATION.md](D1_AUTOMATION.md).
Les gardes de revue de la phase 7 et de 0010 restent intactes. Si elles bloquent,
**ne pas les contourner**. Ajouter les tables 0010 n’exige pas d’activer le courriel :
`EMAIL_AUTH_ENABLED` reste désactivé et la configuration Resend reste en pause.
Le code PDF n’appelle pas ses nouvelles tables tant que la traduction n’est pas
sélectionnée ; un schéma non migré affiche un message dédié sans bloquer le PDF.
Aucune migration distante ou publication en production n’a été exécutée ici.

## Permissions, performances et coûts

Chaque lookup, génération, historique, correction, décision et décalage vérifie
à nouveau le profil, le projet et la révision exacte. La permission de traduction
est distincte de la simple lecture. Après retrait d’un partage, les accès directs
au cache et à R2 sont refusés. Comme pour tout document déjà téléchargé, une
révocation ne peut pas effacer les octets déjà reçus dans un navigateur.

L’extraction ne concerne que la page ouverte et n’est pas exécutée en mode
Original. Les lectures de cache sont en lots bornés de six segments, avec état
des corrections agrégé pour limiter les appels D1. Aucun PDF.js supplémentaire
n’est exécuté dans le Worker. Les changements rapides de page/langue/révision
écartent les résultats tardifs ; un appel déjà envoyé peut finir sur sa révision
initiale, sans être affiché ailleurs. Aucun texte technique dans les logs.

Les quotas existants restent communs aux messages et notes PDF : par défaut
100 requêtes/jour/organisation, 10 000 caractères/jour/organisation et 5 appels
externes/minute/utilisateur, configurables dans les plafonds déjà prévus. Les
résultats en cache et les réutilisations approuvées ne sont pas facturés à ces
quotas. Un verrou évite les doublons concurrents. Les pages riches peuvent
atteindre le quota ; reprendre plus tard conserve les résultats déjà enregistrés.

Configuration existante nécessaire à la génération : `TRANSLATION_ENABLED=true`,
secret Worker `DEEPL_API_KEY` API Free et quotas `TRANSLATION_*` appropriés.
Aucun abonnement ni nouveau service payant n’a été activé. Les limites du plan
DeepL et les opérations D1 restent applicables ; aucun coût nul garanti.
Les appels fournisseur sont côté serveur : aucun Google/CAPTCHA/CDN supplémentaire
côté navigateur. L’accessibilité réelle de ForgeBridge et la qualité technique
FR/EN/zh-CN depuis la Chine restent à vérifier lors d’un pilote autorisé.

## Validation et évolutions

Tests reproductibles : `npm run verify`, tests Python du runner et
`python3 scripts/d1/integration.py`. Les scénarios PDF utilisent Workerd, D1/R2
isolés et un transport DeepL simulé, ainsi que la vraie interface compilée dans
Chromium. Ils vérifient les orientations, positions, zoom/redimensionnement,
annotations réellement sauvegardées, checksum de l’original, langue/page/révision,
cache, propositions/validation, glossaire privé, accès fournisseur et révocations.
Les captures de la disposition et des rotations ont été inspectées ; elles ne
prouvent pas une correspondance parfaite sur tous les exports industriels.
L’intégration de restauration conserve aussi les traductions/corrections et
vérifie le trigger d’immutabilité après import dans une base locale distincte.

Pour une version avancée : pilote sur exports SolidWorks réels, regroupement
multiligne adapté aux cartouches, reconnaissance des zones libres autour des cotes,
OCR optionnel avec autorisation/coûts explicites, validation serveur de l’extraction,
polices complexes et rétention bornée des données techniques de cache. L’effacement
de texte et l’export d’un PDF traduit demanderaient une validation séparée ; ils
ne font pas partie de cette couche réversible.
