# Aperçu sans connexion

Après déploiement sur Vercel, ouvrir `/demo` (ou `/demo/projects`, `/demo/admin`).
Aucune variable d’environnement ni API Cloudflare n’est requise pour cet aperçu.
Les données sont fictives, uniquement en mémoire dans l’onglet ; un rechargement
réinitialise les projets. Création et modification des projets sont disponibles.
Les autres mutations restent indisponibles. Ne pas saisir de données confidentielles.

Le middleware autorise `/demo`, ses sous-routes et les fichiers compilés `/assets/`.
Les routes privées et `/api/` conservent leur protection par secret partagé.
Cloudflare Access et D1 ne sont pas modifiés.

Si Vercel Authentication protège All Deployments, le propriétaire peut consulter
l’aperçu après sa connexion Vercel. Pour partager sans connexion Vercel, sélectionner
une protection qui exclut le domaine de production (Standard Protection si proposée).
Cela rend l’aperçu fictif public ; le middleware protège encore les pages privées.

Validation : TypeScript, ESLint, build Vite, cinq tests de protection et quatre
scénarios Chromium dont navigation de la démonstration sans requête API.
