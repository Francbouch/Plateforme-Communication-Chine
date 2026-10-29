# Sécurité

## Contrôles implémentés

Authentification Supabase Auth vérifiée via `getUser` à chaque requête métier. Le compte actif est relu ; les droits sont recalculés en base pour chaque accès. Aucun projet public, aucun mot de passe géré ou stocké par le code applicatif, aucune clé privilégiée dans le navigateur ou le Worker. RLS protège aussi l’API REST directe Supabase.

MFA TOTP fourni par Supabase ; l’interface permet enrôlement et challenge. Le serveur exige AAL2 pour Owner/Project Admin. L’utilisateur peut fermer toutes ses sessions via Supabase. Les JWT déjà émis peuvent rester valables jusqu’à leur expiration après fermeture globale : configurer une durée courte (15 minutes conseillées). Révoquer un accès d’organisation/projet/fournisseur bloque les données immédiatement à la prochaine requête, même avec un ancien JWT.

Jetons Bearer explicites, pas de cookie d’auth envoyé automatiquement à l’API : protection CSRF par absence d’auth ambiante, vérification stricte Origin sur mutations et pas de CORS ouvert. React échappe le contenu, aucune injection HTML ; en-têtes API sécurisés. Entrées Zod, SQL via RPC paramétrées, contraintes/RLS en base. Ne pas logger URL d’invitation ni tokens. Le token est saisi dans un formulaire, pas dans une URL.

Quota Worker de 60 requêtes/minute/utilisateur via binding RATE_LIMITER (local simulé par Wrangler). Les protections de connexion sont celles de Supabase Auth : configurer quotas, confirmation des courriels et CAPTCHA anti-abus selon DEPLOYMENT.md. Ne pas remplacer ces protections par un compteur mémoire de Worker. La limitation API ne protège pas les endpoints Auth directement accessibles.

Les notes internes sont dans une table à politique dédiée. L’audit et l’outbox sont écrits avec les mutations. Le service de stockage n’expose aucun téléchargement tant que les droits documentaires ne sont pas implémentés.

## Conditions avant production

Vérifier l’intégration réelle Supabase, quotas Auth, confirmation, MFA, courriels et révocation. HTTPS uniquement, CSP frontend, origines exactes, aucune clé service-role, région et accès Chine validés, secrets via paramètres sécurisés. Le mode local HTTP est réservé au développement.

Configurer sauvegardes PostgreSQL dans le nouveau service selon son offre et autorisation budgétaire, chiffrer exports, contrôler les accès et définir RPO/RTO avec le propriétaire. Pour restauration : restaurer dans une instance **distincte**, appliquer uniquement les migrations manquantes, vérifier contraintes/RLS/comptes et données, tester accès autorisés/interdits, puis décider explicitement de la bascule. Tester trimestriellement. R2 nécessitera une sauvegarde indépendante des objets avec manifeste/hash : une sauvegarde SQL seule ne sauvegarde pas les fichiers.

## Stockage phase 2

Bucket nouveau et privé, sans r2.dev ni domaine public, binding côté Worker seulement. Clés aléatoires opaques par tenant/projet/actif, jamais choisies par le client. Résoudre asset → document → projet et grants avant GET/Range ; journaliser les téléchargements sensibles sans contenu. N’émettre des URLs temporaires que si un court délai, un périmètre objet et le risque de partage sont acceptables ; par défaut streamer via API.

Prévoir multipart authentifié, limites taille/temps/nombre de parties, contrôle du total, checksums et finalisation idempotente. Types autorisés : PDF, STEP/STP, STL, DXF, DWG, SLDPRT, SLDASM, XLSX, DOCX, PNG/JPG. Vérifier signatures réelles et intégrité, quarantaine jusqu’à validation/antivirus. Ne pas se fier à l’extension ou au MIME client ; refuser les types ambigus non pris en charge. Télécharger les CAO sans exécution serveur. PDF uniquement visualisable, sandbox séparée et plafonnée pour transformations. Nettoyage des uploads abandonnés avec délai et vérification d’absence de références. Ces contrôles sont une spécification, pas un pipeline déjà disponible.
