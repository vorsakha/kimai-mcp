import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { localToEpoch, parseLocalDateTime } from "../src/time.ts";

test("local date-times are normalized to Kimai's write format and malformed values are rejected", () => {
  assert.equal(parseLocalDateTime("2026-10-25T09:00"), "2026-10-25T09:00:00");
  assert.equal(parseLocalDateTime("2026-10-25T09:00:15"), "2026-10-25T09:00:15");

  for (const invalid of [
    "2026-10-25T09:00:00Z",
    "2026-10-25T09:00:00-03:00",
    "2026-10-25 09:00",
    "2026-02-30T10:00",
    "2026-10-25T24:00",
  ]) {
    assert.throws(() => parseLocalDateTime(invalid), /not a valid local date-time/, invalid);
  }
});

test("wall-clock times resolve in the account zone, rejecting DST gaps and overlaps", () => {
  assert.equal(localToEpoch("2026-10-25T09:00:00", "America/Sao_Paulo"), Date.parse("2026-10-25T12:00:00Z"));
  assert.equal(localToEpoch("2026-07-01T09:00:00", "Europe/Berlin"), Date.parse("2026-07-01T07:00:00Z"));
  assert.equal(localToEpoch("2026-11-01T03:00:00", "America/New_York"), Date.parse("2026-11-01T08:00:00Z"));

  assert.throws(() => localToEpoch("2026-03-08T02:30:00", "America/New_York"), /does not exist/);
  assert.throws(() => localToEpoch("2026-11-01T01:30:00", "America/New_York"), /ambiguous/);
});

test("config requires a token and refuses to send it over plain http to remote hosts", () => {
  assert.throws(() => loadConfig({}), /KIMAI_API_TOKEN is not set/);
  assert.throws(
    () => loadConfig({ KIMAI_API_TOKEN: "t", KIMAI_BASE_URL: "http://kimai.example.com" }),
    /must use https/,
  );
  assert.throws(
    () => loadConfig({ KIMAI_API_TOKEN: "t", KIMAI_TIMEZONE: "Mars/Olympus" }),
    /not a valid IANA time zone/,
  );

  assert.equal(loadConfig({ KIMAI_API_TOKEN: "t" }).baseUrl, "https://kimai.coderockr.com");
  assert.equal(
    loadConfig({ KIMAI_API_TOKEN: "t", KIMAI_BASE_URL: "http://127.0.0.1:8080/" }).baseUrl,
    "http://127.0.0.1:8080",
  );
});
