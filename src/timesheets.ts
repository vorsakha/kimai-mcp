import { KimaiError, type KimaiClient } from "./kimai.ts";
import { findProject, projectActivities } from "./catalog.ts";
import { Timesheet } from "./schemas.ts";

const PAGE_SIZE = 500;
const MAX_SUMMARY_ENTRIES = 5000;

export type EntryView = ReturnType<typeof toEntryView>;

export type TimesheetFilters = {
  from: string;
  to: string;
  project?: number | undefined;
  activity?: number | undefined;
  term?: string | undefined;
};

/** Kimai's begin/end filters match the entry START time, in the account time zone. */
export function timesheetQuery(filters: TimesheetFilters) {
  return {
    begin: `${filters.from}T00:00:00`,
    end: `${filters.to}T23:59:59`,
    project: filters.project,
    activity: filters.activity,
    term: filters.term || undefined,
    full: "true",
  };
}

export const RANGE_RULE =
  "Includes entries whose START is between from 00:00:00 and to 23:59:59 in the account time zone. " +
  "An entry crossing midnight belongs entirely to its start day.";

export function toEntryView(entry: Timesheet, names: ResolvedNames = {}) {
  const project = typeof entry.project === "number" ? names.project : entry.project;
  const activity = typeof entry.activity === "number" ? names.activity : entry.activity;
  const running = !entry.end;

  return {
    id: entry.id,
    begin: entry.begin,
    end: entry.end ?? null,
    running,
    durationSeconds: running ? null : (entry.duration ?? null),
    project: {
      id: typeof entry.project === "number" ? entry.project : entry.project.id,
      name: project?.name ?? null,
      customer: project?.customer?.name ?? null,
    },
    activity: {
      id: typeof entry.activity === "number" ? entry.activity : entry.activity.id,
      name: activity?.name ?? null,
    },
    description: entry.description ?? null,
    tags: entry.tags ?? [],
    billable: entry.billable,
    exported: entry.exported,
  };
}

type ResolvedNames = {
  project?: { name: string; customer: { name: string } | null } | undefined;
  activity?: { name: string } | undefined;
};

/**
 * Single-entry endpoints return project and activity as bare IDs. Names are looked up
 * best-effort: a failed lookup must never turn a successful write into a reported failure.
 */
export async function describeEntry(client: KimaiClient, entry: Timesheet): Promise<EntryView> {
  if (typeof entry.project !== "number" || typeof entry.activity !== "number") {
    return toEntryView(entry);
  }

  const activityId = entry.activity;
  const project = await findProject(client, entry.project).catch(() => undefined);
  const activities = project ? await projectActivities(client, project, { visible: 3 }).catch(() => []) : [];

  return toEntryView(entry, {
    project: project && { name: project.name, customer: project.parentTitle ? { name: project.parentTitle } : null },
    activity: activities.find((activity) => activity.id === activityId),
  });
}

/**
 * Fetches every page for the filters, ordered by ID so edits during paging cannot shift
 * entries between pages. Fails rather than returning a partial or inconsistent set.
 */
export async function fetchAllTimesheets(client: KimaiClient, filters: TimesheetFilters) {
  const query = { ...timesheetQuery(filters), size: PAGE_SIZE, orderBy: "id", order: "ASC" };
  const first = await client.getPage("/timesheets", Timesheet, { ...query, page: 1 });
  const { totalCount, totalPages } = first;

  if (totalCount === null || totalPages === null) {
    throw new KimaiError(
      "Kimai did not send X-Total-Count/X-Total-Pages headers, so the result cannot be verified as complete.",
    );
  }

  if (totalCount > MAX_SUMMARY_ENTRIES) {
    throw new KimaiError(
      `The range holds ${totalCount} entries (limit ${MAX_SUMMARY_ENTRIES}). Use a narrower date range.`,
    );
  }

  const entries = [...first.items];

  for (let page = 2; page <= totalPages; page++) {
    entries.push(...(await client.getPage("/timesheets", Timesheet, { ...query, page })).items);
  }

  const uniqueIds = new Set(entries.map((entry) => entry.id)).size;

  if (entries.length !== totalCount || uniqueIds !== totalCount) {
    throw new KimaiError(
      `Timesheets changed while paging (expected ${totalCount} entries, ` +
        `received ${entries.length}, ${uniqueIds} unique). Run the summary again.`,
    );
  }

  return { entries, pagesFetched: Math.max(totalPages, 1) };
}

export type GroupBy = "day" | "project" | "activity";

export function summarize(entries: Timesheet[], groupBy: GroupBy) {
  const groups = new Map<string, { label: Record<string, unknown>; seconds: number; entries: number }>();
  const running: EntryView[] = [];
  let totalSeconds = 0;

  for (const entry of entries) {
    const view = toEntryView(entry);

    if (view.running) {
      running.push(view);
      continue;
    }

    const seconds = view.durationSeconds;

    // A finished entry without a duration would silently count as zero in a "complete" total.
    if (seconds === null || seconds < 0) {
      throw new KimaiError(
        `Entry #${view.id} has ended but Kimai returned no valid duration, so a complete total cannot be computed.`,
      );
    }

    const [key, label] = groupKey(view, groupBy);
    const group = groups.get(key) ?? { label, seconds: 0, entries: 0 };

    group.seconds += seconds;
    group.entries += 1;
    groups.set(key, group);
    totalSeconds += seconds;
  }

  const sorted = [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => (groupBy === "day" ? keyA.localeCompare(keyB) : b.seconds - a.seconds))
    .map(([, group]) => ({
      ...group.label,
      seconds: group.seconds,
      hours: toHours(group.seconds),
      entries: group.entries,
    }));

  return {
    total: { seconds: totalSeconds, hours: toHours(totalSeconds), entries: entries.length - running.length },
    groups: sorted,
    running: {
      excludedFromTotals: true,
      entries: running.map(({ id, begin, project, activity, description }) => ({
        id,
        begin,
        project,
        activity,
        description,
      })),
    },
  };
}

function groupKey(view: EntryView, groupBy: GroupBy): [string, Record<string, unknown>] {
  switch (groupBy) {
    case "day":
      return [view.begin.slice(0, 10), { day: view.begin.slice(0, 10) }];
    case "project":
      return [String(view.project.id), { project: view.project }];
    case "activity":
      return [String(view.activity.id), { activity: view.activity }];
  }
}

function toHours(seconds: number): number {
  return Math.round(seconds / 36) / 100;
}
