import { isValidTimeZone } from "./time.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type Config = {
  baseUrl: string;
  apiToken: string;
  timeZone: string | undefined;
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiToken = env.KIMAI_API_TOKEN?.trim();

  if (!apiToken) {
    throw new Error(
      "KIMAI_API_TOKEN is not set. Create an API token in your Kimai profile and pass it through the environment.",
    );
  }

  const baseUrl = env.KIMAI_BASE_URL?.trim();

  if (!baseUrl) {
    throw new Error("KIMAI_BASE_URL is not set. Pass your Kimai instance URL through the environment.");
  }

  const timeZone = env.KIMAI_TIMEZONE?.trim() || undefined;

  if (timeZone && !isValidTimeZone(timeZone)) {
    throw new Error(`KIMAI_TIMEZONE "${timeZone}" is not a valid IANA time zone (for example America/Sao_Paulo).`);
  }

  return {
    baseUrl: parseBaseUrl(baseUrl),
    apiToken,
    timeZone,
  };
}

function parseBaseUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`KIMAI_BASE_URL "${raw}" is not a valid URL.`);
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error("KIMAI_BASE_URL must use https:// (plain http is only allowed for localhost).");
  }

  return url.origin + url.pathname.replace(/\/+$/, "");
}
