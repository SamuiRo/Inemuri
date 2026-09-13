/**
 * ESLint flat config (ESLint 9+).
 *
 * Замінює `.eslintrc.json`, який мовчки не працював: eslint не був у
 * залежностях узагалі, тож `npx eslint` тягнув з мережі свіжу версію, а вона
 * від v9 читає лише flat config і падала з міграційною помилкою. Тобто лінт у
 * проєкті не запускався ніяк, а `npm test` цього не ловив — lint не був
 * скриптом.
 *
 * Правила перенесені з `.eslintrc.json` один в один, з двома уточненнями,
 * описаними нижче.
 */

// Node ESM globals. Перелічені вручну, а не через пакет `globals`: список
// короткий і від нього не залежить нічого, крім лінту.
const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "database/**",
      "docs/**",
      "SourceBuilder.html",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      // "latest", а не фіксований рік: проєкт використовує import attributes
      // (`import x from "./y.json" with { type: "json" }`), яких espree не
      // розуміє нижче ES2025 — на app.config.js це давало parse error.
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      // `console.error` лишається дозволеним навмисно: код друкує стектрейс
      // поряд з print() там, де саме стектрейс і потрібен. Заборона стосується
      // console.log — за конвенцією (CLAUDE.md) вивід іде через print().
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // `null: "ignore"` — бо `x != null` у цьому коді свідома ідіома: одна
      // перевірка на null і undefined одразу. Переписати її на `!==` означало б
      // перестати ловити undefined, тобто змінити поведінку заради лінту.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-underscore-dangle": "off",
      "eol-last": ["error", "always"],
    },
  },
  {
    // shared/utils.js — це і є шар виводу: print() і banner() побудовані на
    // console.log. Забороняти його тут означало б забороняти реалізацію.
    files: ["src/shared/utils.js"],
    rules: { "no-console": "off" },
  },
  {
    // Базові адаптери: параметри абстрактних методів документують контракт
    // для підкласів. Перейменовувати їх на _foo заради лінту означало б
    // зіпсувати єдине місце, де цей контракт видно.
    files: ["src/**/base/*.js"],
    rules: { "no-unused-vars": ["warn", { args: "none" }] },
  },
  {
    // CLI друкує для людини, а не логує.
    files: ["src/cli.js", "scripts/**/*.js"],
    rules: { "no-console": "off" },
  },
  {
    files: ["test/**/*.js"],
    rules: { "no-console": "off" },
  },
];
