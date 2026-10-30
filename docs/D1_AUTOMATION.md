# Migrations D1 avant déploiement

Le workflow `ForgeBridge D1 migration gate` valide chaque PR sans secret ni accès
production. Sur `main`, après validation complète du même SHA, il inspecte puis
migre uniquement `forgebridge-db` via la configuration `apps/api/wrangler.jsonc`.
Le secret GitHub Actions `CLOUDFLARE_API_TOKEN` existant est réutilisé ; ne jamais
le recopier dans le dépôt. Il doit autoriser D1 pour le compte ForgeBridge.
La variable GitHub Actions non secrète `CLOUDFLARE_ACCOUNT_ID` peut préciser ce
compte, notamment si le token donne accès à plusieurs comptes. Pour le déploiement
optionnel du Worker, le token doit aussi disposer des droits Worker nécessaires.

## Reconnaissance et sécurité

Depuis la racine :

```sh
python3 scripts/d1/migrate.py --remote         # lecture seule, plan
python3 scripts/d1/migrate.py --remote --apply # réconciliation + migrations
```

Sans `--remote`, ces commandes utilisent exclusivement D1 locale. Le script
compare l'ensemble des tables, index et triggers applicatifs avec les schémas
cumulés reconstruits depuis les migrations SQL versionnées, contraintes incluses.
Le baseline historique de la console (`initialize-empty-d1.sql`), dont l’ordre
des colonnes de `profiles` diffère, est également reconnu explicitement.
Seuls les objets internes SQLite/Cloudflare et `d1_migrations` sont exclus.
Il vérifie aussi `foreign_key_check`, `quick_check` et la cohérence du journal.
Une différence, un objet supplémentaire, une migration partielle ou un journal
contradictoire bloque avant toute écriture applicative ; diagnostiquer sans reset.
Les différences de format SQL autres que les espaces peuvent également bloquer :
préférer un audit manuel à une reconnaissance trop permissive.

Pour un schéma correspondant exactement à 0004, les migrations 0001–0004 absentes
du journal sont enregistrées sans rejouer leurs SQL. Wrangler applique ensuite
uniquement 0005, transactionnellement avec son entrée de journal, puis le script
vérifie à nouveau le schéma complet, le journal et l'intégrité. Une nouvelle
exécution sur une base à jour ne rejoue aucune migration. L'enregistrement de
chaque migration manuelle est reprenable après interruption.

0005 contient un backfill des annotations existantes. Si son schéma est présent
sans son entrée de journal, le script refuse de supposer que les données ont été
converties : un audit des données est nécessaire avant enregistrement manuel.
Ne pas effacer de colonnes ou tables pour la rejouer. Les futures migrations de
données non suivies exigent aussi un audit explicite.

Le script ne crée ni ressource distante, ni export public, ni reset. Aucun appel
R2, changement Access, variable Worker, secret serveur ou modification du schéma
SQL existant. Les triggers de protection sont contrôlés, pas supprimés.
Avant la première application distante, vérifier la fenêtre Time Travel et la
procédure de restauration D1 selon la politique de sauvegarde existante. Ne pas
publier d'export contenant des données privées dans les artefacts GitHub.

## Garantir l'ordre avant déploiement

La fusion déclenche les migrations mais **ne déploie pas** le Worker. Pour un
déploiement explicitement autorisé, lancer ce workflow sur `main` avec
`deploy_worker=true` : il vérifie, migre et valide le même checkout avant de lancer
la commande de déploiement. Tout échec bloque la suite. Le groupe de concurrence
`forgebridge-production-d1` sérialise ces exécutions sans annuler une migration.
Toute autre automatisation qui écrit dans D1 doit utiliser le même groupe ;
éviter les opérations manuelles concurrentes.

Un workflow séparé, un déploiement Cloudflare Builds ou une commande manuelle
n'attendent pas automatiquement ce workflow. Pour une garantie effective,
désactiver le déploiement Worker automatique concurrent et utiliser ce chemin
unique, ou configurer sa commande de déploiement depuis la racine ainsi :

```sh
python3 scripts/d1/migrate.py --remote --apply && npm run deploy -w @forgebridge/api
```

Ce chemin externe doit aussi exécuter les validations et sérialiser ses écritures.
Une simple vérification de branche ou un statut vert sur un autre SHA ne suffit
pas. Conserver les approbations/protections de déploiement existantes dans le
système qui effectue la publication ; ce changement n'en modifie aucune. Si les
secrets sont limités à un environnement GitHub protégé, rattacher le job `migrate`
à cet environnement existant avant d'activer son exécution distante.

## Vérifications locales

```sh
npm ci
python3 -m unittest discover -s scripts/d1 -p 'test_*.py' -v
python3 scripts/d1/integration.py # D1 temporaire isolée, scénario 0004 manuelle
python3 scripts/d1/migrate.py --apply
python3 scripts/d1/migrate.py --apply # reprise/idempotence
npm run verify
```

Les tests couvrent les états vide, manuels 0001–0004, 0004 sans 0005, à jour,
partiel, contraintes/triggers manquants, journal inconnu/contradictoire/dupliqué et
0005 non suivie. Ils n'accèdent jamais à D1/R2 distants.

## Résultats de préparation (30 octobre 2026)

- 10 tests unitaires Python réussis sur le contrôle de schéma et du journal.
- Wrangler local : installation depuis une base vide, reconnaissance de 0004
  manuelle, application de 0005, conservation des données et reprise sans rejouer.
- TypeScript, lint, 50 tests Vitest, build frontend et build Worker réussis.
- Playwright : 4 tests preview réussis ; première exécution privée avec 6 réussites
  et un timeout avant la requête d'upload dans le setup du test existant. La trace
  ne contient aucun POST d'upload pour cet échec. Relance de la suite privée :
  7/7 réussites, sans modification du code applicatif ni des tests existants.
- Aucun test ni migration de production, aucune opération R2 distante, aucun
  déploiement. L'état distant de 0005 reste à déterminer par l'inspection du
  workflow GitHub Actions après fusion. Le secret GitHub reste dans Actions.
