import { KimaiError, type KimaiClient } from "./kimai.ts";
import { User } from "./schemas.ts";
import { isValidTimeZone } from "./time.ts";

export type TimeZoneInfo = {
  name: string;
  source: "kimai-account" | "KIMAI_TIMEZONE";
};

/**
 * Kimai interprets every datetime we send in the account's time zone, so that zone
 * (not the process zone) drives validation and "now". It is fetched once per process.
 */
export class Account {
  readonly #client: KimaiClient;
  readonly #configuredTimeZone: string | undefined;
  #timeZone: TimeZoneInfo | undefined;

  constructor(client: KimaiClient, configuredTimeZone: string | undefined) {
    this.#client = client;
    this.#configuredTimeZone = configuredTimeZone;
  }

  async me(): Promise<{ user: User; timeZone: TimeZoneInfo }> {
    const user = await this.#client.get("/users/me", User);
    this.#timeZone = resolveTimeZone(user.timezone, this.#configuredTimeZone);

    return { user, timeZone: this.#timeZone };
  }

  async timeZone(): Promise<TimeZoneInfo> {
    return this.#timeZone ?? (await this.me()).timeZone;
  }
}

function resolveTimeZone(accountZone: string | null | undefined, configuredZone: string | undefined): TimeZoneInfo {
  if (accountZone && isValidTimeZone(accountZone)) {
    if (configuredZone && configuredZone !== accountZone) {
      throw new KimaiError(
        `KIMAI_TIMEZONE (${configuredZone}) differs from the Kimai account time zone (${accountZone}). ` +
          "Kimai interprets times in the account zone: change the account setting or remove KIMAI_TIMEZONE.",
      );
    }

    return { name: accountZone, source: "kimai-account" };
  }

  if (configuredZone) {
    return { name: configuredZone, source: "KIMAI_TIMEZONE" };
  }

  throw new KimaiError(
    "Could not determine the Kimai account time zone from /api/users/me. " +
      "Set KIMAI_TIMEZONE to the account's IANA zone.",
  );
}
