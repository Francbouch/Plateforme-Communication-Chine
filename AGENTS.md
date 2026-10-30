# ForgeBridge — règles de livraison

Le propriétaire demande un développement autonome avec vérification des fonctions.
Analyser et réutiliser l’existant ; ne pas réécrire une fonction pour faciliter un test.

- Avant livraison, exécuter les contrôles adaptés puis la suite `npm run verify`
  (TypeScript, lint, Vitest, builds et Playwright). En environnement cloud,
  définir `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium` si ce navigateur existe.
- Pour les fonctions interactives, ouvrir la vraie interface compilée avec
  Playwright, remplir les formulaires et vérifier comportement, réponses réseau,
  persistance après rechargement, erreurs console et régressions. Les captures
  seules et les statuts HTTP 200 seuls ne prouvent pas le fonctionnement.
- Examiner les échecs, corriger leur cause puis relancer les contrôles concernés.
  Conserver traces/captures d’échec. Ne jamais prétendre avoir exécuté un test absent.
- Les tests d’écriture utilisent exclusivement D1/R2 locaux isolés ou un staging
  dont les accès et l’isolation sont confirmés. Nettoyer uniquement les données
  appartenant avec certitude aux tests. Ne jamais réinitialiser la D1 distante.
- Ne pas demander au propriétaire de retester boutons, formulaires, sauvegardes
  ou PDF que les outils peuvent vérifier. Regrouper les interventions indispensables
  pour accès/secrets manquants, autorisations nécessaires, ambiguïtés fonctionnelles
  réelles ou limitations techniques non résolubles dans cet environnement.
- Préserver documents, révisions et protection serveur existante. Ne pas ajouter
  d’authentification ni de comptes fournisseurs sans nouvelle demande. Ne pas
  modifier les autres projets Cloudflare ni publier les documents industriels.
- Préparer les migrations additives et leur ordre d’application avant publication.
  Sans accès distant, ne pas annoncer une migration ou un test de production fait.
  Ne pas fusionner ou déployer en production sans autorisation correspondante.
- Rapport final : fonctions, tests réellement exécutés et leurs nombres, limites,
  état local/distant de D1/R2, builds, problèmes restants et lien testable si disponible.
