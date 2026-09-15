# Aguacate AI Mobile v4.0.0 🥑📱

Version mobile séparée d’Aguacate AI, pensée pour téléphone et tablette.

## Fonctionnalités
- Interface mobile avec menu latéral.
- Conversations, nouvelle conversation, renommage et suppression.
- IA via le backend Aguacate AI.
- Scanner PDF, DOCX, TXT, CSV, JSON, XLS/XLSX et images (OCR navigateur).
- ÉcoGuacate compact dans l’écran des chats.
- Onglet ÉcoGuacate avec arbre, pompe et compteur vertical.
- Une seule valeur de consommation pour tous les affichages.
- Règles et modération 1er / 2e / 3e message puis 24 h pour les suivants.
- Administration protégée par variable d’environnement.
- PWA installable sur mobile.

## Render
Build command: `npm install`
Start command: `npm start`

Variables recommandées :
- `OPENAI_API_KEY`
- `AI_BASE_URL` (par défaut OpenRouter)
- `AI_MODEL`
- `ADMIN_PASSWORD`
- `PROFESSOR_PASSWORD`
- `MAX_FILE_MB` (1 à 15)
- `ECOGUACATE_MAX_LITRES` (valeur technique serveur)
- `RESET_SECRET`

## Important
Le stockage JSON local peut être perdu lors d’un redémarrage d’une instance Render Free. Pour une conservation durable des comptes, conversations et sanctions, il faudra ensuite brancher une base de données persistante.
