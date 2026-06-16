// ─── reset-tasks.js ───────────────────────────────────────────
// Supprime toutes les cartes de la table `tasks`.
// Usage : node reset-tasks.js
// ──────────────────────────────────────────────────────────────
require("dotenv").config();
const mysql = require("mysql2/promise");

(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || "localhost",
    port:     parseInt(process.env.DB_PORT || "3306"),
    user:     process.env.DB_USER     || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME     || "kanban_sozais",
  });

  const [res] = await conn.execute("DELETE FROM tasks");
  console.log(`✅ ${res.affectedRows} carte(s) supprimée(s).`);
  await conn.end();
})().catch((err) => {
  console.error("❌ Erreur :", err.message);
  process.exit(1);
});
