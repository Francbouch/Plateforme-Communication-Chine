# Preuves de validation — Phase 3

Commande réellement exécutée :
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run verify`.

| Contrôle                    | Résultat final                                                          |
| --------------------------- | ----------------------------------------------------------------------- |
| TypeScript strict           | Succès                                                                  |
| ESLint                      | Succès                                                                  |
| Vitest                      | 47 réussis / 0 échoué                                                   |
| Chromium aperçu             | 4 réussis / 0 échoué / 0 ignoré / 0 instable                            |
| Chromium application privée | 4 réussis / 0 échoué / 0 ignoré / 0 instable                            |
| Build frontend              | Succès, PDF.js et remplacement chargés à la demande                     |
| Build backend               | Succès en dry-run, aucun déploiement                                    |
| Conservation PDF original   | Comparaison exacte des octets après annotations et remplacement de page |
| Persistance D1 et R2        | Réouverture navigateur et redémarrage de runtime isolé                  |
| Environnement distant       | Non testé et non modifié, accès Cloudflare absent                       |

Les cas exécutés se trouvent dans `tests/pdf-review.test.ts`,
`tests/documents.test.ts`, `tests/browser-private/review.spec.ts` et les suites
existantes. Les 22 scénarios demandés sont reliés aux assertions dans
[PHASE3.md](../PHASE3.md). Les données des essais sont non confidentielles et
isolées des ressources du propriétaire. Les erreurs délibérées (échec HTTP,
checksum, refus d’accès, rollback) doivent être distinguées des échecs de tests.

Rapports détaillés générés : `test-results/preview-results.json`,
`test-results/private-results.json`. Captures/traces de diagnostic sont conservées
sur échec, et la CI configurée les publie comme artefacts. Ces fichiers générés
ne sont pas committés. Une exécution de la CI GitHub n’a pas été observée ici.
