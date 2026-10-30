# Phase 6 — traduction intégrée et glossaire technique

## Audit de l’existant

Base : `main` dfbf6ae, phase 5 fusionnée. Les messages de projet et leurs réponses
sont dans `conversation_messages`, les points et descriptions PDF dans
`review_items`, les commentaires/réponses PDF dans `review_messages`, les demandes
techniques dans `technical_requests`, les décisions et justifications historiques
dans `approval_requests` et `approval_events`. Les statuts sont des enums rendus
avec les dictionnaires d’interface fr-CA/en/zh-CN. Aucun fournisseur de traduction,
cache ou glossaire technique actif n’existait.

La phase réutilise la passerelle privée, Access, l’identité serveur, les permissions
internes de projet, `Store.write`, audit/outbox et le rendu texte existant. Il n’y a
ni nouveaux comptes ni modification de la visionneuse, des coordonnées ou des PDF.
Le texte graphique directement posé sur le PDF reste hors périmètre.

## Choix du fournisseur et sources officielles

Documentation consultée le 30 octobre 2026 dans les dépôts officiels, accessibles
par le réseau de cet environnement. Aucun prix n’est déduit d’une simulation.

| Solution                                | Compatibilité et qualité à évaluer                                                                                                                                                                      | Coût documenté et limites                                                                                                                                                                                                                                   | Décision                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| DeepL API Free                          | REST JSON utilisable par `fetch` Worker ; FR, EN, ZH-HANS, détection, XML et segments ignorés documentés. Qualité technique réelle à valider sur échantillons humains ; aucune garantie d’exactitude.   | Le README officiel annonce 500 000 caractères/mois gratuits. Éligibilité, conditions et quota du compte doivent être confirmés à l’inscription.                                                                                                             | Adaptateur préparé, désactivé sans configuration. Destination Free fixe, aucun basculement Pro. |
| Workers AI                              | Catalogue officiel : `@cf/meta/m2m100-1.2b`, traduction multilingue comprenant français, anglais et chinois. La fiche ne prouve pas la qualité du chinois simplifié technique. Nécessite un binding AI. | Allocation documentée de 10 000 neurons/jour ; au-delà sur Workers Paid : 0,011 USD/1 000 neurons. La fiche modèle indique 0,342 USD/million de tokens d’entrée et de sortie. Ce ne sont pas des prix par caractère ni une estimation de cette application. | Non activé ; précision technique non comparée par test réel.                                    |
| API LLM généraliste, par exemple OpenAI | API HTTP, SDK officiel compatible Cloudflare Workers. Plus flexible pour des instructions techniques, mais risque de reformulation et coût dépendant du modèle.                                         | Aucun tarif ni crédit gratuit retenu sans vérification du modèle choisi.                                                                                                                                                                                    | Pas de dépendance ni de compte créé ; interface fournisseur interchangeable.                    |

Sources :

