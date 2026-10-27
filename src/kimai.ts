import type { z } from "zod";
import type { Config } from "./config.ts";

const TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 600;
const PROBABLY_APPLIED = "The change was probably applied. Check the current state before retrying.";
const EXTRA_FIELDS_HINT =
  " Some fields (begin/end outside the default tracking mode, billable) may not be API-editable for this account.";

type Query = Record<string, string | number | boolean | undefined>;
type WriteMethod = "POST" | "PATCH";

export class KimaiError extends Error {}

export class UnknownOutcomeError extends Error {}

export type Page<T> = {
  items: T[];
  page: number;
  totalCount: number | null;
  totalPages: number | null;
};

export class KimaiClient {
  readonly #baseUrl: string;
  readonly #apiToken: string;

  constructor(config: Pick<Config, "baseUrl" | "apiToken">) {
    this.#baseUrl = config.baseUrl;
    this.#apiToken = config.apiToken;
  }

  async get<S extends z.ZodType>(path: string, schema: S, query: Query = {}): Promise<z.output<S>> {
    const { body } = await this.#read(path, query);

    return this.#parse(schema, body, `GET ${path}`);
  }

  async getPage<S extends z.ZodType>(path: string, schema: S, query: Query): Promise<Page<z.output<S>>> {
    const { body, headers } = await this.#read(path, query);
    const items = this.#parse(schema.array(), body, `GET ${path}`);

    return {
      items,
      page: Number(query.page ?? 1),
      totalCount: integerHeader(headers, "X-Total-Count"),
      totalPages: integerHeader(headers, "X-Total-Pages"),
    };
  }

  async write<S extends z.ZodType>(
    method: WriteMethod,
    path: string,
    schema: S,
    payload?: Record<string, unknown>,
    query: Query = {},
  ): Promise<z.output<S>> {
    const action = `${method} ${path}`;
    let response: Response;

    try {
      response = await this.#send(method, path, query, payload);
    } catch (error) {
      throw new UnknownOutcomeError(
        `${action} was sent but no response arrived (${this.#reason(error)}). ` +
          "It may or may not have been applied. Check the current state before retrying.",
      );
    }

    if (response.status >= 500) {
      throw new UnknownOutcomeError(
        `${action} failed with HTTP ${response.status}${await this.#describe(response)}. ` +
          "Kimai may still have applied it. Check the current state before retrying.",
      );
    }

    await this.#rejectFailure(response, action);

    let body: unknown;

    try {
      body = await readJson(response);
    } catch (error) {
      throw new UnknownOutcomeError(
        `${action} returned HTTP ${response.status} but its response could not be read (${this.#reason(error)}). ` +
          PROBABLY_APPLIED,
      );
    }

    if (isValidationBody(body)) {
      throw new KimaiError(`Kimai rejected ${action}: ${this.#redact(validationDetails(body))}`);
    }

    const result = schema.safeParse(body);

    if (!result.success) {
      throw new UnknownOutcomeError(
        `${action} returned HTTP ${response.status} but an unrecognized response (${issueSummary(result.error)}). ` +
          PROBABLY_APPLIED,
      );
    }

    return result.data;
  }

  async #read(path: string, query: Query): Promise<{ body: unknown; headers: Headers }> {
    const action = `GET ${path}`;
    let response: Response;

    try {
      response = await this.#send("GET", path, query);
    } catch (error) {
      throw new KimaiError(`Could not reach Kimai at ${this.#baseUrl} (${this.#reason(error)}).`);
    }

    await this.#rejectFailure(response, action);

    try {
      return { body: await readJson(response), headers: response.headers };
    } catch (error) {
      throw new KimaiError(
        `${action} returned a response that could not be read as JSON (${this.#reason(error)}). ` +
          "Is KIMAI_BASE_URL pointing at a Kimai instance?",
      );
    }
  }

  #send(method: "GET" | WriteMethod, path: string, query: Query, payload?: Record<string, unknown>): Promise<Response> {
    const url = new URL(`${this.#baseUrl}/api${path}`);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#apiToken}`,
    };

    if (payload) {
      headers["Content-Type"] = "application/json";
    }

    return fetch(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : null,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async #rejectFailure(response: Response, action: string): Promise<void> {
    if (!response.ok) {
      throw new KimaiError(this.#statusMessage(response.status, action, await this.#describe(response)));
    }
  }

  #parse<S extends z.ZodType>(schema: S, body: unknown, action: string): z.output<S> {
    if (isValidationBody(body)) {
      throw new KimaiError(`Kimai rejected ${action}: ${this.#redact(validationDetails(body))}`);
    }

    const result = schema.safeParse(body);

    if (!result.success) {
      throw new KimaiError(`${action} returned data in an unexpected shape (${issueSummary(result.error)}).`);
    }

    return result.data;
  }

  #statusMessage(status: number, action: string, details: string): string {
    switch (status) {
      case 400: {
        const hint = /extra fields/i.test(details) ? EXTRA_FIELDS_HINT : "";

        return `Kimai rejected ${action} (HTTP 400)${details}.${hint}`;
      }
      case 401:
        return (
          "Kimai rejected the API token (HTTP 401). " +
          "Check that KIMAI_API_TOKEN is a valid, unexpired API token for this instance."
        );
      case 403:
        return (
          `Kimai denied ${action} (HTTP 403)${details}. ` +
          "The entry may be locked (exported, or inside a lockdown period) or the account lacks this permission."
        );
      case 404:
        return `Not found: ${action} (HTTP 404)${details}.`;
      default:
        return `${action} failed with HTTP ${status}${details}.`;
    }
  }

  async #describe(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    let details = "";

    try {
      const body: unknown = JSON.parse(text);
      details = isValidationBody(body) ? validationDetails(body) : messageOf(body);
    } catch {}

    details = this.#redact(details).slice(0, MAX_MESSAGE_LENGTH).replace(/\.$/, "");

    return details ? `: ${details}` : "";
  }

  #reason(error: unknown): string {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return `timed out after ${TIMEOUT_MS / 1000}s`;
    }

    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const message = error instanceof Error ? error.message : String(error);

    return this.#redact(cause ? `${message}: ${cause}` : message);
  }

  #redact(text: string): string {
    return text.split(this.#apiToken).join("[redacted]");
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  return text === "" ? null : JSON.parse(text);
}

function issueSummary(error: z.ZodError): string {
  const issue = error.issues[0];

  return `${issue?.path.join(".") || "response"}: ${issue?.message}`;
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = Number.parseInt(headers.get(name) ?? "", 10);

  return Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(body: unknown): string {
  return isRecord(body) && typeof body.message === "string" ? body.message : "";
}

function isValidationBody(body: unknown): body is { errors: unknown } {
  return isRecord(body) && isRecord(body.errors) && !("id" in body);
}

function validationDetails(body: { errors: unknown }): string {
  const found: string[] = [];

  collectErrors(body.errors, "", found);

  return found.length > 0 ? found.join("; ") : messageOf(body) || "validation failed";
}

function collectErrors(node: unknown, field: string, found: string[]): void {
  if (!isRecord(node)) {
    return;
  }

  if (Array.isArray(node.errors)) {
    for (const error of node.errors) {
      found.push(field ? `${field}: ${String(error)}` : String(error));
    }
  }

  if (isRecord(node.children)) {
    for (const [child, value] of Object.entries(node.children)) {
      collectErrors(value, field ? `${field}.${child}` : child, found);
    }
  }
}
