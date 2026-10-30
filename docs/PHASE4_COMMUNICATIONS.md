# Phase 4 — communications de projet

## Audit et intégration

Base : `main` dc396d9, phases documentaires et annotations indépendantes déjà
présentes. D1 contient profils/identités, organisations, permissions de projet,
bibliothèque, révisions immuables, points techniques, discussions `review_messages`
et audit append-only. R2 utilise le binding privé `DOCUMENTS`. La passerelle valide
Cloudflare Access, l'identité administrateur configurée, l'origine et les droits
serveur. Ces protections et la configuration Wrangler sont conservées.

La phase 4 ajoute des conversations internes de projet, sans reconstruire la
bibliothèque ni déplacer les discussions de points. Les deux vues utilisent le
même rendu de texte `MessageBody`. Le sélecteur réutilise les endpoints de documents,
révisions et points ; les liens ouvrent le `DocumentViewer` existant. Les demandes
peuvent référencer un point existant sans créer d'annotation ni de point en double.

Le contrôle de migration précédemment préparé est repris et étendu à 0006. Il
reconnaît les schémas exacts des baselines CLI et console historique et ne rejoue
pas 0004 manuelle. La publication de cette configuration d'environnement cloud
n'a pas fusionné ce code dans `main` ; la PR contient donc aussi ce contrôle.

## Modèle et règles

Migration **additive 0006**, après 0005 : conversations, messages, références,
pièces jointes, demandes techniques et historique de communication. Aucune table
existante n'est supprimée ou réinitialisée. Chaque auteur est un vrai profil
résolu côté serveur, jamais un identifiant administrateur fourni par le navigateur.
Les écritures D1 utilisent des batches atomiques avec audit/outbox ; modifications
et suppressions vérifient une version pour refuser les écrasements concurrents.

- Conversations libres : création, renommage, archive/restauration et consultation.
  Une archive conserve tout et interdit les nouveaux messages/fichiers/modifications.
- Messages privés à leur auteur par défaut. « Marquer comme partagé » les rend
  lisibles aux administrateurs de projet autorisés et interdit de les supprimer
  ou de les rendre privés à nouveau. Cela n'envoie rien à un fournisseur.
- Les modifications conservent leur état précédent dans un historique append-only.
  La suppression privée est logique et tracée. Les messages sources d'une demande,
  les messages partagés et les racines avec réponses ne peuvent pas être supprimés.
- Réponses : un seul niveau, racine et réponses paginées séparément. Les conversations
  restent internes aux rôles owner/project_admin ; aucun accès fournisseur activé.
- Références : identifiants stables, projet courant validé côté serveur, révision
  explicite, page PDF et point facultatifs. Aucun fallback vers une révision récente
  si la référence échoue. Les pages PDF inexistantes affichent une erreur du viewer.
- Demandes : une seule par message source et un seul lien de demande par point,
  responsable libre facultatif, échéance, quatre priorités et cinq statuts.
  La modification d'une demande ne change pas automatiquement le statut du point.
- Pas de faux messages, comptes fournisseurs, notifications envoyées ni indicateur
  non-lu inventé. Les identifiants auteur/projet, parent, dates, versions et outbox
  constituent les fondations des futures permissions, lectures et notifications.
  L'activation des fournisseurs/lectures sera une étape distincte avec autorisation.

## Fichiers et performances

Référencer un document existant ne crée aucun objet R2. Si un fichier local a
le même SHA-256 et la même taille qu’une révision du projet, le transfert est
refusé avant réservation et le sélecteur invite à choisir explicitement la
référence ; aucune autre révision n’est choisie silencieusement. Les nouveaux fichiers
reçoivent un identifiant serveur et une clé sous le préfixe de leur organisation,
projet et conversation. Aucun nom de clé arbitraire accepté. Taille maximale :
10 Mio, cinq fichiers et huit références par message. Formats documentaires
existants ; les téléchargements techniques restent des pièces jointes.

Le transfert affiche sa progression, vérifie taille/SHA-256 côté R2 et signatures
usuelles PDF/images/ZIP avant finalisation. Les autorisations sont revérifiées au
téléchargement, sans URL publique ni redirection R2 ; `private,no-store`, `nosniff`
et CSP isolée. Prévisualisation images/PDF uniquement à la demande. Ce contrôle
n'est pas un antivirus ; aucun fichier actif HTML/SVG n'est accepté.

Les uploads non envoyés sont visibles et annulables, y compris après rechargement
et archivage. Seuls les objets explicitement réservés par l'auteur et non attachés
peuvent être supprimés. Les objets attachés restent préservés. Les réservations
expirent après 24 h et doivent être annulées si abandonnées ; aucun balayage global
R2 ni règle lifecycle appliqué au bucket existant. Limite de 20 transferts non
terminés par auteur/projet pour maîtriser l'accumulation.

Les huit références possibles d’un message sont validées dans une seule requête
D1, afin de limiter les lectures et respecter le budget par invocation même avec
cinq pièces jointes.

