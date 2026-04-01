// ============================================================ 
// Kanban SOZAIS — AI-First Edition
// Stack : Node.js + Express + MySQL + Groq (LLaMA 3.3-70b)
// Architecture : Groq tool_use en cœur — l'IA agit directement
// sur la base de données (créer, modifier, déplacer, réaffecter)
// ============================================================
require("dotenv").config();
const express    = require("express");
const mysql      = require("mysql2/promise");
const cors       = require("cors");
const path       = require("path");
const Groq       = require("groq-sdk");
const nodemailer = require("nodemailer");
const cron       = require("node-cron");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Pool MySQL ───────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || "localhost",
  port:     parseInt(process.env.DB_PORT || "3306"),
  user:     process.env.DB_USER     || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME     || "kanban_sozais",
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

(async () => {
  try {
    const conn = await pool.getConnection();
    console.log("✅ MySQL OK →", process.env.DB_NAME || "kanban_sozais");

    // ─── Auto-initialisation des tables ───────────────────────
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               VARCHAR(20)    NOT NULL,
        owner_name       VARCHAR(200)   NOT NULL,
        title            VARCHAR(500)   NOT NULL,
        project          VARCHAR(300)   DEFAULT '',
        description      TEXT           NULL,
        priority         VARCHAR(20)    DEFAULT 'medium',
        column_id        VARCHAR(50)    DEFAULT 'todo',
        deadline         VARCHAR(20)    DEFAULT NULL,
        estimated_hours  DECIMAL(6,1)   DEFAULT NULL,
        timer_seconds    INT UNSIGNED   DEFAULT 0,
        timer_running    TINYINT(1)     DEFAULT 0,
        timer_started_at BIGINT         DEFAULT NULL,
        created_at       VARCHAR(50)    NOT NULL,
        revenue_amount   DECIMAL(10,2)  DEFAULT 0,
        PRIMARY KEY (id),
        INDEX idx_owner (owner_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS passwords (
        name       VARCHAR(200) NOT NULL,
        password   VARCHAR(200) NOT NULL,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS employees (
        name       VARCHAR(200) NOT NULL,
        role       VARCHAR(200) NOT NULL DEFAULT '',
        pole       VARCHAR(50)  NOT NULL DEFAULT 'Fluide',
        is_chef    TINYINT(1)   DEFAULT 0,
        is_admin   TINYINT(1)   DEFAULT 0,
        tjm        DECIMAL(8,2) DEFAULT 0,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS fixed_costs (
        category       VARCHAR(50)    NOT NULL,
        label          VARCHAR(200)   NOT NULL,
        amount_monthly DECIMAL(12,2)  DEFAULT 0,
        updated_at     VARCHAR(50)    DEFAULT NULL,
        PRIMARY KEY (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS projects (
        name             VARCHAR(300)   NOT NULL,
        revenue_forfait  DECIMAL(12,2)  DEFAULT 0,
        revenue_mode     VARCHAR(20)    DEFAULT 'forfait',
        description      TEXT           NULL,
        created_at       VARCHAR(50)    DEFAULT NULL,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ai_actions_log (
        id          INT UNSIGNED   AUTO_INCREMENT NOT NULL,
        actor       VARCHAR(200)   NOT NULL,
        tool_name   VARCHAR(50)    NOT NULL,
        input_json  TEXT           NULL,
        result_json TEXT           NULL,
        created_at  DATETIME       DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_actor (actor),
        INDEX idx_tool  (tool_name),
        INDEX idx_date  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS kpi_criteria (
        id       INT UNSIGNED   AUTO_INCREMENT NOT NULL,
        label    VARCHAR(300)   NOT NULL,
        category VARCHAR(100)   NOT NULL DEFAULT '',
        active   TINYINT(1)     DEFAULT 1,
        position INT            DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_label (label)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS kpi_evaluations (
        id               VARCHAR(20)    NOT NULL,
        evaluator_name   VARCHAR(200)   NOT NULL,
        evaluated_name   VARCHAR(200)   NOT NULL,
        period           VARCHAR(30)    NOT NULL,
        scores           JSON           NOT NULL,
        overall_comment  TEXT           NULL,
        created_at       DATETIME       DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_evaluated (evaluated_name),
        INDEX idx_period    (period)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ─── Données initiales employees ──────────────────────────
    const employeesData = [
      ['Souha ARFAOUI',    'Cheffe Pôle Fluide',      'Fluide', 1, 0],
      ['Imen AZAZA',       'Ingénieure fluide',        'Fluide', 0, 0],
      ['Souha BEN HASSEN', 'Ingénieure fluide',        'Fluide', 0, 0],
      ['Chadha DAOUIDI',   'Ingénieure fluide',        'Fluide', 0, 0],
      ['Hamadi MTIRI',     'Projeteur fluide',         'Fluide', 0, 0],
      ['Abdelhak AMRI',    'Technicien sup fluide',    'Fluide', 0, 0],
      ['Nesrine KAYEL',    'Ingénieur fluide',         'Fluide', 0, 0],
      ['Nadhir GHOUMA',    'Technicien sup fluide',    'Fluide', 0, 0],
      ['Achraf SAOUDI',    'Ingénieur fluide',         'Fluide', 0, 0],
      ['Tayeb KSENTINI',   'Ingénieur fluide',         'Fluide', 0, 0],
      ['Chadha SAADAOUI',  'Ingénieur fluide',         'Fluide', 0, 0],
      ['Shayma MASTOURI',  'Ingénieur fluide',         'Fluide', 0, 0],
      ['Rihab ATTIA',      'Ingénieur fluide',         'Fluide', 0, 0],
      ['Fatma RHAIMI',     'Ingénieur fluide',         'Fluide', 0, 0],
      ['Sabah AJARRAR',    'Ingénieur fluide',         'Fluide', 0, 0],
      ['Majdi AMARA',      'Chef Pôle Élec',           'Élec',   1, 0],
      ['Yassine KHCHIMI',  'Ingénieur Elec',           'Élec',   0, 0],
      ['Rakia MANSOUR',    'Ingénieur Elec',           'Élec',   0, 0],
      ['Safa SOUAYAH',     'Ingénieur Elec',           'Élec',   0, 0],
      ['Rima MABROUKI',    'Ingénieur Elec',           'Élec',   0, 0],
      ['Mohamed KLII',     'Ingénieur Elec',           'Élec',   0, 0],
      ['Nadhmi JAMEL',     'Ingénieur Elec',           'Élec',   0, 0],
      ['Walid GHARBI',     'Ingénieur Elec',           'Élec',   0, 0],
      ['Wissem BEN TAHER', 'Ingénieur Elec',           'Élec',   0, 0],
      ['Hamza BEN AHMED',  'Technicien sup Elec',      'Élec',   0, 0],
      ['Amine DRONGA',     'Ingénieur Elec',           'Élec',   0, 0],
      ['Salma HANZOULI',   'Ingénieur Elec',           'Élec',   0, 0],
      ['M.O. HACHLEF',     'Ingénieur Elec',           'Élec',   0, 0],
      ['ECHRIF Walid',     'Admin',                    'Admin',  0, 1],
      ['ECHRIF Youssef',   'Admin',                    'Admin',  0, 1],
    ];
    for (const emp of employeesData) {
      await conn.query(
        `INSERT IGNORE INTO employees (name, role, pole, is_chef, is_admin) VALUES (?, ?, ?, ?, ?)`,
        emp
      );
    }
    await conn.query(
      `INSERT IGNORE INTO fixed_costs (category, label, amount_monthly) VALUES
       ('loyer', 'Loyer & charges locatives', 0),
       ('licences', 'Licences logiciels', 0),
       ('charges_sociales', 'Charges sociales patronales', 0),
       ('frais_generaux', 'Autres frais généraux', 0)`
    );

    // ─── KPI critères par défaut (24) ─────────────────────────
    const kpiData = [
      ['Qualité des livrables',                  'Qualité du travail',            1],
      ['Respect des normes et standards',         'Qualité du travail',            2],
      ["Taux d'erreurs / non-conformités",        'Qualité du travail',            3],
      ['Précision des calculs et plans',          'Qualité du travail',            4],
      ['Respect des deadlines',                   'Délais & Productivité',         5],
      ['Taux de complétion des tâches',           'Délais & Productivité',         6],
      ['Écart heures estimées / réelles',         'Délais & Productivité',         7],
      ['Volume de livrables produits',            'Délais & Productivité',         8],
      ['Capacité à travailler sans supervision',  'Autonomie & Initiative',        9],
      ['Force de proposition / proactivité',      'Autonomie & Initiative',       10],
      ['Résolution autonome des problèmes',       'Autonomie & Initiative',       11],
      ["Prise d'initiative sur les améliorations",'Autonomie & Initiative',       12],
      ["Esprit d'équipe / solidarité",            'Collaboration',                13],
      ['Qualité de la communication interne',     'Collaboration',                14],
      ['Réactivité aux retours et demandes',      'Collaboration',                15],
      ['Partage des connaissances',               'Collaboration',                16],
      ['Montée en compétences techniques',        'Développement professionnel',  17],
      ['Participation aux formations',            'Développement professionnel',  18],
      ['Implication dans la vie du bureau',       'Développement professionnel',  19],
      ['Polyvalence / adaptabilité',              'Développement professionnel',  20],
      ["Gestion de planning de l'équipe",         'Management / Chef de projet',  21],
      ['Capacité à anticiper les risques',        'Management / Chef de projet',  22],
      ['Qualité du reporting client',             'Management / Chef de projet',  23],
      ['Satisfaction client',                     'Management / Chef de projet',  24],
    ];
    for (const [label, category, position] of kpiData) {
      await conn.query(
        'INSERT IGNORE INTO kpi_criteria (label, category, position) VALUES (?, ?, ?)',
        [label, category, position]
      );
    }

    console.log("✅ Tables & données initiales OK");
    conn.release();
  } catch (err) {
    console.error("❌ MySQL init:", err.message);
  }
})();

// ─── Client Groq ──────────────────────────────────────────────
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

// ─── Mailer ───────────────────────────────────────────────────
const mailer = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST || "smtp.gmail.com",
      port: parseInt(process.env.EMAIL_PORT || "587"),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    })
  : null;

function requireAI(res) {
  if (!groq) {
    res.status(503).json({ error: "Clé GROQ_API_KEY manquante dans .env" });
    return false;
  }
  return true;
}

// ─── Helper : toutes données équipe ──────────────────────────
async function getAllData() {
  const [employees] = await pool.query(
    "SELECT * FROM employees WHERE is_admin = 0 ORDER BY pole, is_chef DESC, name"
  );
  const [tasks] = await pool.query("SELECT * FROM tasks");
  const byOwner = {};
  tasks.forEach((t) => {
    if (!byOwner[t.owner_name]) byOwner[t.owner_name] = [];
    byOwner[t.owner_name].push({
      id: t.id, title: t.title, project: t.project,
      priority: t.priority, column: t.column_id,
      deadline: t.deadline, estimatedHours: t.estimated_hours,
      timerSeconds: t.timer_seconds,
    });
  });
  return { employees, byOwner };
}

// ─── Génération ID ────────────────────────────────────────────
const genId = () => Math.random().toString(36).substr(2, 9);

// ============================================================
// ─── OUTILS IA (Groq / OpenAI tool_use format) ───────────────
// ============================================================
const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_team_data",
      description: "Récupère toutes les données en temps réel : tâches, statuts, deadlines, timers de tous les collaborateurs. Toujours utiliser avant d'analyser ou de prendre des décisions.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optionnel: 'Fluide', 'Élec', ou nom d'un collaborateur" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Crée une nouvelle tâche dans le Kanban pour un collaborateur. Utiliser quand l'utilisateur demande de créer ou ajouter une tâche.",
      parameters: {
        type: "object",
        required: ["owner_name", "title", "priority"],
        properties: {
          owner_name:      { type: "string", description: "Nom exact du collaborateur (doit exister dans l'équipe)" },
          title:           { type: "string", description: "Titre de la tâche" },
          project:         { type: "string", description: "Nom du projet/affaire (ex: Hôpital Tunis Nord)" },
          description:     { type: "string", description: "Description détaillée" },
          priority:        { type: "string", enum: ["high", "medium", "low"] },
          column:          { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"], description: "Colonne initiale (défaut: todo)" },
          deadline:        { type: "string", description: "Échéance au format YYYY-MM-DD" },
          estimated_hours: { type: "number", description: "Heures estimées pour cette tâche" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Modifie une tâche existante. Seuls les champs fournis sont modifiés.",
      parameters: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id:         { type: "string", description: "ID de la tâche à modifier" },
          title:           { type: "string" },
          project:         { type: "string" },
          description:     { type: "string" },
          priority:        { type: "string", enum: ["high", "medium", "low"] },
          column:          { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
          deadline:        { type: "string", description: "Format YYYY-MM-DD" },
          estimated_hours: { type: "number" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "move_task",
      description: "Déplace une tâche vers une autre colonne du Kanban.",
      parameters: {
        type: "object",
        required: ["task_id", "column"],
        properties: {
          task_id: { type: "string" },
          column:  { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reassign_task",
      description: "Réaffecte une tâche d'un collaborateur à un autre. La tâche disparaît du tableau source et apparaît dans le tableau cible.",
      parameters: {
        type: "object",
        required: ["task_id", "new_owner"],
        properties: {
          task_id:   { type: "string" },
          new_owner: { type: "string", description: "Nom exact du nouveau collaborateur" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Supprime définitivement une tâche. Demander confirmation à l'utilisateur avant de supprimer.",
      parameters: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_create_tasks",
      description: "Crée plusieurs tâches en une seule opération. Utile pour importer une liste ou créer un lot de tâches.",
      parameters: {
        type: "object",
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              required: ["owner_name", "title", "priority"],
              properties: {
                owner_name:      { type: "string" },
                title:           { type: "string" },
                project:         { type: "string" },
                description:     { type: "string" },
                priority:        { type: "string", enum: ["high", "medium", "low"] },
                column:          { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
                deadline:        { type: "string" },
                estimated_hours: { type: "number" }
              }
            }
          }
        }
      }
    }
  }
];

// ─── Exécuteur d'outils ───────────────────────────────────────
async function execTool(name, input) {
  input = input || {};   // sécurité : LLaMA peut passer null au lieu de {}
  switch (name) {

    case "get_team_data": {
      const { employees, byOwner } = await getAllData();
      const today = new Date().toISOString().split("T")[0];
      let filtered = employees;
      if (input.filter) {
        const f = input.filter.toLowerCase();
        filtered = employees.filter(e =>
          e.pole.toLowerCase().includes(f) || e.name.toLowerCase().includes(f)
        );
      }
      const data = filtered.map(e => {
        const tasks = byOwner[e.name] || [];
        const overdue = tasks.filter(t => t.deadline && t.deadline < today && t.column !== "done");
        const inProg  = tasks.filter(t => t.column === "in_progress").length;
        const done    = tasks.filter(t => t.column === "done").length;
        const totalH  = tasks.reduce((s, t) => s + (parseFloat(t.estimatedHours) || 0), 0);
        const workedH = tasks.reduce((s, t) => s + (t.timerSeconds || 0) / 3600, 0);
        return {
          name: e.name, role: e.role, pole: e.pole,
          stats: { total: tasks.length, inProgress: inProg, done, overdue: overdue.length, totalH: Math.round(totalH), workedH: Math.round(workedH * 10) / 10 },
          tasks: tasks.map(t => ({
            id: t.id, title: t.title, project: t.project,
            priority: t.priority, column: t.column,
            deadline: t.deadline || null, estimatedHours: t.estimatedHours,
            timerSeconds: t.timerSeconds,
            isOverdue: !!(t.deadline && t.deadline < today && t.column !== "done")
          }))
        };
      });
      return { ok: true, team: data, today };
    }

    case "create_task": {
      const [emp] = await pool.query("SELECT name FROM employees WHERE name = ?", [input.owner_name]);
      if (!emp.length) return { error: `Collaborateur introuvable: "${input.owner_name}". Vérifiez l'orthographe exacte.` };
      const id = genId();
      await pool.query(
        `INSERT INTO tasks (id, owner_name, title, project, description, priority, column_id, deadline, estimated_hours, timer_seconds, timer_running, created_at, revenue_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`,
        [id, input.owner_name, input.title, input.project || "", input.description || "",
         input.priority || "medium", input.column || "todo",
         input.deadline || null, input.estimated_hours || null, new Date().toISOString()]
      );
      return { ok: true, task_id: id, action: "create_task", owner: input.owner_name, title: input.title, column: input.column || "todo", priority: input.priority || "medium" };
    }

    case "update_task": {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [input.task_id]);
      if (!rows.length) return { error: `Tâche introuvable: "${input.task_id}"` };
      const t = rows[0];
      await pool.query(
        `UPDATE tasks SET title=?, project=?, description=?, priority=?, column_id=?, deadline=?, estimated_hours=? WHERE id=?`,
        [
          input.title           ?? t.title,
          input.project         ?? t.project,
          input.description     ?? t.description,
          input.priority        ?? t.priority,
          input.column          ?? t.column_id,
          input.deadline        !== undefined ? (input.deadline || null) : t.deadline,
          input.estimated_hours !== undefined ? (input.estimated_hours || null) : t.estimated_hours,
          input.task_id
        ]
      );
      return { ok: true, task_id: input.task_id, action: "update_task", title: input.title || t.title, owner: t.owner_name };
    }

    case "move_task": {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [input.task_id]);
      if (!rows.length) return { error: `Tâche introuvable: "${input.task_id}"` };
      const t = rows[0];
      const prevCol = t.column_id;
      await pool.query("UPDATE tasks SET column_id=? WHERE id=?", [input.column, input.task_id]);
      return { ok: true, task_id: input.task_id, action: "move_task", title: t.title, owner: t.owner_name, from: prevCol, to: input.column };
    }

    case "reassign_task": {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [input.task_id]);
      if (!rows.length) return { error: `Tâche introuvable: "${input.task_id}"` };
      const [emp] = await pool.query("SELECT name FROM employees WHERE name = ?", [input.new_owner]);
      if (!emp.length) return { error: `Collaborateur introuvable: "${input.new_owner}"` };
      const t = rows[0];
      await pool.query("UPDATE tasks SET owner_name=? WHERE id=?", [input.new_owner, input.task_id]);
      return { ok: true, task_id: input.task_id, action: "reassign_task", title: t.title, from: t.owner_name, to: input.new_owner };
    }

    case "delete_task": {
      const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [input.task_id]);
      if (!rows.length) return { error: `Tâche introuvable: "${input.task_id}"` };
      const t = rows[0];
      await pool.query("DELETE FROM tasks WHERE id=?", [input.task_id]);
      return { ok: true, task_id: input.task_id, action: "delete_task", title: t.title, owner: t.owner_name };
    }

    case "bulk_create_tasks": {
      const created = [];
      const errors  = [];
      for (const task of (input.tasks || [])) {
        const [emp] = await pool.query("SELECT name FROM employees WHERE name = ?", [task.owner_name]);
        if (!emp.length) { errors.push(`Inconnu: "${task.owner_name}"`); continue; }
        const id = genId();
        await pool.query(
          `INSERT INTO tasks (id, owner_name, title, project, description, priority, column_id, deadline, estimated_hours, timer_seconds, timer_running, created_at, revenue_amount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`,
          [id, task.owner_name, task.title, task.project || "", task.description || "",
           task.priority || "medium", task.column || "todo",
           task.deadline || null, task.estimated_hours || null, new Date().toISOString()]
        );
        created.push({ task_id: id, owner: task.owner_name, title: task.title });
      }
      return { ok: true, action: "bulk_create_tasks", created, errors, count: created.length };
    }

    default:
      return { error: `Outil inconnu: "${name}"` };
  }
}

// ─── Prompt système de l'agent IA ────────────────────────────
function buildAgentSystemPrompt(userName, userRole, isAdmin, isChef, agentName, agentStyle) {
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const name = agentName || "SOZAIS IA";
  const style = agentStyle || "professionnel";
  const styleMap = {
    "professionnel": "Adopte un ton professionnel, structuré et précis.",
    "décontracté": "Adopte un ton décontracté et convivial, tout en restant efficace.",
    "coach motivant": "Adopte un ton de coach : encourage, motive, célèbre les succès de l'équipe.",
    "direct et concis": "Sois ultra-concis : pas de blabla, aller droit au but, réponses courtes.",
    "humouristique": "Ajoute une touche d'humour bienveillant dans tes réponses, tout en restant utile."
  };
  const styleInstr = styleMap[style] || "Adopte un ton professionnel.";
  return (
    `Tu t'appelles ${name} — l'assistant IA de l'application Kanban SOZAIS.\n` +
    `Aujourd'hui : ${today}. Utilisateur connecté : ${userName} (${userRole}${isAdmin ? ", Admin" : isChef ? ", Chef" : ""}).\n` +
    `STYLE : ${styleInstr}\n\n` +
    `TES CAPACITÉS :\n` +
    `- Tu peux CRÉER des tâches directement dans le Kanban (create_task, bulk_create_tasks)\n` +
    `- Tu peux MODIFIER des tâches (update_task)\n` +
    `- Tu peux DÉPLACER des tâches entre colonnes (move_task)\n` +
    `- Tu peux RÉAFFECTER des tâches à d'autres collaborateurs (reassign_task)\n` +
    `- Tu peux SUPPRIMER des tâches (delete_task — demander confirmation d'abord)\n` +
    `- Tu peux ANALYSER la charge, les retards, et faire des recommandations (get_team_data)\n\n` +
    `RÈGLES IMPORTANTES :\n` +
    `- Réponds TOUJOURS en français\n` +
    `- Avant d'analyser ou recommander, UTILISE get_team_data pour avoir des données fraîches\n` +
    `- Quand tu crées/modifies/déplaces une tâche, CONFIRME clairement ce que tu as fait\n` +
    `- Si un nom de collaborateur est ambigu, propose les options possibles\n` +
    `- Pour les suppressions, demande toujours confirmation sauf si l'utilisateur a dit "confirme" ou "oui"\n` +
    `- Propose des actions concrètes, pas juste des conseils abstraits\n` +
    `- Les colonnes disponibles : backlog, todo (À faire), in_progress (En cours), review (En revue), done (Terminé)\n` +
    `- Les priorités : high (Haute 🔴), medium (Moyenne 🟠), low (Basse 🟢)\n\n` +
    `FORMAT DE CONFIRMATION :\n` +
    `Après une action, confirme avec : "✅ [Action] : [détails]"\n` +
    `Exemple : "✅ Tâche créée : 'Audit réseau bâtiment B' assignée à Imen AZAZA (Haute priorité, À faire)"\n`
  );
}

// ─── API : Agent IA (cœur du système) ─────────────────────────
// POST /api/ai/agent
app.post("/api/ai/agent", async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { messages, userName, userRole, isAdmin, isChef, agentName, agentStyle } = req.body;
    const systemPrompt = buildAgentSystemPrompt(userName, userRole || "", !!isAdmin, !!isChef, agentName, agentStyle);

    const actions = [];
    // Groq : le system prompt est un message {role:"system"} en début de tableau
    let convMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }))
    ];

    let iterations = 0;
    while (iterations < 10) {
      iterations++;

      let response;
      try {
        response = await groq.chat.completions.create({
          model:       "llama-3.3-70b-versatile",
          max_tokens:  2048,
          messages:    convMessages,
          tools:       AGENT_TOOLS,
          tool_choice: "auto",
        });
      } catch (groqErr) {
        // LLaMA a généré un appel d'outil malformé (tool_use_failed)
        // On retourne ce qu'on a déjà comme réponse plutôt que de planter
        console.error("Groq API error:", groqErr.message);
        const lastReply = convMessages.filter(m => m.role === "assistant" && m.content).pop();
        return res.json({
          reply: lastReply?.content || "Je n'ai pas pu terminer cette action. Veuillez reformuler votre demande.",
          actions
        });
      }

      const choice = response.choices[0];
      const msg    = choice.message;

      // Pas d'appel d'outil → réponse finale
      if (choice.finish_reason === "stop" || !msg.tool_calls || msg.tool_calls.length === 0) {
        return res.json({ reply: msg.content || "", actions });
      }

      // Appels d'outils
      if (choice.finish_reason === "tool_calls") {
        // Ajouter la réponse de l'assistant (avec ses tool_calls) à l'historique
        convMessages.push({ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls });

        // Exécuter chaque outil et ajouter les résultats
        for (const tc of msg.tool_calls) {
          let input;
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            input = {};
          }
          if (!input || typeof input !== "object") input = {};

          console.log(`🤖 Tool: ${tc.function.name}`, JSON.stringify(input).slice(0, 120));
          let result;
          try {
            result = await execTool(tc.function.name, input);
          } catch (err) {
            result = { error: err.message };
          }
          console.log(`   → ${JSON.stringify(result).slice(0, 100)}`);

          // Ne logger que les actions qui modifient les données
          if (tc.function.name !== "get_team_data") {
            actions.push({ tool: tc.function.name, input, result });
          }

          // Format Groq pour les résultats d'outils
          convMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      }
    }

    res.json({ reply: "Désolé, la limite de traitement a été atteinte. Réessayez.", actions });
  } catch (err) {
    console.error("POST /api/ai/agent", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : Briefing quotidien ──────────────────────────────────
// GET /api/ai/briefing/:userName
app.get("/api/ai/briefing/:userName", async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { userName } = req.params;
    const today      = new Date().toISOString().split("T")[0];
    const tomorrow   = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const weekLater  = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const dayOfWeek  = new Date().toLocaleDateString("fr-FR", { weekday: "long" });

    const [tasks] = await pool.query(
      "SELECT * FROM tasks WHERE owner_name = ? ORDER BY ISNULL(deadline), deadline ASC",
      [userName]
    );

    const overdue  = tasks.filter(t => t.deadline && t.deadline < today && t.column_id !== "done");
    const dueToday = tasks.filter(t => t.deadline === today && t.column_id !== "done");
    const dueSoon  = tasks.filter(t => t.deadline > today && t.deadline <= weekLater && t.column_id !== "done");
    const inProg   = tasks.filter(t => t.column_id === "in_progress");
    const todo     = tasks.filter(t => ["todo", "backlog"].includes(t.column_id));
    const done     = tasks.filter(t => t.column_id === "done");
    const highPrio = tasks.filter(t => t.priority === "high" && t.column_id !== "done");

    const dataStr =
      `${tasks.length} tâches au total (${done.length} terminées)\n` +
      `En cours (${inProg.length}): ${inProg.map(t => `"${t.title}"`).join(", ") || "aucune"}\n` +
      (overdue.length  ? `🚨 En retard (${overdue.length}): ${overdue.map(t => `"${t.title}" (dû le ${t.deadline})`).join(", ")}\n` : "") +
      (dueToday.length ? `⚠️ À rendre AUJOURD'HUI (${dueToday.length}): ${dueToday.map(t => `"${t.title}"`).join(", ")}\n` : "") +
      (dueSoon.length  ? `📅 À rendre cette semaine (${dueSoon.length}): ${dueSoon.map(t => `"${t.title}" (${t.deadline})`).join(", ")}\n` : "") +
      (highPrio.length ? `🔴 Haute priorité non terminées (${highPrio.length}): ${highPrio.map(t => `"${t.title}"`).join(", ")}\n` : "") +
      `À faire (${todo.length} tâches restantes)`;

    const response = await groq.chat.completions.create({
      model:      "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [{
        role:    "user",
        content: `Génère un briefing de début de journée (${dayOfWeek}) pour ${userName}.\n\n` +
                 `Situation :\n${dataStr}\n\n` +
                 `Instructions :\n` +
                 `- Commence par un bonjour adapté au jour de la semaine\n` +
                 `- 3-5 phrases maximum, ton chaleureux et motivant\n` +
                 `- Mentionne clairement les urgences (retards, deadlines du jour) si il y en a\n` +
                 `- Termine par une priorité claire ou un encouragement\n` +
                 `- Utilise des emojis avec parcimonie\n` +
                 `- En français`
      }]
    });

    res.json({ briefing: response.choices[0].message.content, stats: { total: tasks.length, done: done.length, overdue: overdue.length, dueToday: dueToday.length, inProgress: inProg.length } });
  } catch (err) {
    console.error("GET /api/ai/briefing", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : Analyse de charge ──────────────────────────────────
// GET /api/ai/workload
app.get("/api/ai/workload", async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { employees, byOwner } = await getAllData();
    const today = new Date().toISOString().split("T")[0];
    const dataStr = employees.map(e => {
      const tasks   = byOwner[e.name] || [];
      const totalH  = tasks.reduce((s, t) => s + (parseFloat(t.estimatedHours) || 0), 0);
      const workedH = tasks.reduce((s, t) => s + (t.timerSeconds || 0) / 3600, 0);
      const overdue = tasks.filter(t => t.deadline && t.deadline < today && t.column !== "done").length;
      const inProg  = tasks.filter(t => t.column === "in_progress").length;
      const todo    = tasks.filter(t => ["todo", "backlog"].includes(t.column)).length;
      return (
        `${e.name} (${e.role}, ${e.pole}): ` +
        `${tasks.length} tâches dont ${inProg} en cours, ${todo} à faire, ` +
        `${overdue} en retard — ${totalH.toFixed(0)}h estimées, ${workedH.toFixed(1)}h réalisées`
      );
    }).join("\n");

    const response = await groq.chat.completions.create({
      model:      "llama-3.3-70b-versatile",
      max_tokens: 1500,
      messages: [{
        role:    "user",
        content: `Analyse la charge de travail de l'équipe SOZAIS et identifie les déséquilibres.\n\n` +
                 `Données :\n${dataStr}\n\n` +
                 `Fournis :\n` +
                 `1. Diagnostic de charge (qui est surchargé / qui a de la capacité)\n` +
                 `2. 3-5 recommandations concrètes de redistribution\n` +
                 `3. Personnes nécessitant une attention urgente\n\n` +
                 `Sois direct et actionnable. En français.`,
      }],
    });
    res.json({ analysis: response.choices[0].message.content });
  } catch (err) {
    console.error("GET /api/ai/workload", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : Priorisation ───────────────────────────────────────
// POST /api/ai/prioritize/:ownerName
app.post("/api/ai/prioritize/:ownerName", async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { ownerName } = req.params;
    const [rows] = await pool.query(
      "SELECT * FROM tasks WHERE owner_name = ? AND column_id != 'done'",
      [ownerName]
    );
    if (!rows.length) return res.json({ order: [], reasoning: "Aucune tâche active à prioriser." });

    const today    = new Date().toISOString().split("T")[0];
    const tasksStr = rows.map((t, i) =>
      `${i + 1}. ID:${t.id} | "${t.title}" | prio:${t.priority} | col:${t.column_id}` +
      ` | échéance:${t.deadline || "non définie"} | estimé:${t.estimated_hours || "?"}h` +
      ` | fait:${(t.timer_seconds / 3600).toFixed(1)}h`
    ).join("\n");

    const response = await groq.chat.completions.create({
      model:      "llama-3.3-70b-versatile",
      max_tokens: 800,
      messages: [{
        role:    "user",
        content: `Aujourd'hui : ${today}. Priorise ces tâches pour ${ownerName} (du plus urgent au moins urgent).\n\n` +
                 `${tasksStr}\n\n` +
                 `Réponds UNIQUEMENT avec un JSON valide :\n` +
                 `{"order": ["id1", "id2", ...], "reasoning": "explication courte en 2-3 phrases"}`,
      }],
    });

    const text      = response.choices[0].message.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let result;
    try {
      result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      result = { order: rows.map(r => r.id), reasoning: "Priorisation appliquée par date d'échéance." };
    }
    res.json(result);
  } catch (err) {
    console.error("POST /api/ai/prioritize", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : Rapport hebdomadaire ───────────────────────────────
async function generateAndSendReport() {
  const { employees, byOwner } = await getAllData();
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const dataStr = employees.map(e => {
    const tasks    = byOwner[e.name] || [];
    const done     = tasks.filter(t => t.column === "done").length;
    const inProg   = tasks.filter(t => t.column === "in_progress").length;
    const overdue  = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.column !== "done");
    const workedH  = tasks.reduce((s, t) => s + (t.timerSeconds || 0) / 3600, 0);
    return (
      `${e.name} (${e.role}, ${e.pole}): ` +
      `${done} terminées, ${inProg} en cours, ${tasks.length - done} restantes, ` +
      `${overdue.length} en retard, ${workedH.toFixed(1)}h travaillées. ` +
      `Retards: ${overdue.map(t => '"' + t.title + '"').join(", ") || "aucun"}`
    );
  }).join("\n");

  const response = await groq.chat.completions.create({
    model:      "llama-3.3-70b-versatile",
    max_tokens: 2000,
    messages: [{
      role:    "user",
      content: `Génère un rapport hebdomadaire professionnel pour l'équipe SOZAIS — ${today}.\n\n` +
               `Données :\n${dataStr}\n\n` +
               `Structure requise :\n` +
               `1. Résumé exécutif (2-3 phrases)\n` +
               `2. Performance Pôle Fluide\n` +
               `3. Performance Pôle Élec\n` +
               `4. Points d'attention (retards, surcharges)\n` +
               `5. Recommandations pour la semaine suivante\n\n` +
               `Style professionnel, en français.`,
    }],
  });

  const reportText = response.choices[0].message.content;
  if (mailer && process.env.REPORT_EMAIL) {
    await mailer.sendMail({
      from:    process.env.EMAIL_USER,
      to:      process.env.REPORT_EMAIL,
      subject: `📊 Rapport hebdomadaire SOZAIS — ${today}`,
      text:    reportText,
      html:    `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.6">${reportText}</pre>`,
    });
  }
  return reportText;
}

app.post("/api/ai/weekly-report", async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const report = await generateAndSendReport();
    res.json({ report, sent: !!(mailer && process.env.REPORT_EMAIL) });
  } catch (err) {
    console.error("POST /api/ai/weekly-report", err);
    res.status(500).json({ error: err.message });
  }
});

cron.schedule("0 18 * * 5", async () => {
  if (!groq) return;
  console.log("🤖 Rapport hebdo automatique...");
  try { await generateAndSendReport(); console.log("✅ Rapport envoyé."); }
  catch (err) { console.error("❌ Rapport:", err.message); }
});

// ─── API : Tâches ─────────────────────────────────────────────
app.get("/api/tasks/:ownerName", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM tasks WHERE owner_name = ? ORDER BY created_at ASC",
      [req.params.ownerName]
    );
    const tasks = rows.map(r => ({
      id:             r.id,
      title:          r.title,
      project:        r.project        || "",
      description:    r.description    || "",
      priority:       r.priority       || "medium",
      column:         r.column_id      || "todo",
      deadline:       r.deadline       || "",
      estimatedHours: r.estimated_hours != null ? String(r.estimated_hours) : "",
      timerSeconds:   r.timer_seconds  || 0,
      timerRunning:   !!r.timer_running,
      timerStartedAt: r.timer_started_at ? Number(r.timer_started_at) : null,
      createdAt:      r.created_at     || new Date().toISOString(),
      revenueAmount:  parseFloat(r.revenue_amount) || 0,
    }));
    res.json(tasks);
  } catch (err) {
    console.error("GET /api/tasks", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/:ownerName", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { ownerName } = req.params;
    const tasks = req.body;
    await conn.beginTransaction();
    await conn.query("DELETE FROM tasks WHERE owner_name = ?", [ownerName]);
    if (tasks && tasks.length > 0) {
      const values = tasks.map(t => [
        t.id, ownerName, t.title || "", t.project || "", t.description || "",
        t.priority || "medium", t.column || "todo", t.deadline || null,
        t.estimatedHours ? parseFloat(t.estimatedHours) : null,
        t.timerSeconds || 0, t.timerRunning ? 1 : 0, t.timerStartedAt || null,
        t.createdAt || new Date().toISOString(), parseFloat(t.revenueAmount) || 0,
      ]);
      await conn.query(
        `INSERT INTO tasks (id, owner_name, title, project, description, priority, column_id, deadline, estimated_hours, timer_seconds, timer_running, timer_started_at, created_at, revenue_amount) VALUES ?`,
        [values]
      );
    }
    await conn.commit();
    res.json({ ok: true, count: tasks ? tasks.length : 0 });
  } catch (err) {
    await conn.rollback();
    console.error("POST /api/tasks", err);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ─── API : Mots de passe ──────────────────────────────────────
app.get("/api/pwd/:name", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT password FROM passwords WHERE name = ?", [req.params.name]);
    res.json({ password: rows.length ? rows[0].password : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/pwd/:name", async (req, res) => {
  try {
    const { password } = req.body;
    await pool.query(
      `INSERT INTO passwords (name, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)`,
      [req.params.name, password]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Réinitialisation mot de passe (admin) ───────────────────
// DELETE /api/pwd/:name
app.delete("/api/pwd/:name", async (req, res) => {
  try {
    await pool.query("DELETE FROM passwords WHERE name = ?", [req.params.name]);
    res.json({ ok: true, message: `Mot de passe réinitialisé pour "${req.params.name}". Prochain login : kanban2026.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API : Employés ───────────────────────────────────────────
app.get("/api/employees", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM employees ORDER BY is_admin DESC, pole ASC, is_chef DESC, name ASC");
    res.json(rows.map(r => ({ name: r.name, role: r.role, pole: r.pole, isChef: !!r.is_chef, isAdmin: !!r.is_admin, tjm: parseFloat(r.tjm) || 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/employees", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const employees = req.body;
    await conn.beginTransaction();
    await conn.query("DELETE FROM employees WHERE is_admin = 0");
    const nonAdmins = employees.filter(e => !e.isAdmin);
    if (nonAdmins.length > 0) {
      const values = nonAdmins.map(e => [e.name, e.role, e.pole, e.isChef ? 1 : 0, 0, parseFloat(e.tjm) || 0]);
      await conn.query("INSERT INTO employees (name, role, pole, is_chef, is_admin, tjm) VALUES ?", [values]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ─── API : Frais fixes ────────────────────────────────────────
app.get("/api/fixed-costs", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM fixed_costs ORDER BY category");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/fixed-costs", async (req, res) => {
  try {
    const costs = req.body;
    const now = new Date().toISOString();
    for (const c of costs) {
      await pool.query(
        `INSERT INTO fixed_costs (category, label, amount_monthly, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE label=VALUES(label), amount_monthly=VALUES(amount_monthly), updated_at=VALUES(updated_at)`,
        [c.category, c.label, parseFloat(c.amount_monthly) || 0, now]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API : Projets ────────────────────────────────────────────
app.get("/api/projects", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM projects ORDER BY name");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/projects", async (req, res) => {
  try {
    const { name, revenue_forfait, revenue_mode, description } = req.body;
    await pool.query(
      `INSERT INTO projects (name, revenue_forfait, revenue_mode, description, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE revenue_forfait=VALUES(revenue_forfait), revenue_mode=VALUES(revenue_mode), description=VALUES(description)`,
      [name, parseFloat(revenue_forfait) || 0, revenue_mode || "forfait", description || "", new Date().toISOString()]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API : Rentabilité ────────────────────────────────────────
app.get("/api/profitability", async (req, res) => {
  try {
    const [tasks]     = await pool.query("SELECT t.*, e.tjm FROM tasks t LEFT JOIN employees e ON t.owner_name = e.name WHERE t.project != ''");
    const [projRows]  = await pool.query("SELECT * FROM projects");
    const [costsRows] = await pool.query("SELECT * FROM fixed_costs");

    const projMap = {};
    projRows.forEach(p => { projMap[p.name] = p; });
    const totalFixedMonthly = costsRows.reduce((s, c) => s + parseFloat(c.amount_monthly || 0), 0);

    const byProject = {};
    tasks.forEach(t => {
      if (!byProject[t.project]) byProject[t.project] = { tasks: [], collaborateurs: new Set() };
      byProject[t.project].tasks.push(t);
      byProject[t.project].collaborateurs.add(t.owner_name);
    });

    const projects = Object.entries(byProject).map(([projName, data]) => {
      const heures      = data.tasks.reduce((s, t) => s + (t.timer_seconds || 0) / 3600, 0);
      const coutMO      = data.tasks.reduce((s, t) => { const days = (t.timer_seconds || 0) / 3600 / 8; return s + days * (parseFloat(t.tjm) || 0); }, 0);
      const caLivrables = data.tasks.reduce((s, t) => s + (parseFloat(t.revenue_amount) || 0), 0);
      const projInfo    = projMap[projName];
      const caForfait   = projInfo ? parseFloat(projInfo.revenue_forfait) || 0 : 0;
      const revenueMode = projInfo ? projInfo.revenue_mode : "forfait";
      const caRetenu    = revenueMode === "livrables" ? caLivrables : caForfait;
      const margeBrute  = caRetenu - coutMO;
      const margePct    = caRetenu > 0 ? (margeBrute / caRetenu) * 100 : null;
      return {
        project: projName, heures: Math.round(heures * 10) / 10, cout_mo: Math.round(coutMO * 100) / 100,
        ca_livrables: Math.round(caLivrables * 100) / 100, ca_forfait: caForfait,
        revenue_mode: revenueMode, ca_retenu: Math.round(caRetenu * 100) / 100,
        marge_brute: Math.round(margeBrute * 100) / 100,
        marge_pct: margePct !== null ? Math.round(margePct * 10) / 10 : null,
        nb_taches: data.tasks.length, nb_collaborateurs: data.collaborateurs.size,
      };
    });
    projects.sort((a, b) => b.ca_retenu - a.ca_retenu);
    res.json({ projects, total_fixed_monthly: Math.round(totalFixedMonthly * 100) / 100, fixed_costs: costsRows });
  } catch (err) {
    console.error("GET /api/profitability", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API : KPI Critères ───────────────────────────────────────
app.get("/api/kpi/criteria", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM kpi_criteria ORDER BY position, id");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/kpi/criteria", async (req, res) => {
  try {
    const { label, category } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: "Label requis" });
    const [r] = await pool.query(
      "INSERT INTO kpi_criteria (label, category, position) VALUES (?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM kpi_criteria k2))",
      [label.trim(), category || "Personnalisé"]
    );
    res.json({ ok: true, id: r.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/kpi/criteria/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM kpi_criteria WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/kpi/criteria/:id", async (req, res) => {
  try {
    const { active } = req.body;
    await pool.query("UPDATE kpi_criteria SET active = ? WHERE id = ?", [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API : KPI Évaluations ────────────────────────────────────
app.get("/api/kpi/evaluations/:name", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM kpi_evaluations WHERE evaluated_name = ? ORDER BY created_at DESC",
      [req.params.name]
    );
    res.json(rows.map(r => ({ ...r, scores: typeof r.scores === 'string' ? JSON.parse(r.scores) : r.scores })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/kpi/summary", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT evaluated_name, scores, period, created_at FROM kpi_evaluations ORDER BY created_at DESC"
    );
    // Dernier score par personne
    const latest = {};
    for (const r of rows) {
      if (!latest[r.evaluated_name]) {
        const scores = typeof r.scores === 'string' ? JSON.parse(r.scores) : r.scores;
        const vals = Object.values(scores).filter(v => v > 0);
        const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
        latest[r.evaluated_name] = { period: r.period, avg: Math.round(avg * 10) / 10, count: vals.length };
      }
    }
    res.json(latest);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/kpi/evaluate", async (req, res) => {
  try {
    const { evaluator_name, evaluated_name, period, scores, overall_comment } = req.body;
    if (!evaluator_name || !evaluated_name || !period) return res.status(400).json({ error: "Champs requis manquants" });
    const id = Math.random().toString(36).substr(2, 9);
    await pool.query(
      "INSERT INTO kpi_evaluations (id, evaluator_name, evaluated_name, period, scores, overall_comment) VALUES (?, ?, ?, ?, ?, ?)",
      [id, evaluator_name, evaluated_name, period, JSON.stringify(scores || {}), overall_comment || ""]
    );
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Fallback → index.html ────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Kanban SOZAIS AI-First — http://localhost:${PORT}`);
  console.log(`   IA : ${groq ? "✅ Groq (LLaMA 3.3-70b) actif" : "❌ Clé GROQ_API_KEY manquante"}\n`);
});
