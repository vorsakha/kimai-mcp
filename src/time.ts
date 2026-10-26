// Kimai reads and writes wall-clock times ("YYYY-MM-DDTHH:mm:ss", no offset) in the
// account's time zone. These helpers validate such values against that zone without
// a date library: a wall-clock time can be valid, missing (DST gap) or ambiguous (DST overlap).

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

export class TimeInputError extends Error {}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Validates a calendar date and returns it unchanged. */
export function parseLocalDate(input: string): string {
  const [, year = "", month = "", day = ""] = LOCAL_DATE.exec(input) ?? [];

  if (!isCalendarDate(Number(year), Number(month), Number(day))) {
    throw new TimeInputError(`"${input}" is not a valid date, expected YYYY-MM-DD.`);
  }

  return input;
}

/** Validates a wall-clock time and normalizes it to Kimai's "YYYY-MM-DDTHH:mm:ss" write format. */
export function parseLocalDateTime(input: string): string {
  const [, year = "", month = "", day = "", hour = "", minute = "", second = "00"] = LOCAL_DATE_TIME.exec(input) ?? [];

  const valid =
    isCalendarDate(Number(year), Number(month), Number(day)) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59;

  if (!valid) {
    throw new TimeInputError(
      `"${input}" is not a valid local date-time, expected YYYY-MM-DDTHH:mm[:ss] without a time zone offset.`,
    );
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/**
 * Converts a normalized wall-clock time in `timeZone` to an epoch timestamp.
 * Rejects times skipped by a DST change and times that occur twice, rather than guessing.
 */
export function localToEpoch(local: string, timeZone: string): number {
  const asUtc = Date.parse(`${local}Z`);

  // Offsets a day before and after cover any single DST transition near this time.
  const offsets = new Set([offsetAt(asUtc - DAY_MS, timeZone), offsetAt(asUtc + DAY_MS, timeZone)]);
  const candidates = [...offsets].map((offset) => asUtc - offset).filter((epoch) => toLocal(epoch, timeZone) === local);

  if (candidates.length === 0) {
    throw new TimeInputError(`${local} does not exist in ${timeZone} (skipped by a daylight saving change).`);
  }

  if (candidates.length > 1) {
    throw new TimeInputError(
      `${local} is ambiguous in ${timeZone} (it occurs twice because of a daylight saving change). ` +
        "Pick a time outside that hour.",
    );
  }

  return candidates[0]!;
}

/** Wall-clock "YYYY-MM-DDTHH:mm:ss" for an instant in `timeZone`. */
export function toLocal(epoch: number, timeZone: string): string {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(epoch)
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function weekdayOf(localDate: string): string {
  return new Date(`${localDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
}

function offsetAt(epoch: number, timeZone: string): number {
  const wholeSecond = Math.floor(epoch / 1000) * 1000;

  return Date.parse(`${toLocal(wholeSecond, timeZone)}Z`) - wholeSecond;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }

  return formatter;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    year >= 1970 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