Messages et réponses : pages de 30 avec curseur `(created_at,id)`, sans charger le
fil complet. Conversations, recherche et demandes : pages de 30, filtres côté
serveur, index de projet/activité, parent, référence, statut/priorité et historique.
Actualisation manuelle, aucun polling ni infrastructure temps réel.
La recherche contient mot/expression, titre de conversation et références actuelles.
`instr` est utilisé dans le périmètre du projet pour respecter les sous-chaînes en
français et chinois. FTS5 n'est pas ajouté sans volumétrie justifiant son coût et
sans définir une tokenisation chinoise adaptée ; la recherche contient peut scanner
les messages du projet. Les comparaisons `lower` SQLite ne replient pas toutes les
majuscules Unicode. Prévoir un index FTS dédié si cette volumétrie devient élevée.

## Exécution et déploiement

Depuis la racine :

```sh
npm ci
npm run verify
python3 -m unittest discover -s scripts/d1 -p 'test_*.py' -v
python3 scripts/d1/integration.py
```

Les tests D1/R2 utilisent des bases et buckets locaux éphémères. Les tests navigateur
compilent et ouvrent la vraie interface via la passerelle privée de test, avec JWT
signés éphémères. Aucun endpoint de test ou bypass d'authentification en production.

Le workflow de migration valide le même SHA, reconnaît les migrations manuelles,
applique uniquement les manquantes, puis contrôle schéma/journal/intégrité avant
le déploiement optionnel. Voir [D1_AUTOMATION.md](D1_AUTOMATION.md). L'ordre requis
est 0001/0002 → 0003 → 0004 → 0005 → 0006. Si 0005 apparaît dans le schéma sans
journal, le workflow bloque pour audit des données de backfill.

La fusion de la PR reste au propriétaire. Aucun déploiement distant ni modification
de configuration Cloudflare/Vercel/Access n'est effectué par cette phase. Un build
externe doit utiliser la commande de migration contrôlée avant `wrangler deploy` ;
un déploiement indépendant n'attend pas automatiquement GitHub Actions.

## Rapport automatisé — 30 octobre 2026

Validation finale complète `npm run verify`, code de sortie 0 :

| Contrôle                           | Résultat                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| TypeScript et ESLint               | Réussis                                                                                                   |
| Vitest, 7 fichiers                 | **64/64 réussis**, dont 14 tests de communications                                                        |
| Build Vite et build Worker dry-run | Réussis ; avertissement de taille des chunks PDF non bloquant                                             |
| Playwright preview existant        | **4/4 réussis**                                                                                           |
| Playwright privé D1/R2 réel local  | **10/10 réussis**, dont 3 parcours complets de phase 4                                                    |
| Contrôle de migration Python       | **10/10 réussis**                                                                                         |
| Intégration CLI Wrangler isolée    | Réussie : baseline console, 0004 manuelle, 0005/0006 manquantes, préservation et réexécution sans rejouer |

Les parcours phase 4 regroupent les 21 contrôles demandés : conversation créée,
message envoyé, lecture D1 par API, rechargement, persistance, réponse, modification,
archivage, seconde conversation, isolation, référence documentaire, ouverture,
révision A conservée malgré B, page PDF 2, point technique existant sélectionné,
pièce jointe importée et téléchargée avec comparaison des octets, demande créée
sur le message lié à ce point, statut modifié et conservé, recherche de réponse et
ouverture du bon fil, erreur 503 simulée avec brouillon conservé, suppression privée
tracée et toutes les régressions des phases précédentes.

Vérifications supplémentaires : SHA-256 et signature, refus d'une copie locale
identique à une révision de bibliothèque avant réservation R2, pièce jointe visible
uniquement après envoi, annulation d'un transfert expiré sur conversation archivée,
rejet des références interprojet et des réponses imbriquées, absence de doublons de
demandes/points, refus des versions périmées, permissions révoquées et auteurs
étrangers, pagination sans chevauchement à dates identiques, reprise d'envoi sans
double message/historique, prévisualisation d'image chargée seulement à la demande
et largeur mobile sans débordement.

Les essais initiaux ont révélé des sélecteurs de test incorrects (champ searchbox,
nom du sélecteur de révision) et une collision CSS avec les styles globaux de
`header`/`aside`. Ils ont été corrigés ; les traces/captures initiales sont conservées
localement sous `/tmp/forgebridge-phase4-first-browser-failures` et
`/tmp/forgebridge-phase4-second-browser-failures`. L'erreur 503 du dernier parcours
est volontaire et sert à vérifier la reprise. Les journaux du preview existant
mentionnent l'API locale non démarrée dans les tests de shell de configuration ;
leurs quatre assertions passent. Les deux parcours fonctionnels de messagerie
ne présentent pas d'erreur réseau ou console inattendue.

État de livraison : branche préparée et PR pour revue ; aucune fusion, aucune
migration de production ni aucun déploiement effectués. D1/R2 distants non modifiés
et non déclarés validés ; les données industrielles n'ont pas été utilisées.
Aucun nouvel aperçu public n'est publié. Le propriétaire conserve le Merge.
