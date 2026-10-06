/**
 * pm2 process definition for Inemuri (ROADMAP §2.3).
 *
 * Must be `.cjs`: the project is `"type": "module"`, and pm2 loads an
 * `ecosystem.config.js` as CommonJS — it would fail to parse on an ESM
 * project.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # survive a reboot
 *
 * See docs/DEPLOYMENT.md for the full deploy + migrate order.
 */
module.exports = {
  apps: [
    {
      name: "inemuri",
      script: "src/inemuri.js",

      // MUST be the app root. dotenv resolves `.env` relative to
      // process.cwd(), and the database is <cwd>/database/pot.sqlite;
      // starting from the wrong directory yields a process with no Telegram
      // credentials, or a fresh empty database, and no obvious reason why.
      // __dirname is the checkout this file lives in, wherever that is —
      // a hardcoded path here once disagreed with the real one.
      cwd: __dirname,

      // Load-bearing from phase 1 onward: cluster mode would start a second
      // process, a second enrichment worker, and silently double every AI
      // call (ROADMAP §13.1).
      instances: 1,
      exec_mode: "fork",

      // Explicit: the development path uses sync({ force: true }) and
      // recreates tables.
      env: { NODE_ENV: "production" },

      time: true, // timestamp pm2's own log lines
      autorestart: true,
      max_restarts: 10,
    },
  ],
};
