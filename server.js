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
const { Resend } = require("resend");
const cron       = require("node-cron");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const rateLimit  = require("express-rate-limit");
const crypto     = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Trust proxy (Railway / load-balancer) ────────────────────
// Sans ça, express-rate-limit génère une ValidationError sur X-Forwarded-For
app.set("trust proxy", 1);

const JWT_SECRET      = process.env.JWT_SECRET || (() => { console.warn("⚠️  JWT_SECRET non défini — utilisation d'une clé temporaire (non sécurisé en production)"); return crypto.randomBytes(64).toString("hex"); })();
const BCRYPT_ROUNDS   = 12;
const DEFAULT_PASSWORD = "kanban2026";
const APP_URL         = process.env.APP_URL || "https://kanban-sozais-ai-production.up.railway.app";

// ─── CORS restreint ───────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || APP_URL + ",http://localhost:3000").split(",");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error("CORS: origine non autorisée"));
  },
  credentials: true
}));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Rate limiting ─────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 100,                     // 100 tentatives par IP (équipe sur même réseau)
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans 15 minutes." }
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 500 }); // équipe entière sur même IP
app.use("/api/", apiLimiter);

// ─── Middleware d'authentification JWT ────────────────────────
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Non authentifié" });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expirée, veuillez vous reconnecter" });
  }
}
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Accès réservé aux Super Admins" });
  next();
}

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
      CREATE TABLE IF NOT EXISTS reset_tokens (
        name       VARCHAR(200) NOT NULL,
        token      VARCHAR(128) NOT NULL,
        expires_at BIGINT       NOT NULL,
        PRIMARY KEY (name),
        UNIQUE KEY uq_token (token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS employees (
        name          VARCHAR(200) NOT NULL,
        role          VARCHAR(200) NOT NULL DEFAULT '',
        pole          VARCHAR(50)  NOT NULL DEFAULT 'Fluide',
        is_chef       TINYINT(1)   DEFAULT 0,
        is_admin      TINYINT(1)   DEFAULT 0,
        tjm           DECIMAL(8,2) DEFAULT 0,
        can_view_kpi  TINYINT(1)   DEFAULT 0,
        can_view_tjm  TINYINT(1)   DEFAULT 0,
        can_view_all  TINYINT(1)   DEFAULT 0,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Ajout des colonnes de permissions + email si elles n'existent pas encore (migration compatible MySQL 5.x)
    for (const col of ['can_view_kpi', 'can_view_tjm', 'can_view_all', 'email']) {
      const [cols] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='employees' AND COLUMN_NAME=?`,
        [col]
      );
      if (cols[0].cnt === 0) {
        const colDef = col === 'email' ? `VARCHAR(200) DEFAULT NULL` : `TINYINT(1) DEFAULT 0`;
        await conn.query(`ALTER TABLE employees ADD COLUMN ${col} ${colDef}`);
      }
    }
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
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id           INT UNSIGNED   AUTO_INCREMENT NOT NULL,
        recipient    VARCHAR(200)   NOT NULL,
        type         VARCHAR(50)    NOT NULL DEFAULT 'new_task',
        task_id      VARCHAR(20)    NOT NULL,
        task_title   VARCHAR(500)   NOT NULL,
        project      VARCHAR(300)   DEFAULT '',
        from_name    VARCHAR(200)   NOT NULL,
        seen         TINYINT(1)     DEFAULT 0,
        created_at   DATETIME       DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_recipient_seen (recipient, seen),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Migration : ajouter les colonnes manquantes dans tasks
    const taskMigrations = [
      ['project',    `ALTER TABLE tasks ADD COLUMN project    VARCHAR(300) DEFAULT ''`],
      ['created_by', `ALTER TABLE tasks ADD COLUMN created_by VARCHAR(200) DEFAULT NULL`],
      ['start_date', `ALTER TABLE tasks ADD COLUMN start_date VARCHAR(20)  DEFAULT NULL`],
    ];
    for (const [col, sql] of taskMigrations) {
      const [rows] = await conn.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tasks' AND COLUMN_NAME=?`,
        [col]
      );
      if (rows[0].cnt === 0) {
        await conn.query(sql);
        console.log(`✅ Migration tasks: ajout colonne ${col}`);
      }
    }

    // ─── Données initiales employees ──────────────────────────
    const employeesData = [
      ['Souha ARFAOUI',      'Cheffe Pôle Fluide',      'Fluide', 1, 0],
      ['Souha BEN HASSEN',   'Ingénieure fluide',       'Fluide', 0, 0],
      ['Chadha DAOUIDI',     'Ingénieure fluide',       'Fluide', 0, 0],
      ['Hamadi MTIRI',       'Projeteur fluide',        'Fluide', 0, 0],
      ['Abdelhak AMRI',      'Technicien sup fluide',   'Fluide', 0, 0],
      ['Nesrine KAYEL',      'Ingénieur fluide',        'Fluide', 0, 0],
      ['Nadhir GHOUMA',      'Technicien sup fluide',   'Fluide', 0, 0],
      ['Achraf SAOUDI',      'Ingénieur fluide',        'Fluide', 0, 0],
      ['Tayeb KSENTINI',     'Ingénieur fluide',        'Fluide', 0, 0],
      ['Chadha SAADAOUI',    'Ingénieur fluide',        'Fluide', 0, 0],
      ['Shayma MASTOURI',    'Ingénieur fluide',        'Fluide', 0, 0],
      ['Rihab ATTIA',        'Ingénieur fluide',        'Fluide', 0, 0],
      ['Sabah AJARRAR',      'Ingénieur fluide',        'Fluide', 0, 0],
      ['Emna GHRISSI',       'Ingénieure Elec',         'Élec',   0, 0],
      ['Eya JANDOUBI',       'Ingénieure Elec',         'Élec',   0, 0],
      ['Majdi AMARA',        'Chef Pôle Élec',          'Élec',   1, 0],
      ['Yassine KHCHIMI',    'Ingénieur Elec',          'Élec',   0, 0],
      ['Rakia MANSOUR',      'Ingénieur Elec',          'Élec',   0, 0],
      ['Safa SOUAYAH',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Rima MABROUKI',      'Ingénieur Elec',          'Élec',   0, 0],
      ['Mohamed KLII',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Nadhmi JAMEL',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Walid GHARBI',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Hamza BEN AHMED',    'Technicien sup Elec',     'Élec',   0, 0],
      ['Amine DRONGA',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Salma HANZOULI',     'Ingénieur Elec',          'Élec',   0, 0],
      ['M.O. HACHLEF',       'Ingénieur Elec',          'Élec',   0, 0],
      ['Rebecca DRUKIER',    'Ingénieur Elec',          'Élec',   0, 0],
      ['ECHRIF Walid',       'Admin',                   'Admin',      0, 1],
      ['ECHRIF Youssef',     'Admin',                   'Admin',      0, 1],
      ['Seif OUESLATI',      'Administrateur IT',       'Admin',      0, 1],
      ['Asma ATHIMNI',       'Directrice Commerciale',  'Commercial', 1, 0],
      ['Nourchene OUESLATI', 'Commerciale',             'Commercial', 0, 0],
    ];
    for (const emp of employeesData) {
      await conn.query(
        `INSERT IGNORE INTO employees (name, role, pole, is_chef, is_admin) VALUES (?, ?, ?, ?, ?)`,
        emp
      );
    }
    // ─── Utilisateurs administratifs Direction ─────────────────
    await conn.query(
      `INSERT INTO employees (name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all)
       VALUES (?, ?, 'Direction', 0, 0, 1, 0, 0)
       ON DUPLICATE KEY UPDATE role=VALUES(role), pole=VALUES(pole), can_view_kpi=1, can_view_tjm=0, can_view_all=0`,
      ['Maroua HTIRA', 'Assistante de direction']
    );
    await conn.query(
      `INSERT INTO employees (name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all)
       VALUES (?, ?, 'Direction', 0, 0, 0, 1, 0)
       ON DUPLICATE KEY UPDATE role=VALUES(role), pole=VALUES(pole), can_view_kpi=0, can_view_tjm=1, can_view_all=0`,
      ['Siwar HOSNI', 'Responsable financière']
    );
    await conn.query(
      `INSERT INTO employees (name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all)
       VALUES (?, ?, 'Direction', 1, 0, 0, 0, 1)
       ON DUPLICATE KEY UPDATE role=VALUES(role), pole=VALUES(pole), is_chef=1, can_view_kpi=0, can_view_tjm=0, can_view_all=1`,
      ['Marion CESA', 'Resp. administrative et financière']
    );
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

// ─── Mailer (Resend API — HTTP, pas SMTP) ─────────────────────
// Railway bloque les ports SMTP (587/465). On utilise l'API Resend
// qui passe par HTTPS (port 443), toujours ouvert.
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

if (resend) {
  console.log("✅ Mailer Resend configuré (API HTTP)");
} else {
  console.warn("⚠️  Mailer non configuré — RESEND_API_KEY manquant");
}

// Adresse d'envoi : domaine vérifié sur Resend, ou adresse par défaut
const FROM_EMAIL = process.env.RESEND_FROM || "Kanban SOZAIS <onboarding@resend.dev>";

// ─── Envoi email de notification (async, non-bloquant) ────────
async function sendNotifEmail(recipient, taskTitle, project, fromName, type = 'new_task') {
  if (!resend) return;
  try {
    const [rows] = await pool.query("SELECT email FROM employees WHERE name = ?", [recipient]);
    const email = rows[0]?.email;
    if (!email) return;

    const subject = type === 'new_task'
      ? `📋 Nouvelle tâche assignée : ${taskTitle}`
      : `🔔 Kanban SOZAIS : notification`;

    const projectLine = project ? `<p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">📁 Projet : <strong style="color:#e2e8f0">${project}</strong></p>` : '';

    const html = `
      <div style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;border-radius:12px;max-width:500px;margin:auto">
        <div style="font-size:22px;font-weight:700;margin-bottom:4px">Kanban <span style="color:#38bdf8">SOZAIS</span></div>
        <div style="font-size:11px;color:#64748b;margin-bottom:24px;border-bottom:1px solid #1e293b;padding-bottom:16px">Gestion de projets & équipes</div>

        <div style="background:#1e293b;border-radius:10px;padding:20px;margin-bottom:20px;border-left:4px solid #38bdf8">
          <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#f1f5f9">📋 ${taskTitle}</p>
          ${projectLine}
          <p style="margin:0;color:#94a3b8;font-size:13px">✏️ Assignée par <strong style="color:#e2e8f0">${fromName}</strong></p>
        </div>

        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
          Ouvrir le Kanban →
        </a>

        <p style="margin-top:24px;font-size:10px;color:#334155">Vous recevez cet email car une tâche vous a été assignée sur le Kanban SOZAIS.</p>
      </div>`;

    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html,
    });
    if (error) throw new Error(error.message);
    console.log(`   📧 Notif email envoyée → ${email}`);
  } catch (e) {
    console.warn("   ⚠️  sendNotifEmail :", e.message);
  }
}

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
  },
  {
    type: "function",
    function: {
      name: "search_tasks",
      description: "Recherche des tâches dans toute l'équipe par mot-clé, projet, collaborateur, priorité, colonne ou retard. Utiliser pour trouver des tâches spécifiques sans charger toutes les données.",
      parameters: {
        type: "object",
        properties: {
          keyword:      { type: "string", description: "Mot-clé dans le titre ou la description" },
          project:      { type: "string", description: "Nom du projet (partiel accepté)" },
          owner:        { type: "string", description: "Nom du collaborateur (partiel accepté)" },
          priority:     { type: "string", enum: ["high", "medium", "low"] },
          column:       { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
          overdue_only: { type: "boolean", description: "Si true, retourne uniquement les tâches en retard" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_kpi_summary",
      description: "Récupère les résultats d'évaluations KPI de l'équipe : scores moyens, évaluateurs, périodes. Utiliser pour répondre aux questions sur la performance des collaborateurs.",
      parameters: {
        type: "object",
        properties: {
          evaluated_name: { type: "string", description: "Nom du collaborateur évalué (optionnel — tous si absent)" },
          period:         { type: "string", description: "Période ex: '2026-Avr' (optionnel — toutes si absent)" }
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
      const summary = {
        totalTasks:      data.reduce((s, e) => s + e.stats.total, 0),
        totalOverdue:    data.reduce((s, e) => s + e.stats.overdue, 0),
        totalInProgress: data.reduce((s, e) => s + e.stats.inProgress, 0),
        totalDone:       data.reduce((s, e) => s + e.stats.done, 0),
        mostLoaded:      [...data].sort((a, b) => b.stats.inProgress - a.stats.inProgress)[0]?.name,
        mostOverdue:     [...data].sort((a, b) => b.stats.overdue  - a.stats.overdue)[0]?.name
      };
      return { ok: true, team: data, today, summary };
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

    case "search_tasks": {
      const { byOwner, employees } = await getAllData();
      const today = new Date().toISOString().split("T")[0];
      let all = [];
      for (const e of employees) {
        for (const t of (byOwner[e.name] || [])) {
          all.push({ ...t, _owner: e.name });
        }
      }
      let results = all;
      if (input.keyword) {
        const kw = input.keyword.toLowerCase();
        results = results.filter(t =>
          (t.title || "").toLowerCase().includes(kw) ||
          (t.description || "").toLowerCase().includes(kw)
        );
      }
      if (input.project) {
        const p = input.project.toLowerCase();
        results = results.filter(t => (t.project || "").toLowerCase().includes(p));
      }
      if (input.owner) {
        const o = input.owner.toLowerCase();
        results = results.filter(t => t._owner.toLowerCase().includes(o));
      }
      if (input.priority) results = results.filter(t => t.priority === input.priority);
      if (input.column)   results = results.filter(t => (t.column_id || t.column) === input.column);
      if (input.overdue_only) {
        results = results.filter(t => t.deadline && t.deadline < today && (t.column_id || t.column) !== "done");
      }
      return {
        ok: true, count: results.length,
        tasks: results.slice(0, 30).map(t => ({
          id: t.id, title: t.title, project: t.project, owner: t._owner,
          priority: t.priority, column: t.column_id || t.column,
          deadline: t.deadline || null,
          isOverdue: !!(t.deadline && t.deadline < today && (t.column_id || t.column) !== "done"),
          estimatedHours: t.estimated_hours
        }))
      };
    }

    case "get_kpi_summary": {
      let q = `SELECT e.evaluated_name, e.evaluator_name, e.period, e.overall_comment, e.created_at,
                      AVG(s.score) as avg_score, COUNT(s.id) as nb_criteria
               FROM kpi_evaluations e
               JOIN kpi_scores s ON s.evaluation_id = e.id
               WHERE 1=1`;
      const params = [];
      if (input.evaluated_name) { q += " AND e.evaluated_name LIKE ?"; params.push("%" + input.evaluated_name + "%"); }
      if (input.period)         { q += " AND e.period = ?"; params.push(input.period); }
      q += " GROUP BY e.id ORDER BY e.created_at DESC LIMIT 50";
      const [rows] = await pool.query(q, params);
      const byPerson = {};
      for (const r of rows) {
        if (!byPerson[r.evaluated_name]) byPerson[r.evaluated_name] = [];
        byPerson[r.evaluated_name].push({
          evaluator: r.evaluator_name,
          period: r.period,
          avgScore: Math.round(parseFloat(r.avg_score) * 10) / 10,
          nbCriteria: r.nb_criteria,
          comment: r.overall_comment || "",
          date: r.created_at
        });
      }
      return { ok: true, evaluations: byPerson, total: rows.length };
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
  const styleInstructions = {
    "professionnel": "Adopte un ton professionnel, structuré et précis.",
    "décontracté": "Adopte un ton décontracté et convivial, tout en restant efficace.",
    "coach motivant": "Adopte un ton de coach : encourage, motive, célèbre les succès de l'équipe.",
    "direct et concis": "Sois ultra-concis : pas de blabla, aller droit au but, réponses courtes.",
    "humouristique": "Ajoute une touche d'humour bienveillant dans tes réponses, tout en restant utile."
  }[style] || "Adopte un ton professionnel.";
  return (
    `Tu t'appelles ${name} — l'assistant IA de l'application Kanban SOZAIS.\n` +
    `Aujourd'hui : ${today}. Utilisateur connecté : ${userName} (${userRole}${isAdmin ? ", Admin" : isChef ? ", Chef" : ""}).\n` +
    `STYLE DE COMMUNICATION : ${styleInstructions}\n\n` +
    `TES CAPACITÉS :\n` +
    `- Tu peux CRÉER des tâches (create_task, bulk_create_tasks)\n` +
    `- Tu peux MODIFIER des tâches (update_task)\n` +
    `- Tu peux DÉPLACER des tâches entre colonnes (move_task)\n` +
    `- Tu peux RÉAFFECTER des tâches à d'autres collaborateurs (reassign_task)\n` +
    `- Tu peux SUPPRIMER des tâches (delete_task — demander confirmation d'abord)\n` +
    `- Tu peux ANALYSER toute l'équipe avec stats globales (get_team_data)\n` +
    `- Tu peux RECHERCHER des tâches par mot-clé/projet/priorité/retard (search_tasks)\n` +
    `- Tu peux CONSULTER les KPIs et évaluations de performance (get_kpi_summary)\n\n` +
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
app.post("/api/ai/agent", authenticate, async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { messages, agentName, agentStyle } = req.body;
    const { name: userName, role: userRole, isAdmin, isChef } = req.user;
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
          max_tokens:  4096,
          temperature: 0,
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
app.get("/api/ai/briefing/:userName", authenticate, async (req, res) => {
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
app.get("/api/ai/workload", authenticate, async (req, res) => {
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
app.post("/api/ai/prioritize/:ownerName", authenticate, async (req, res) => {
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
  let emailResult = null;
  if (resend && process.env.REPORT_EMAIL) {
    emailResult = await resend.emails.send({
      from:    FROM_EMAIL,
      to:      process.env.REPORT_EMAIL,
      subject: `📊 Rapport hebdomadaire SOZAIS — ${today}`,
      text:    reportText,
      html:    `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.6">${reportText}</pre>`,
    });
    console.log("📧 Resend result:", JSON.stringify(emailResult));
  }
  return { reportText, emailResult };
}

app.post("/api/ai/weekly-report", authenticate, async (req, res) => {
  if (!requireAI(res)) return;
  try {
    const { reportText, emailResult } = await generateAndSendReport();
    res.json({
      report: reportText,
      sent: !!(resend && process.env.REPORT_EMAIL),
      resend: emailResult,
      to: process.env.REPORT_EMAIL || null
    });
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
app.get("/api/tasks/:ownerName", authenticate, async (req, res) => {
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
      startDate:      r.start_date     || "",
      createdBy:      r.created_by     || "",
    }));
    res.json(tasks);
  } catch (err) {
    console.error("GET /api/tasks", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/tasks/:taskId/reassign ───────────────────────────────────────
// Réaffecte une tâche à un nouveau propriétaire sans toucher aux autres tâches.
// Body: { newOwner: "Nom Prenom" }
app.patch("/api/tasks/:taskId/reassign", authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;
    const { newOwner } = req.body;
    const actor = req.user?.name || null;
    if (!newOwner) return res.status(400).json({ error: "newOwner requis" });

    const [rows] = await pool.query("SELECT * FROM tasks WHERE id = ?", [taskId]);
    if (!rows.length) return res.status(404).json({ error: "Tâche introuvable" });
    const task = rows[0];
    const oldOwner = task.owner_name;

    const [emp] = await pool.query("SELECT name FROM employees WHERE name = ?", [newOwner]);
    if (!emp.length) return res.status(404).json({ error: `Collaborateur introuvable: "${newOwner}"` });

    await pool.query("UPDATE tasks SET owner_name = ? WHERE id = ?", [newOwner, taskId]);

    // Notification + email au nouveau propriétaire
    if (actor && actor !== newOwner) {
      await pool.query(
        `INSERT INTO notifications (recipient, type, task_id, task_title, project, from_name) VALUES (?, 'new_task', ?, ?, ?, ?)`,
        [newOwner, taskId, task.title || "Sans titre", task.project || "", actor]
      );
      sendNotifEmail(newOwner, task.title || "Sans titre", task.project || "", actor, 'new_task');
    }

    res.json({ ok: true, taskId, from: oldOwner, to: newOwner, title: task.title });
  } catch (err) {
    console.error("PATCH /api/tasks/reassign", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks/:ownerName", authenticate, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { ownerName } = req.params;
    const tasks = req.body;
    const actor = req.user?.name || null;

    await conn.beginTransaction();

    // Récupérer les IDs existants + état timer actuel (pour protéger les timers en cours)
    const [existingRows] = await conn.query(
      "SELECT id, timer_running, timer_started_at, timer_seconds FROM tasks WHERE owner_name = ?",
      [ownerName]
    );
    const existingIds  = new Set(existingRows.map(r => r.id));
    const runningInDB  = {};
    existingRows.forEach(r => { if (r.timer_running) runningInDB[r.id] = r; });

    // Seul le propriétaire peut arrêter son propre timer.
    // Si un admin/chef sauvegarde une tâche avec timerRunning=false alors que le serveur
    // l'a encore à true, on restaure l'état DB (évite la race condition).
    const isOwner = actor === ownerName;

    await conn.query("DELETE FROM tasks WHERE owner_name = ?", [ownerName]);
    if (tasks && tasks.length > 0) {
      const values = tasks.map(t => {
        const dbRunning = runningInDB[t.id];
        const preserveTimer = dbRunning && !t.timerRunning && !isOwner;
        return [
          t.id, ownerName, t.title || "", t.project || "", t.description || "",
          t.priority || "medium", t.column || "todo", t.deadline || null,
          t.estimatedHours ? parseFloat(t.estimatedHours) : null,
          preserveTimer ? dbRunning.timer_seconds : (t.timerSeconds || 0),
          preserveTimer ? 1 : (t.timerRunning ? 1 : 0),
          preserveTimer ? dbRunning.timer_started_at : (t.timerStartedAt || null),
          t.createdAt || new Date().toISOString(), parseFloat(t.revenueAmount) || 0,
          t.createdBy || actor || null,
          t.startDate || null,
        ];
      });
      await conn.query(
        `INSERT INTO tasks (id, owner_name, title, project, description, priority, column_id, deadline, estimated_hours, timer_seconds, timer_running, timer_started_at, created_at, revenue_amount, created_by, start_date) VALUES ?`,
        [values]
      );

      // Créer des notifications + envoyer emails pour les nouvelles tâches assignées
      if (actor && actor !== ownerName) {
        const newTasks = tasks.filter(t => !existingIds.has(t.id));
        if (newTasks.length > 0) {
          const notifValues = newTasks.map(t => [
            ownerName, 'new_task', t.id, t.title || "Sans titre", t.project || "", actor
          ]);
          await conn.query(
            `INSERT INTO notifications (recipient, type, task_id, task_title, project, from_name) VALUES ?`,
            [notifValues]
          );
          // Envoi email (async — ne bloque pas la réponse HTTP)
          for (const t of newTasks) {
            sendNotifEmail(ownerName, t.title || "Sans titre", t.project || "", actor, 'new_task');
          }
        }
      }
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

// ─── API AUTH ─────────────────────────────────────────────────

// GET /api/auth/users  (public — liste minimale pour l'écran de login)
app.get("/api/auth/users", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all, email FROM employees ORDER BY is_admin DESC, pole ASC, is_chef DESC, name ASC"
    );
    res.json(rows.map(r => ({
      name: r.name, role: r.role, pole: r.pole,
      isChef: !!r.is_chef, isAdmin: !!r.is_admin,
      canViewKPI: !!r.can_view_kpi, canViewTJM: !!r.can_view_tjm, canViewAll: !!r.can_view_all,
      email: r.email || null
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/login
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const { email, name, password } = req.body;
  const identifier = (email || name || "").trim();
  if (!identifier || !password) return res.status(400).json({ error: "Email et mot de passe requis" });
  try {
    // Recherche par email d'abord, puis par nom, puis par correspondance email→nom
    let emps;
    // 1) Recherche exacte par email stocké
    [emps] = await pool.query("SELECT * FROM employees WHERE LOWER(email) = LOWER(?)", [identifier]);
    // 2) Recherche exacte par nom
    if (!emps || !emps.length) {
      [emps] = await pool.query("SELECT * FROM employees WHERE name = ?", [identifier]);
    }
    // 3) Recherche intelligente : déduire initial + nom depuis la partie locale de l'email
    //    ex. "m.amara@sozais-ing.com" → initial="m", surname="amara" → trouve "Majdi AMARA"
    if (!emps || !emps.length) {
      const localPart = identifier.includes("@") ? identifier.split("@")[0] : identifier;
      const dotIdx = localPart.indexOf(".");
      if (dotIdx > 0) {
        const initial = localPart[0].toLowerCase();
        const surnamePart = localPart.slice(dotIdx + 1).toLowerCase().replace(/[^a-z]/g, "");
        const [candidates] = await pool.query(
          `SELECT * FROM employees WHERE LOWER(REPLACE(REPLACE(name,' ',''),'-','')) LIKE ?`,
          [`%${surnamePart}%`]
        );
        // Filtrer par initiale du prénom (premier ou dernier mot selon le format)
        const matched = candidates.filter(e => {
          const parts = e.name.trim().split(/\s+/);
          return parts.some(p => p[0] && p[0].toLowerCase() === initial);
        });
        if (matched.length === 1) emps = matched;
        else if (matched.length > 1) emps = [matched[0]]; // prendre le premier match
      }
    }
    if (!emps || !emps.length) return res.status(401).json({ error: "Identifiant inconnu" });
    const emp = emps[0];

    // Utiliser emp.name (nom réel en DB) pour chercher le mot de passe
    const [pwds] = await pool.query("SELECT password FROM passwords WHERE name = ?", [emp.name]);
    let isValid = false, firstLogin = false;

    if (!pwds.length) {
      // Aucun mot de passe défini → vérifier le mot de passe par défaut
      isValid = password === DEFAULT_PASSWORD;
      firstLogin = isValid;
    } else {
      const stored = pwds[0].password;
      if (stored.startsWith("$2b$") || stored.startsWith("$2a$")) {
        isValid = await bcrypt.compare(password, stored);
      } else {
        // Mot de passe en clair hérité → comparer puis re-hacher
        isValid = password === stored;
        if (isValid) {
          const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
          await pool.query("UPDATE passwords SET password = ? WHERE name = ?", [hashed, emp.name]);
        }
      }
    }

    if (!isValid) return res.status(401).json({ error: "Mot de passe incorrect" });

    const user = {
      name: emp.name, role: emp.role, pole: emp.pole,
      isChef: !!emp.is_chef, isAdmin: !!emp.is_admin,
      canViewKPI: !!emp.can_view_kpi, canViewTJM: !!emp.can_view_tjm, canViewAll: !!emp.can_view_all,
      email: emp.email || null
    };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "8h" });
    res.json({ token, user, firstLogin });
  } catch (err) {
    console.error("POST /api/auth/login", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// POST /api/auth/change-password  (authentifié)
app.post("/api/auth/change-password", authenticate, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "6 caractères minimum" });
  if (newPassword === DEFAULT_PASSWORD) return res.status(400).json({ error: "Choisissez un autre mot de passe" });
  try {
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(
      "INSERT INTO passwords (name, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)",
      [req.user.name, hashed]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// POST /api/auth/set-email  (authentifié)
app.post("/api/auth/set-email", authenticate, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Email invalide" });
  try {
    await pool.query("UPDATE employees SET email = ? WHERE name = ?", [email.toLowerCase().trim(), req.user.name]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// POST /api/auth/forgot-password  (public, rate-limité)
app.post("/api/auth/forgot-password", loginLimiter, async (req, res) => {
  const { name } = req.body;
  // Réponse identique qu'il y ait un email ou non (évite l'énumération d'utilisateurs)
  const genericResp = { ok: true, message: "Si un email est associé à ce compte, un lien de réinitialisation vous a été envoyé." };
  try {
    const [emps] = await pool.query("SELECT email FROM employees WHERE name = ?", [name]);
    if (!emps.length || !emps[0].email) return res.json(genericResp);

    const token   = crypto.randomBytes(48).toString("hex");
    const expires = Date.now() + 60 * 60 * 1000; // 1 heure
    await pool.query(
      "INSERT INTO reset_tokens (name, token, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE token = VALUES(token), expires_at = VALUES(expires_at)",
      [name, token, expires]
    );

    if (mailer) {
      const resetUrl = `${APP_URL}/?reset_token=${token}`;
      await mailer.sendMail({
        from: process.env.EMAIL_USER,
        to: emps[0].email,
        subject: "Réinitialisation de votre mot de passe — Kanban SOZAIS",
        html: `<p>Bonjour <strong>${name}</strong>,</p>
               <p>Cliquez sur ce lien pour réinitialiser votre mot de passe (valable 1 heure) :</p>
               <p><a href="${resetUrl}" style="background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Réinitialiser mon mot de passe</a></p>
               <p style="color:#888;font-size:12px">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>`
      });
    }
    res.json(genericResp);
  } catch (err) {
    console.error("POST /api/auth/forgot-password", err);
    res.json(genericResp); // ne pas révéler l'erreur
  }
});

// POST /api/auth/reset-password  (public)
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 6) return res.status(400).json({ error: "Données invalides" });
  if (newPassword === DEFAULT_PASSWORD) return res.status(400).json({ error: "Choisissez un autre mot de passe" });
  try {
    const [rows] = await pool.query("SELECT * FROM reset_tokens WHERE token = ?", [token]);
    if (!rows.length || rows[0].expires_at < Date.now()) return res.status(400).json({ error: "Lien invalide ou expiré" });

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query("INSERT INTO passwords (name, password) VALUES (?, ?) ON DUPLICATE KEY UPDATE password = VALUES(password)", [rows[0].name, hashed]);
    await pool.query("DELETE FROM reset_tokens WHERE token = ?", [token]);
    res.json({ ok: true, name: rows[0].name });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// DELETE /api/auth/reset/:name  (Super Admin — réinitialise le mot de passe d'un utilisateur)
app.delete("/api/auth/reset/:name", authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM passwords WHERE name = ?", [req.params.name]);
    res.json({ ok: true, message: `Mot de passe réinitialisé pour "${req.params.name}". Prochain login : ${DEFAULT_PASSWORD}` });
  } catch (err) { res.status(500).json({ error: "Erreur serveur" }); }
});

// ─── API : Employés ───────────────────────────────────────────
app.get("/api/employees", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM employees ORDER BY is_admin DESC, pole ASC, is_chef DESC, name ASC");
    res.json(rows.map(r => ({
      name: r.name, role: r.role, pole: r.pole,
      isChef: !!r.is_chef, isAdmin: !!r.is_admin,
      tjm: parseFloat(r.tjm) || 0,
      canViewKPI: !!r.can_view_kpi,
      canViewTJM: !!r.can_view_tjm,
      canViewAll: !!r.can_view_all,
      email: r.email || null
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/employees", authenticate, requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const employees = req.body;
    await conn.beginTransaction();
    // Supprimer uniquement les employés non-admin et non-Direction
    await conn.query("DELETE FROM employees WHERE is_admin = 0 AND can_view_kpi = 0 AND can_view_tjm = 0 AND can_view_all = 0");
    const nonAdmins = employees.filter(e => !e.isAdmin && !e.canViewKPI && !e.canViewTJM && !e.canViewAll);
    if (nonAdmins.length > 0) {
      const values = nonAdmins.map(e => [e.name, e.role, e.pole, e.isChef ? 1 : 0, 0, parseFloat(e.tjm) || 0, 0, 0, 0]);
      await conn.query("INSERT INTO employees (name, role, pole, is_chef, is_admin, tjm, can_view_kpi, can_view_tjm, can_view_all) VALUES ?", [values]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
});

// ─── API : Frais fixes ────────────────────────────────────────
app.get("/api/fixed-costs", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM fixed_costs ORDER BY category");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/fixed-costs", authenticate, requireAdmin, async (req, res) => {
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
app.get("/api/projects", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM projects ORDER BY name");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/projects", authenticate, async (req, res) => {
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
app.get("/api/profitability", authenticate, async (req, res) => {
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
app.get("/api/kpi/criteria", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM kpi_criteria ORDER BY position, id");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/kpi/criteria", authenticate, requireAdmin, async (req, res) => {
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

app.delete("/api/kpi/criteria/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM kpi_criteria WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/kpi/criteria/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    await pool.query("UPDATE kpi_criteria SET active = ? WHERE id = ?", [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── API : KPI Évaluations ────────────────────────────────────
app.get("/api/kpi/evaluations/:name", authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM kpi_evaluations WHERE evaluated_name = ? ORDER BY created_at DESC",
      [req.params.name]
    );
    res.json(rows.map(r => ({ ...r, scores: typeof r.scores === 'string' ? JSON.parse(r.scores) : r.scores })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/kpi/summary", authenticate, async (req, res) => {
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

app.post("/api/kpi/evaluate", authenticate, async (req, res) => {
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

// ─── API NOTIFICATIONS ────────────────────────────────────────

// GET /api/notifications  — retourne les notifs non lues + les 20 dernières lues
app.get("/api/notifications", authenticate, async (req, res) => {
  try {
    const name = req.user.name;
    const [rows] = await pool.query(
      `SELECT id, type, task_id, task_title, project, from_name, seen, created_at
       FROM notifications
       WHERE recipient = ?
       ORDER BY created_at DESC
       LIMIT 30`,
      [name]
    );
    res.json(rows.map(r => ({
      id:         r.id,
      type:       r.type,
      taskId:     r.task_id,
      taskTitle:  r.task_title,
      project:    r.project || "",
      fromName:   r.from_name,
      seen:       !!r.seen,
      createdAt:  r.created_at,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/seen  — marque toutes les notifs de l'utilisateur comme lues
app.post("/api/notifications/seen", authenticate, async (req, res) => {
  try {
    const name = req.user.name;
    const { ids } = req.body; // optionnel : tableau d'IDs spécifiques
    if (ids && ids.length > 0) {
      await pool.query(
        `UPDATE notifications SET seen = 1 WHERE recipient = ? AND id IN (?)`,
        [name, ids]
      );
    } else {
      await pool.query(
        `UPDATE notifications SET seen = 1 WHERE recipient = ?`,
        [name]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/notifications  — supprime les notifs lues de + de 7 jours (nettoyage auto)
app.delete("/api/notifications/old", authenticate, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query(
      `DELETE FROM notifications WHERE seen = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Fallback → index.html ────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Seed : ajouter les membres manquants au démarrage ────────
async function seedMissingEmployees() {
  try {
    // ─── Supprimer les employés qui ont quitté l'équipe ──────
    const toDelete = ['Warden EL FEKIH', 'Imen AZAZA', 'Fatma RHAIMI', 'Wissem BEN TAHER', 'IT SOZAIS'];
    for (const name of toDelete) {
      await pool.query(
        `DELETE FROM employees WHERE name = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE owner_name = ?)`,
        [name, name]
      );
    }

    const missing = [
      // Pôle Commercial
      ['Asma ATHIMNI',       'Directrice Commerciale', 'Commercial', 1, 0, 0, 0, 0],
      ['Nourchene OUESLATI', 'Commerciale',             'Commercial', 0, 0, 0, 0, 0],
      ['Warden EL FEKIH',    'Commercial',              'Commercial', 0, 0, 0, 0, 0],
      // Pôle Direction
      ['Maroua HTIRA',  'Assistante de direction',              'Direction', 0, 0, 1, 0, 0],
      ['Siwar HOSNI',   'Responsable financière',               'Direction', 0, 0, 0, 1, 0],
      ['Marion CESA',   'Resp. administrative et financière',   'Direction', 1, 0, 0, 0, 1],
      // Admin supplémentaire
      ['Seif OUESLATI', 'Administrateur IT', 'Admin', 0, 1, 0, 0, 0],
      ['ECHRIF Youssef','Admin',             'Admin', 0, 1, 0, 0, 0],
    ];
    for (const [name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all] of missing) {
      await pool.query(
        `INSERT IGNORE INTO employees (name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, role, pole, is_chef, is_admin, can_view_kpi, can_view_tjm, can_view_all]
      );
    }

    // ─── Seed emails : pattern prenom-initial.nom@sozais-ing.com ──
    // Remplit uniquement les emails manquants (UPDATE si email IS NULL)
    const emailsMap = [
      ['Souha ARFAOUI',      's.arfaoui@sozais-ing.com'],
      ['Souha BEN HASSEN',   's.benhassen@sozais-ing.com'],
      ['Chadha DAOUIDI',     'c.daouidi@sozais-ing.com'],
      ['Hamadi MTIRI',       'h.mtiri@sozais-ing.com'],
      ['Abdelhak AMRI',      'a.amri@sozais-ing.com'],
      ['Nesrine KAYEL',      'n.kayel@sozais-ing.com'],
      ['Nadhir GHOUMA',      'n.ghouma@sozais-ing.com'],
      ['Achraf SAOUDI',      'a.saoudi@sozais-ing.com'],
      ['Tayeb KSENTINI',     't.ksentini@sozais-ing.com'],
      ['Chadha SAADAOUI',    'c.saadaoui@sozais-ing.com'],
      ['Shayma MASTOURI',    's.mastouri@sozais-ing.com'],
      ['Rihab ATTIA',        'r.attia@sozais-ing.com'],
      ['Sabah AJARRAR',      's.ajarrar@sozais-ing.com'],
      ['Emna GHRISSI',       'e.ghrissi@sozais-ing.com'],
      ['Eya JANDOUBI',       'e.jandoubi@sozais-ing.com'],
      ['Majdi AMARA',        'm.amara@sozais-ing.com'],
      ['Yassine KHCHIMI',    'y.khchimi@sozais-ing.com'],
      ['Rakia MANSOUR',      'r.mansour@sozais-ing.com'],
      ['Safa SOUAYAH',       's.souayah@sozais-ing.com'],
      ['Rima MABROUKI',      'r.mabrouki@sozais-ing.com'],
      ['Mohamed KLII',       'm.klii@sozais-ing.com'],
      ['Nadhmi JAMEL',       'n.jamel@sozais-ing.com'],
      ['Walid GHARBI',       'w.gharbi@sozais-ing.com'],
      ['Hamza BEN AHMED',    'h.benahmed@sozais-ing.com'],
      ['Amine DRONGA',       'a.dronga@sozais-ing.com'],
      ['Salma HANZOULI',     's.hanzouli@sozais-ing.com'],
      ['M.O. HACHLEF',       'm.hachlef@sozais-ing.com'],
      ['Rebecca DRUKIER',    'r.drukier@sozais-ing.com'],
      ['ECHRIF Walid',       'w.echrif@sozais-ing.com'],
      ['ECHRIF Youssef',     'y.echrif@sozais-ing.com'],
      ['Seif OUESLATI',      'tech.info@sozais-ing.com'],
      ['Asma ATHIMNI',       'a.athimni@sozais-ing.com'],
      ['Nourchene OUESLATI', 'n.oueslati@sozais-ing.com'],
      ['Maroua HTIRA',       'm.htira@sozais-ing.com'],
      ['Siwar HOSNI',        's.hosni@sozais-ing.com'],
      ['Marion CESA',        'm.cesa@sozais-ing.com'],
    ];
    for (const [name, email] of emailsMap) {
      await pool.query(
        `UPDATE employees SET email = ? WHERE name = ? AND (email IS NULL OR email = '')`,
        [email, name]
      );
    }
    console.log("   ✅ Seed employés manquants + emails OK");
  } catch (e) {
    console.warn("   ⚠️  Seed employés :", e.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n🚀 Kanban SOZAIS AI-First — http://localhost:${PORT}`);
  console.log(`   IA : ${groq ? "✅ Groq (LLaMA 3.3-70b) actif" : "❌ Clé GROQ_API_KEY manquante"}\n`);
  seedMissingEmployees();
});
