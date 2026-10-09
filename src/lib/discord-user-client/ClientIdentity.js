import { randomUUID, randomBytes } from "node:crypto";

import {
  FALLBACK_BUILD_NUMBER, parseBuildNumber, parseChromeMajor, chromeUserAgent,
  launchSignature, superProperties, gatewayProperties, encodeSuperProperties,
} from "./properties.js";

/** Chrome, якщо версію не вдалося дізнатися. Оновлювати раз на кілька місяців. */
export const FALLBACK_CHROME_MAJOR = 140;

const TIMEOUT_MS = 5_000;

/**
 * Ідентичність клієнта на один запуск: властивості для IDENTIFY, заголовки
 * для REST. Номер збірки — зі сторінки discord.com/login, версія Chrome — з
 * versionhistory.googleapis.com; недоступно — фолбеки і рядок у лог.
 *
 * @param {{ fetch?: typeof fetch, locale?: string, chromeMajor?: number|null,
 *           log?: (text: string, level?: string) => void, now?: () => number }} [opts]
 */
export async function resolveClientIdentity({
  fetch = globalThis.fetch, locale = "en-US", chromeMajor = null, log = () => {}, now = Date.now,
} = {}) {
  let major = chromeMajor;
  if (!major) {
    try {
      const res = await fetch("https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions",
        { signal: AbortSignal.timeout(TIMEOUT_MS) });
      major = res.ok ? parseChromeMajor(await res.json()) : null;
    } catch {
      major = null;
    }
    if (!major) {
      log(`Chrome version unknown, using ${FALLBACK_CHROME_MAJOR}`, "warning");
      major = FALLBACK_CHROME_MAJOR;
    }
  }
  const userAgent = chromeUserAgent(major);

  let buildNumber = null;
  try {
    const res = await fetch("https://discord.com/login", {
      headers: { "user-agent": userAgent, accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    buildNumber = res.ok ? parseBuildNumber(await res.text()) : null;
  } catch {
    buildNumber = null;
  }
  if (!buildNumber) {
    log(`client build number not found on discord.com/login, using ${FALLBACK_BUILD_NUMBER}`, "warning");
    buildNumber = FALLBACK_BUILD_NUMBER;
  }

  const props = superProperties({
    buildNumber,
    chromeMajor: major,
    locale,
    launchId: randomUUID(),
    heartbeatSessionId: randomUUID(),
    signature: launchSignature(randomBytes(16)),
  });
  return {
    buildNumber,
    chromeMajor: major,
    locale,
    userAgent,
    initializedAt: now(),
    superProperties: props,
    gatewayProperties: gatewayProperties(props),
    encodedSuperProperties: encodeSuperProperties(props),
  };
}
