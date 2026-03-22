# Kanban SOZAIS — Version AI-First (v2)

Application Kanban d'équipe où **Claude (Anthropic) est le cœur architectural**, pas un simple add-on.

---

## Architecture

```
Client (React + Babel CDN)
        │
        ▼
  Express Server (Node.js)
        │
   ┌────┴────────────────────┐
   │   /api/ai/agent  (POST) │  ← Boucle agentique tool_use
   │   /api/ai/briefing/:name│  ← Briefing quotidien personnalisé
   │   /api/tasks/:name      │  ← CRUD tâches direct
   │   ...                   │
   └────┬────────────────────┘
        │
   ┌────▼──────┐     ┌────────────────┐
   │  MySQL DB  │     │  Claude API    │
   │            │ ◄───│  (tool_use)    │
   └────────────┘     └────────────────┘
```

### Ce que l'IA peut faire directement

| Tool Claude          | Action DB                         |
|----------------------|-----------------------------------|
| `get_team_data`      | Lire toutes les tâches + employés |
| `create_task`        | Créer une tâche (INSERT)          |
| `update_task`        | Modifier titre/priorité/deadline  |
| `move_task`          | Changer de colonne (todo→review)  |
| `reassign_task`      | Réaffecter à un autre ingénieur   |
| `delete_task`        | Supprimer une tâche               |
| `bulk_create_tasks`  | Créer plusieurs tâches en lot     |

### Boucle agentique (max 10 itérations)

```
User → Message → Claude → tool_use → execTool() → MySQL
                     ↑                      │
                     └── tool_result ────────┘
                     (loop until stop_reason = "end_turn")
```

---

## Installation

### Prérequis

- Node.js 18+
- MySQL 8+
- Clé API Anthropic ([console.anthropic.com](https://console.anthropic.com/))

### 1. Cloner & installer

```bash
cd kanban-ai
npm install
```

### 2. Configurer l'environnement

```bash
cp .env.example .env
# Éditer .env avec vos paramètres MySQL et votre clé Anthropic
```

### 3. Initialiser la base de données

```bash
mysql -u root -p < schema.sql
```

> Si vous migrez depuis `kanban-mysql`, les tables existantes sont préservées (INSERT IGNORE).
> La table `ai_actions_log` est ajoutée en plus.

### 4. Lancer le serveur

```bash
npm start          # Production
npm run dev        # Développement (nodemon)
```

L'application est accessible sur **http://localhost:3001**

---

## Fonctionnalités IA

### 🤖 Agent IA (tous les utilisateurs)

Le chat IA est accessible à **tous les collaborateurs** (pas seulement chef/admin).

Exemples de commandes naturelles :
- *"Crée une tâche urgente pour moi : Rapport CVC Hôpital Tunis Nord, deadline 15 avril"*
- *"Déplace toutes mes tâches en retard vers la colonne Review"*
- *"Qui est surchargé dans mon pôle ?"*
- *"Crée 3 tâches de vérification pour Ahmed sur le projet Aéroport"*
- *"Marque ma tâche sur le schéma fluide comme terminée"*

Quand l'IA agit, des **cartes de confirmation colorées** apparaissent dans le chat :
- 🟢 Tâche créée
- 🔵 Tâche modifiée
- 🟠 Tâche déplacée
- 🟣 Tâche réaffectée
- 🔴 Tâche supprimée

Le tableau se **recharge automatiquement** après chaque action IA.

### 🌅 Briefing quotidien

À chaque connexion, un briefing personnalisé est généré par Claude :
- Résumé des tâches du jour
- Alertes sur les deadlines proches
- Suggestions de priorités

### ⚡ Analyse de charge (chef/admin)

Analyse de la charge de travail par équipe et détection des déséquilibres.

### 📊 Rapport hebdomadaire (admin)

Rapport complet de l'activité hebdomadaire, envoyable par email.

---

## Différences avec kanban-mysql

| Fonctionnalité           | kanban-mysql     | kanban-ai         |
|--------------------------|------------------|-------------------|
| Chat IA                  | Admin + Chef     | **Tous**          |
| Actions IA               | Suggestions seules| **Écriture DB** |
| Boucle agentique         | ❌               | ✅ (10 itérations)|
| Cartes d'action          | ❌               | ✅                |
| Briefing quotidien       | ❌               | ✅                |
| Auto-refresh après IA    | ❌               | ✅                |
| Log des actions IA       | ❌               | ✅ (table DB)     |

---

## Variables d'environnement

| Variable         | Requis | Description                          |
|------------------|--------|--------------------------------------|
| `DB_HOST`        | ✅     | Hôte MySQL                           |
| `DB_PORT`        | ✅     | Port MySQL (défaut: 3306)            |
| `DB_USER`        | ✅     | Utilisateur MySQL                    |
| `DB_PASSWORD`    | ✅     | Mot de passe MySQL                   |
| `DB_NAME`        | ✅     | Nom de la base (kanban_sozais)       |
| `ANTHROPIC_API_KEY` | ✅  | Clé API Anthropic                    |
| `PORT`           | ❌     | Port du serveur (défaut: 3001)       |
| `SMTP_HOST`      | ❌     | Serveur SMTP (pour rapports email)   |
| `SMTP_USER`      | ❌     | Email expéditeur                     |
| `SMTP_PASS`      | ❌     | Mot de passe SMTP                    |
| `REPORT_TO`      | ❌     | Email destinataire des rapports      |