- [SDK officiel DeepL, quota Free et options](https://github.com/DeepLcom/deepl-python/blob/main/README.md).
- [Spécification OpenAPI DeepL](https://github.com/DeepL/openapi/blob/main/openapi.json).
- [Langues et capacités DeepL](https://github.com/DeepL/api-docs/blob/main/snippets/language-table.jsx).
- [Traduction XML DeepL](https://github.com/DeepL/api-docs/blob/main/docs/translate/translating-xml.mdx).
- [Confidentialité DeepL et liens contractuels](https://github.com/DeepL/api-docs/blob/main/docs/resources/privacy.mdx).
- [Catalogue officiel M2M100 Cloudflare](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/workers-ai-models/m2m100-1.2b.json).
- [Tarification Workers AI](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/workers-ai/platform/pricing.mdx).
- [SDK OpenAI et plateformes compatibles](https://github.com/openai/openai-node).

Les textes sont transmis à un tiers uniquement à la demande explicite. Seul le
champ choisi, avec ses marqueurs techniques, est envoyé : aucun PDF, fichier,
profil, identifiant de projet, discussion complète ou glossaire complet. Les termes
pertinents sont substitués localement ; leurs définitions et notes ne sont pas
transmises. La documentation DeepL avertit que le traitement peut différer entre
Free et Pro. Aucune garantie de non-conservation, de non-entraînement ou de
résidence des données n’est établie ici pour Free. Vérifier les conditions du compte
avant d’y transmettre des informations industrielles confidentielles. Le choix
préparé convient à une évaluation économique avec des textes non confidentiels ;
une exigence contractuelle différente peut nécessiter un autre fournisseur.

## Fonctionnement

Un seul `TranslatedText` est utilisé dans les messages et réponses, titres et
descriptions de points, commentaires PDF, titres/descriptions de demandes et
descriptions/justifications d’approbation, y compris les motifs historiques de
refus, modification ou annulation. Aucune traduction automatique au chargement.
Les statuts restent des traductions d’interface. Le bouton ouvre des commandes
compactes : source auto ou explicite, cible, traduction, original, copie, correction
et retraduction. Une seule cible est affichée. La langue cible est une préférence
locale distincte de la langue de l’interface. Toute modification de source/cible
retire immédiatement l’ancien résultat de l’affichage courant.

Le backend accepte une référence typée au contenu, pas un texte arbitraire du
navigateur. Il retrouve le texte original et revérifie les permissions de projet,
l’auteur des messages privés, la disponibilité du contenu et les brouillons
d’approbation à chaque génération, lecture de cache ou correction. Les endpoints
restent derrière les contrôles existants d’identité, origine et fréquence. Les
clés ne sont jamais incluses dans le code web ni dans la configuration renvoyée.

`TranslationProvider` permet de remplacer DeepL sans dupliquer la logique métier.
Le fournisseur courant utilise exclusivement `api-free.deepl.com/v2/translate`,
avec délai de 15 secondes, sans redirection ni nouvelle tentative automatique.
Une erreur conserve la lecture de l’original et ne remplit pas le cache.

### Préservation technique

Extraction et protection des nombres, dimensions et unités courantes, tolérances,
filetages, codes de pièces/matériaux/normes et références de révision. Les segments
protégés sont remplacés par des marqueurs uniques dans des balises XML `keep`
ignorées par DeepL, puis restaurés exactement. Les termes de glossaire pertinents,
ajoutés par l’administrateur, utilisent le même mécanisme avec leur équivalent cible.
Les correspondances les plus longues priment ; elles ne se chevauchent pas.

Vérifications après traduction : présence unique de chaque marqueur et comparaison
des expressions critiques, quantités et multiplicités avec l’original. Une différence
produit un avertissement enregistré, tout en conservant le résultat pour examen.
La même comparaison s’applique aux corrections manuelles. Cette vérification ne
couvre pas toutes les notations techniques ni le sens linguistique : revue humaine
recommandée pour toute traduction, même en l’absence d’avertissement. Une traduction
ne change jamais une décision officielle et ne crée aucune approbation.

### Cache, historique et limites

Migration additive `0008_integrated_translations.sql` : glossaire par organisation,
générations immuables, corrections append-only, verrous courts et compteurs de
consommation. Le modèle réserve une portée projet pour une phase ultérieure.
Aucun terme n’est prérempli ou présenté comme vérifié automatiquement.

Clé de cache : organisation, type/identifiant/champ de source, SHA-256 du texte,
langue source (ou auto), cible, version du fournisseur, instructions et empreinte
des seuls termes pertinents. Une modification de texte, de source linguistique ou
d’un terme pertinent rend l’ancien résultat inéligible. Les anciennes générations
restent conservées. Les corrections préservent texte machine, original, auteur
logique, date et version ; une correction ne se propage jamais à une autre source.
Retraduire crée une nouvelle génération sans effacer la précédente.

Verrou D1 contre les doubles appels simultanés pour la même clé, avec seconde
lecture du cache après acquisition. Réservation atomique du budget avant l’appel ;
les erreurs et délais comptent comme tentatives. Les hits de cache ne consomment
pas de nouveau budget fournisseur et fonctionnent même si le service est désactivé.
Limites par défaut : 8 000 caractères source, 16 000 résultat, 30 termes pertinents,
100 tentatives et 10 000 caractères protégés par jour UTC et par organisation,
5 tentatives/minute par acteur. La longueur protégée, marqueurs inclus, est comptée
par prudence. Ces limites ne remplacent pas le quota mensuel du compte DeepL partagé.
Au-delà du quota Free, l’erreur est affichée ; aucun abonnement n’est activé.

Glossaire : ajout/modification/suppression logique réservés au propriétaire,
recherche, filtre par domaine exact, pagination de 30 éléments, version optimiste
et audit. La recherche et la sélection des termes utilisent une casse Unicode
normalisée côté Worker, y compris « Épaisseur / épaisseur », car `lower()` SQLite
ne traite pas les accents. Les traductions et corrections existantes restent préservées.

## Configuration indispensable avant un essai réel

Aucune clé de traduction n’est disponible dans cet environnement. Aucun appel à
un fournisseur réel, abonnement ou paiement n’a donc été effectué.

1. Choisir/créer un compte **DeepL API Free**, vérifier ses conditions de traitement
   pour les textes envisagés et son quota. Ne pas confondre l’offre API avec le
   traducteur web. Ne pas fournir la clé dans le chat ou une variable Vite.
2. Dans **le Worker forgebridge-api uniquement**, ajouter le secret serveur
   `DEEPL_API_KEY` (via le tableau de bord ou `wrangler secret put DEEPL_API_KEY`).
3. Après migration 0008 et publication du Worker, ajouter la variable serveur
   `TRANSLATION_ENABLED=true` lorsque l’activation est voulue. Sans elle ou sans clé, les originaux restent lisibles et les nouvelles
   traductions renvoient une erreur explicite de configuration. Pour désactiver,
   définir `TRANSLATION_ENABLED=false` ; ne pas effacer D1.
4. Facultatif : `TRANSLATION_DAILY_REQUESTS` (défaut 100, maximum 1 000),
   `TRANSLATION_DAILY_CHARACTERS` (défaut 10 000, maximum 500 000) et
   `TRANSLATION_PER_MINUTE` (défaut 5, maximum 30). Une valeur invalide conserve le
   défaut. Garder des plafonds adaptés au quota mensuel partagé.
5. Après fusion par le propriétaire, appliquer 0008 avec le contrôle D1 existant,
   avant publication du Worker. Le workflow intégré respecte cette dépendance ;
   un build Cloudflare indépendant doit aussi appeler le contrôle avant de publier.
6. Effectuer ensuite un petit essai réel non confidentiel et faire valider les termes
   par une personne compétente. Les tests simulés ne mesurent pas la qualité DeepL.

`keep_vars` existant reste inchangé ; aucun secret, binding Access/R2 ou service
payant n’est ajouté par le dépôt. Pour un essai local réel, les secrets et variables
peuvent être placés dans `.dev.vars` ignoré par Git. Ne jamais activer le fournisseur
simulé dans le Worker : il existe uniquement dans les fixtures de test.

## Validation

`npm run verify` a réussi : TypeScript, ESLint, **90 tests Vitest dans 9 fichiers**,
build web, build Worker, **4 parcours preview et 17 parcours privés** (21 parcours
navigateur). La phase ajoute 12 tests backend et 4 parcours navigateur. La suite complète a été rejouée après le contrôle des accents français du glossaire. Les tests utilisent des textes
non confidentiels, D1/R2 locaux isolés et un transport fournisseur déterministe situé
dans `tests/helpers/translation-provider.ts`. Il exerce le véritable adaptateur
DeepL sans aucune connexion externe. Ces résultats ne sont pas des traductions IA
réelles. Les originaux, dessins, références, décisions et octets R2 sont comparés
avant/après. Les traces des échecs intermédiaires sont conservées sous `/tmp` dans
l’espace de travail.

Les 20 cas demandés sont couverts comme suit :

| Cas                                   | Preuve automatisée                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–3 : FR → EN, FR → ZH-CN, ZH → FR    | Backend et parcours messages, réponses déterministes du transport simulé.                                                                               |
| 4–5 : original et changement de cible | Parcours messages : retour à l’original, nouvelle cible, ancienne traduction retirée.                                                                   |
| 6–7 : cache et source modifiée        | Backend : un seul appel budgété, cache et correction après redémarrage D1 ; navigateur : rechargement, édition réelle du message et résultat recalculé. |
| 8–10 : commentaire PDF, point, refus  | Backend et parcours PDF/demande/décision, avec comparaison des sources, décisions et octets R2.                                                         |
| 11–12 : glossaire et correction       | CRUD et recherche du glossaire via interface réelle ; correction, copie, auteur, date, texte machine conservé et conflits de version.                   |
| 13 : persistance D1                   | Redémarrage du runtime sur le même stockage local puis récupération du même cache.                                                                      |
| 14–16 : nombres, unités, références   | Exemple complet, multiplicités, marques protégées, simulation d’un marqueur altéré et correction numérique suspecte.                                    |
| 17 : panne fournisseur                | Erreurs HTTP, quota, JSON invalide, absence de cache d’erreur et original toujours lisible dans le navigateur.                                          |
| 18 : secrets                          | Configuration retournée sans clé ; vérification que les bundles web ne contiennent ni clé de fixture, nom de secret ni transport simulé.                |
| 19 : limites                          | Backend : seuils minute/jour/caractères, réservation atomique, concurrence et cache sans nouvel appel.                                                  |
| 20 : régression                       | Suite complète des phases précédentes, y compris documents, dessins, références, messagerie et approbations.                                            |

Les **10 tests Python D1** et l’intégration Wrangler locale ont réussi : baseline
console et 0004 manuelle reconnus, seules les migrations manquantes jusqu’à 0008
appliquées, clés étrangères et intégrité vérifiées, deuxième passage inchangé.
Aucune initialisation distante ni réécriture du mécanisme de migration.

La capture mobile a été examinée. Les échecs intermédiaires ont permis d’ajouter
des libellés explicites accessibles aux contrôles de langue et de correction ; les
fixtures ont été alignées sur les endpoints existants. Les quatre parcours et la
suite complète ont ensuite réussi. Les avertissements existants de taille de
chunks et de directives de dépendances n’empêchent pas les builds.

État distant : **0008 non appliquée en production**, aucun bucket ni document
R2 distant modifié, aucun service réel activé et aucune fusion effectuée.
Le fonctionnement applicatif a été testé avec le fournisseur simulé uniquement ;
la qualité linguistique et la connexion d’un vrai compte restent à évaluer après
les étapes de configuration ci-dessus. Les aperçus automatiques de PR utilisent
la configuration privée existante et ne constituent pas une validation réelle de
DeepL avant cette activation.
