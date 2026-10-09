/**
 * Властивості клієнта — як їх шле веб-клієнт Discord у Chrome на Windows:
 * у IDENTIFY (`properties`) і в заголовку X-Super-Properties кожного REST-запиту.
 * Чисті функції; випадковість і номер збірки приходять аргументами.
 *
 * Поля — з discord.py-self, discord/tracking.py, HeadersContext.default().
 * Свідомо не беремо їхній info API (cordapi.dolfi.es): це сторонній сервіс;
 * номер збірки читаємо зі сторінки discord.com/login, як їхній фолбек.
 */

/** Номер збірки, якщо його не вдалося прочитати (як FALLBACK_BUILD_NUMBER там). */
export const FALLBACK_BUILD_NUMBER = 9999;

const BUILD_NUMBER_RE = /"BUILD_NUMBER":\s*"(\d+)"/;

/** Номер збірки зі сторінки discord.com/login, або null. */
export function parseBuildNumber(html) {
  const m = BUILD_NUMBER_RE.exec(String(html ?? ""));
  return m ? Number(m[1]) : null;
}

/** Мажорна версія Chrome з відповіді versionhistory.googleapis.com, або null. */
export function parseChromeMajor(json) {
  const v = json?.versions?.[0]?.version;
  const major = Number(String(v ?? "").split(".")[0]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

/** User-Agent Chrome на Windows (після UA reduction — лише мажорна версія). */
export function chromeUserAgent(major) {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Біти, які клієнт завжди ставить у нуль у підписі запуску
// (generate_launch_signature у tracking.py).
const LAUNCH_SIGNATURE_ZERO_BITS = BigInt(
  "0b00000000100000000001000000010000000010000001000000001000000000000010000010000001000000000100000000000001000000000000100000000000",
);
const U128 = (1n << 128n) - 1n;

/**
 * Підпис запуску: випадковий UUID із певними бітами в нулі.
 * @param {Uint8Array} bytes  16 випадкових байтів.
 */
export function launchSignature(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  n &= ~LAUNCH_SIGNATURE_ZERO_BITS & U128;
  const hex = n.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Super properties веб-клієнта.
 *
 * @param {{ buildNumber: number, chromeMajor: number, locale?: string,
 *           launchId: string, heartbeatSessionId: string, signature: string }} input
 */
export function superProperties({ buildNumber, chromeMajor, locale = "en-US", launchId, heartbeatSessionId, signature }) {
  return {
    os: "Windows",
    browser: "Chrome",
    device: "",
    system_locale: locale,
    browser_user_agent: chromeUserAgent(chromeMajor),
    browser_version: `${chromeMajor}.0.0.0`,
    os_version: "10",
    referrer: "",
    referring_domain: "",
    referrer_current: "",
    referring_domain_current: "",
    release_channel: "stable",
    client_build_number: buildNumber,
    client_event_source: null,
    has_client_mods: false,
    client_launch_id: launchId,
    client_app_state: "unfocused",
    client_heartbeat_session_id: heartbeatSessionId,
    launch_signature: signature,
  };
}

/** Те, що IDENTIFY шле поверх super properties. */
export const EXTRA_GATEWAY_PROPERTIES = Object.freeze({
  is_fast_connect: false,
  gateway_connect_reasons: "AppSkeleton",
});

export function gatewayProperties(superProps) {
  return { ...superProps, ...EXTRA_GATEWAY_PROPERTIES };
}

/** X-Super-Properties: base64 від JSON. */
export function encodeSuperProperties(superProps) {
  return Buffer.from(JSON.stringify(superProps), "utf8").toString("base64");
}
