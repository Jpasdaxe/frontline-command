# 🎖 Frontline Command

RTS multijoueur navigateur — Prototype v0.1

## Stack
- **Backend** : Node.js + Socket.io + Express
- **Frontend** : HTML/CSS/JS vanilla (Phaser 3 à venir)

## Installation

```bash
npm install
```

## Lancer le serveur

```bash
# Production
npm start

# Développement (auto-restart)
npm run dev
```

→ Ouvrir **http://localhost:3000** dans deux onglets (ou deux navigateurs)

## Tester le multijoueur en local

1. Ouvrir `http://localhost:3000` dans l'**onglet A**
2. Cliquer **Créer une partie** → noter le code (ex: `KQBZ`)
3. Ouvrir `http://localhost:3000` dans l'**onglet B**
4. Cliquer **Rejoindre une partie** → entrer le code
5. Dans l'onglet A, cliquer **Commencer la partie**

## Architecture serveur

```
frontline-command/
├── server/
│   └── index.js       ← Serveur Node.js + Socket.io
├── client/
│   └── index.html     ← Interface lobby
├── package.json
└── README.md
```

## Événements Socket.io

| Événement         | Direction      | Description                    |
|-------------------|---------------|--------------------------------|
| `room:create`     | client → srv  | Créer une nouvelle salle        |
| `room:join`       | client → srv  | Rejoindre via code              |
| `room:leave`      | client → srv  | Quitter la salle                |
| `game:start`      | client → srv  | Lancer la partie (hôte only)    |
| `lobby:update`    | srv → clients | Mise à jour de l'état du lobby  |
| `game:start`      | srv → clients | Partie lancée                   |
| `game:tick`       | srv → clients | Tick de jeu (toutes les 500ms)  |

## Prochaines étapes

- [ ] Carte avec territoires hexagonaux (Phaser 3)
- [ ] Ressources automatiques (argent, fuel, matériaux)
- [ ] Production d'unités (infanterie, blindés)
- [ ] Combat automatique entre zones
- [ ] Mini-carte

## Déploiement gratuit

- **Frontend** → GitHub Pages (ou servi par Express, déjà configuré)
- **Backend** → [Railway](https://railway.app) ou [Render](https://render.com)
  - Variable d'env : `PORT` (automatiquement définie)
  - Commande de démarrage : `npm start`
