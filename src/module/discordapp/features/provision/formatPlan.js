/**
 * План провіжну → текст для людини. Чиста функція.
 */

const SYMBOL = {
  create: "+ create ",
  adopt: "⇄ adopt  ",
  update: "~ update ",
  archive: "→ archive",
  restore: "← restore",
  reorder: "↕ reorder",
  forget: "· forget ",
  orphaned: "⚠ orphaned",
  skip: "⏭ skip   ",
};

const SECTIONS = [
  ["Roles", (op) => op.kind === "role" && op.phase !== "report" && op.op !== "reorder"],
  ["Categories", (op) => op.kind === "category" && op.phase !== "report"],
  ["Channels", (op) => op.kind === "channel" && op.phase !== "report" && op.op !== "reorder"],
  ["Order", (op) => op.op === "reorder"],
  ["Left alone", (op) => op.phase === "report"],
];

// Скільки некерованих назв показувати, решту — числом.
const UNMANAGED_SHOWN = 8;

/**
 * @param {object} plan              planProvision()
 * @param {object} options
 * @param {string} options.configName  Ім'я файлу конфігу.
 * @param {string[]} options.blockers  Що заважає apply (preflight).
 * @returns {string}
 */
export function formatPlan(plan, { configName, blockers = [] }) {
  const lines = [`**Provision plan — ${plan.guildName}** (\`${configName}\`)`];

  for (const [title, belongs] of SECTIONS) {
    const ops = plan.ops.filter(belongs);
    if (!ops.length) continue;
    lines.push("", `**${title}**`);
    for (const op of ops) lines.push(...formatOp(op));
  }

  const unmanaged = formatUnmanaged(plan.unmanaged);
  if (unmanaged.length) lines.push("", "**Not in the config (never touched)**", ...unmanaged);

  if (plan.errors.length) {
    lines.push("", "**Errors — fix before applying**", ...plan.errors.map((error) => `✖ ${error}`));
  }
  if (blockers.length) {
    lines.push("", "**Apply needs**", ...blockers.map((blocker) => `⚠ ${blocker}`));
  }

  lines.push("", summaryLine(plan));
  return lines.join("\n");
}

export function summaryLine(plan) {
  const counts = new Map();
  for (const op of plan.ops) {
    if (op.phase === "report") continue;
    counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
  }
  if (counts.size === 0) return "✅ The server already matches the config.";
  const parts = [...counts].map(([op, n]) => `${n} ${op}`);
  return `Σ ${parts.join(", ")}.`;
}

const NOTE = {
  forget: " — deleted on Discord, dropping it from state",
  orphaned: " — no longer in the config",
  skip: " — Community servers only",
};

function formatOp(op) {
  let head = `\`${SYMBOL[op.op] ?? op.op}\` ${op.op === "reorder" ? op.name : targetLabel(op)}`;
  if (op.op === "create" && op.spec?.parentKey) head += ` in "${op.spec.parentKey}"`;
  if (op.op === "archive" && op.parentKey) head += ` (from "${op.parentKey}")`;
  head += NOTE[op.op] ?? "";

  const changes = (op.changes ?? []).map((change) => `    · ${change}`);
  if (op.op === "adopt" && !changes.length) changes.push("    · matched by name, already as configured");
  return [head, ...changes];
}

function targetLabel(op) {
  if (op.kind === "role") return `@${op.name}`;
  if (op.kind === "category") return `📁 ${op.name}`;
  return `#${op.name}`;
}

function formatUnmanaged({ roles, categories, channels }) {
  const lines = [];
  const list = (label, names, prefix) => {
    if (!names.length) return;
    const shown = names.slice(0, UNMANAGED_SHOWN).map((name) => `${prefix}${name}`).join(", ");
    const more = names.length > UNMANAGED_SHOWN ? ` …+${names.length - UNMANAGED_SHOWN}` : "";
    lines.push(`? ${label}: ${shown}${more}`);
  };
  list("roles", roles, "@");
  list("categories", categories, "");
  list("channels", channels, "#");
  return lines;
}
