// Прогрес редагується в ту саму ephemeral-відповідь, не частіше за це.
const PROGRESS_EVERY_MS = 2_000;

/**
 * Прогрес довгої операції у відповідь: не частіше PROGRESS_EVERY_MS і не
 * більше одного редагування в польоті. `settle()` чекає останнє — після нього
 * можна писати фінальну відповідь, і запізнілий прогрес її не перезапише.
 *
 * @param {import("discord.js").RepliableInteraction} interaction
 * @returns {{ report: (text: string) => void, settle: () => Promise<void> }}
 */
export function throttledProgress(interaction) {
  let last = 0;
  let pending = Promise.resolve();
  let inFlight = false;

  return {
    report(text) {
      const now = Date.now();
      if (inFlight || now - last < PROGRESS_EVERY_MS) return;
      last = now;
      inFlight = true;
      pending = interaction
        .editReply({ content: text, components: [] })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    },
    settle: () => pending,
  };
}
