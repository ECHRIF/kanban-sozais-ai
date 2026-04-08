-- ============================================================
-- Kanban SOZAIS AI — Schéma MySQL
-- À exécuter UNE SEULE FOIS pour initialiser la base
-- (Compatible avec le schéma kanban-mysql existant)
-- ============================================================

-- Créer la base de données (si elle n'existe pas déjà)
CREATE DATABASE IF NOT EXISTS kanban_sozais
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE kanban_sozais;

-- ─── Table des tâches ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id               VARCHAR(20)    NOT NULL,
  owner_name       VARCHAR(200)   NOT NULL,
  title            VARCHAR(500)   NOT NULL,
  project          VARCHAR(300)   DEFAULT '',
  description      TEXT           DEFAULT '',
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Table des mots de passe ────────────────────────────────
CREATE TABLE IF NOT EXISTS passwords (
  name       VARCHAR(200) NOT NULL,
  password   VARCHAR(200) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Table des employés ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  name       VARCHAR(200) NOT NULL,
  role       VARCHAR(200) NOT NULL DEFAULT '',
  pole       VARCHAR(50)  NOT NULL DEFAULT 'Fluide',
  is_chef    TINYINT(1)   DEFAULT 0,
  is_admin   TINYINT(1)   DEFAULT 0,
  tjm        DECIMAL(8,2) DEFAULT 0,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Données initiales : liste des employés ─────────────────
INSERT IGNORE INTO employees (name, role, pole, is_chef, is_admin) VALUES
  ('Souha ARFAOUI',    'Cheffe Pôle Fluide',      'Fluide', 1, 0),
  ('Imen AZAZA',       'Ingénieure fluide',        'Fluide', 0, 0),
  ('Souha BEN HASSEN', 'Ingénieure fluide',        'Fluide', 0, 0),
  ('Chadha DAOUIDI',   'Ingénieure fluide',        'Fluide', 0, 0),
  ('Hamadi MTIRI',     'Projeteur fluide',         'Fluide', 0, 0),
  ('Abdelhak AMRI',    'Technicien sup fluide',    'Fluide', 0, 0),
  ('Nesrine KAYEL',    'Ingénieur fluide',         'Fluide', 0, 0),
  ('Nadhir GHOUMA',    'Technicien sup fluide',    'Fluide', 0, 0),
  ('Achraf SAOUDI',    'Ingénieur fluide',         'Fluide', 0, 0),
  ('Tayeb KSENTINI',   'Ingénieur fluide',         'Fluide', 0, 0),
  ('Chadha SAADAOUI',  'Ingénieur fluide',         'Fluide', 0, 0),
  ('Shayma MASTOURI',  'Ingénieur fluide',         'Fluide', 0, 0),
  ('Rihab ATTIA',      'Ingénieur fluide',         'Fluide', 0, 0),
  ('Fatma RHAIMI',     'Ingénieur fluide',         'Fluide', 0, 0),
  ('Sabah AJARRAR',    'Ingénieur fluide',         'Fluide', 0, 0),
  ('Majdi AMARA',      'Chef Pôle Élec',           'Élec',   1, 0),
  ('Yassine KHCHIMI',  'Ingénieur Elec',           'Élec',   0, 0),
  ('Rakia MANSOUR',    'Ingénieur Elec',           'Élec',   0, 0),
  ('Safa SOUAYAH',     'Ingénieur Elec',           'Élec',   0, 0),
  ('Rima MABROUKI',    'Ingénieur Elec',           'Élec',   0, 0),
  ('Mohamed KLII',     'Ingénieur Elec',           'Élec',   0, 0),
  ('Nadhmi JAMEL',     'Ingénieur Elec',           'Élec',   0, 0),
  ('Walid GHARBI',     'Ingénieur Elec',           'Élec',   0, 0),
  ('Wissem BEN TAHER', 'Ingénieur Elec',           'Élec',   0, 0),
  ('Hamza BEN AHMED',  'Technicien sup Elec',      'Élec',   0, 0),
  ('Amine DRONGA',     'Ingénieur Elec',           'Élec',   0, 0),
  ('Salma HANZOULI',   'Ingénieur Elec',           'Élec',   0, 0),
  ('M.O. HACHLEF',     'Ingénieur Elec',           'Élec',   0, 0),
  ('ECHRIF Walid',     'Admin',                    'Admin',  0, 1),
  ('ECHRIF Youssef',   'Admin',                    'Admin',  0, 1);

-- ─── Table des frais fixes mensuels ─────────────────────────
CREATE TABLE IF NOT EXISTS fixed_costs (
  category       VARCHAR(50)    NOT NULL,
  label          VARCHAR(200)   NOT NULL,
  amount_monthly DECIMAL(12,2)  DEFAULT 0,
  updated_at     VARCHAR(50)    DEFAULT NULL,
  PRIMARY KEY (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO fixed_costs (category, label, amount_monthly) VALUES
  ('loyer',            'Loyer & charges locatives',   0),
  ('licences',         'Licences logiciels',           0),
  ('charges_sociales', 'Charges sociales patronales',  0),
  ('frais_generaux',   'Autres frais généraux',        0);

-- ─── Table des projets (CA + mode facturation) ───────────────
CREATE TABLE IF NOT EXISTS projects (
  name             VARCHAR(300)   NOT NULL,
  revenue_forfait  DECIMAL(12,2)  DEFAULT 0,
  revenue_mode     VARCHAR(20)    DEFAULT 'forfait',
  description      TEXT           DEFAULT '',
  created_at       VARCHAR(50)    DEFAULT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Table de log des actions IA (optionnel — pour audit) ────
CREATE TABLE IF NOT EXISTS ai_actions_log (
  id          INT UNSIGNED   AUTO_INCREMENT NOT NULL,
  actor       VARCHAR(200)   NOT NULL,
  tool_name   VARCHAR(50)    NOT NULL,
  input_json  TEXT           DEFAULT NULL,
  result_json TEXT           DEFAULT NULL,
  created_at  DATETIME       DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_actor (actor),
  INDEX idx_tool  (tool_name),
  INDEX idx_date  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── Migrations (si upgrade depuis kanban-mysql) ─────────────
-- ALTER TABLE employees ADD COLUMN IF NOT EXISTS tjm DECIMAL(8,2) DEFAULT 0;
-- ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS revenue_amount DECIMAL(10,2) DEFAULT 0;

-- ─── Vérification ───────────────────────────────────────────
SELECT CONCAT('✅ ', COUNT(*), ' employés chargés dans la base.') AS statut
FROM employees;
