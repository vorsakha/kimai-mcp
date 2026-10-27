import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Account } from "./account.ts";
import { KimaiError, UnknownOutcomeError, type KimaiClient } from "./kimai.ts";
import { CatalogNames, findProject, projectActivities } from "./catalog.ts";
import { Activity, GroupBy, Project, Timesheet, TimesheetConfig } from "./schemas.ts";
import { localToEpoch, parseLocalDate, parseLocalDateTime, TimeInputError, toLocal, weekdayOf } from "./time.ts";
import { describeEntry, fetchAllTimesheets, RANGE_RULE, summarize, timesheetQuery, toEntryView } from "./timesheets.ts";

const id = z.number().int().positive();
const localDateTime = z
  .string()
  .describe("Wall-clock time in the Kimai account time zone: YYYY-MM-DDTHH:mm[:ss], without offset or Z.");
const localDate = z.string().describe("Date in the Kimai account time zone: YYYY-MM-DD.");
const description = z.string().max(5000).describe("Work description, e.g. 'CODE-123: fix login redirect'.");
const tags = z.array(z.string().min(1)).describe("Tag names. Replaces all existing tags.");
const billable = z.boolean().describe("Billable flag. Only sent when given; requires the matching Kimai permission.");

const readOnly = { readOnlyHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

class ToolInputError extends Error {}

export function createServer(client: KimaiClient, account: Account): McpServer {
  const names = new CatalogNames();
  const server = new McpServer(
    { name: "kimai-mcp", version: "0.1.0" },
    {
      instructions: [
        "Use get_context to resolve relative dates in the Kimai account's time zone.",
        "Resolve project and activity names to IDs with list_projects and list_activities before writing entries.",
        "Ask the user when a project, activity, date, or existing entry is ambiguous; do not guess.",
        "Use summarize_time for totals and request multiple groupings together; list_timesheets returns one page at a time.",
        "After UNKNOWN OUTCOME, inspect list_timesheets or get_context before retrying: the write may have succeeded.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get Kimai context",
      description:
        "Start here. Returns the user, the account time zone with the current local date-time (use it to resolve " +
        "'today', 'yesterday', 'this week'), the instance tracking rules, running timers and recently used " +
        "project/activity combinations.",
      annotations: readOnly,
    },
    run(async () => {
      const [{ user, timeZone }, config, active, recent] = await Promise.all([
        account.me(),
        client.get("/config/timesheet", TimesheetConfig),
        client.get("/timesheets/active", Timesheet.array()),
        client.get("/timesheets/recent", Timesheet.array(), { size: 10 }),
      ]);
      const now = toLocal(Date.now(), timeZone.name);

      return {
        user: { id: user.id, username: user.username, alias: user.alias ?? null },
        timeZone,
        now: { local: now, date: now.slice(0, 10), weekday: weekdayOf(now) },
        trackingRules: config,
        activeTimers: active.map((entry) => toEntryView(entry, names)),
        recentCombinations: recent.map((entry) => {
          const view = toEntryView(entry, names);

          return {
            project: view.project,
            activity: view.activity,
            lastBegin: view.begin,
            lastDescription: view.description,
          };
        }),
      };
    }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Search visible, currently active projects by name. Returns stable IDs with customer names. " +
        "If several projects match, ask the user instead of guessing.",
      inputSchema: {
        term: z.string().optional().describe("Free-text search on project (and related) fields."),
        customer: id.optional().describe("Only projects of this customer ID."),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: readOnly,
    },
    run(async ({ term, customer, limit }) => {
      const projects = await client.get("/projects", Project.array(), { term: term || undefined, customer });
      const matches = projects.filter((project) => customer === undefined || project.customer === customer);

      for (const project of projects) {
        names.rememberProject(project);
      }

      return {
        totalMatches: matches.length,
        truncated: matches.length > limit,
        projects: matches.slice(0, limit).map((project) => ({
          id: project.id,
          name: project.name,
          customer: { id: project.customer ?? null, name: project.parentTitle ?? null },
          globalActivities: project.globalActivities ?? null,
        })),
      };
    }),
  );

  server.registerTool(
    "list_activities",
    {
      title: "List activities",
      description:
        "Activities that can be booked. With a project ID, returns that project's activities plus global activities " +
        "when the project allows them, which is exactly the set valid for time entries on that project.",
      inputSchema: {
        project: id.optional().describe("Project ID. Strongly recommended before creating entries."),
        term: z.string().optional().describe("Free-text search on activity fields."),
        limit: z.number().int().min(1).max(200).default(100),
      },
      annotations: readOnly,
    },
    run(async ({ project: projectId, term, limit }) => {
      const query = { term: term || undefined };
      const project = projectId === undefined ? undefined : await findProject(client, projectId);

      if (projectId !== undefined && !project) {
        throw new ToolInputError(`Project ${projectId} is not among the projects this account can access.`);
      }

      const activities = project
        ? await projectActivities(client, project, query)
        : await client.get("/activities", Activity.array(), query);

      if (project) {
        names.rememberProject(project);
      }

      for (const activity of activities) {
        names.rememberActivity(activity);
      }

      return {
        project: project
          ? { id: project.id, name: project.name, globalActivities: project.globalActivities ?? null }
          : null,
        totalMatches: activities.length,
        truncated: activities.length > limit,
        activities: activities.slice(0, limit).map((activity) => ({
          id: activity.id,
          name: activity.name,
          global: activity.project == null,
          project: activity.project == null ? null : { id: activity.project, name: activity.parentTitle ?? null },
        })),
      };
    }),
  );

  server.registerTool(
    "list_timesheets",
    {
      title: "List time entries",
      description:
        "The user's own time entries. Pass `id` to fetch one entry, or a date range (inclusive, by entry start) with " +
        "optional filters. Paginated, newest first; check `pagination.hasMore`. For totals use summarize_time.",
      inputSchema: {
        id: id.optional().describe("Fetch this single entry; other filters are ignored."),
        from: localDate.optional(),
        to: localDate.optional(),
        project: id.optional(),
        activity: id.optional(),
        term: z.string().optional().describe("Free-text search, e.g. a ticket key in the description."),
        page: z.number().int().min(1).default(1),
        size: z.number().int().min(1).max(500).default(50),
      },
      annotations: readOnly,
    },
    run(async ({ id: entryId, page, size, ...filters }) => {
      if (entryId !== undefined) {
        return { entry: await describeEntry(client, await client.get(`/timesheets/${entryId}`, Timesheet), names) };
      }

      const range = dateRange(filters.from, filters.to);
      const result = await client.getPage("/timesheets", Timesheet, {
        ...timesheetQuery({ ...filters, ...range }),
        page,
        size,
      });

      return {
        scope: { ...range, rule: RANGE_RULE },
        pagination: {
          page,
          size,
          totalCount: result.totalCount,
          totalPages: result.totalPages,
          hasMore: result.totalPages === null ? result.items.length === size : page < result.totalPages,
        },
        entries: result.items.map((entry) => toEntryView(entry, names)),
      };
    }),
  );

  server.registerTool(
    "summarize_time",
    {
      title: "Summarize hours",
      description:
        "Total tracked time for a date range. Pass one groupBy for a groups array, or several for groups keyed " +
        "by grouping. All groupings share one complete fetch. Running timers are excluded from totals.",
      inputSchema: {
        from: localDate,
        to: localDate,
        groupBy: GroupBy.or(GroupBy.array().min(1).max(3)).default("day"),
        project: id.optional(),
        activity: id.optional(),
        term: z.string().optional(),
      },
      annotations: readOnly,
    },
    run(async ({ groupBy, ...filters }) => {
      const range = dateRange(filters.from, filters.to);
      const [timeZone, { entries, pagesFetched }] = await Promise.all([
        account.timeZone(),
        fetchAllTimesheets(client, { ...filters, ...range }),
      ]);
      const groupings = typeof groupBy === "string" ? [groupBy] : [...new Set(groupBy)];
      const summaries = groupings.map((by) => ({ by, result: summarize(entries, by, names) }));
      const summary = summaries[0]!.result;

      return {
        scope: {
          ...range,
          timeZone: timeZone.name,
          filters: { project: filters.project ?? null, activity: filters.activity ?? null, term: filters.term ?? null },
          rule: RANGE_RULE,
          durationSource: "Kimai-reported duration in seconds (reflects any configured rounding and breaks).",
        },
        complete: true,
        pagesFetched,
        ...summary,
        groupBy: typeof groupBy === "string" ? groupBy : groupings,
        groups:
          typeof groupBy === "string"
            ? summary.groups
            : Object.fromEntries(summaries.map(({ by, result }) => [by, result.groups])),
      };
    }),
  );

  server.registerTool(
    "create_timesheet",
    {
      title: "Log completed work",
      description:
        "Create a finished time entry. Requires explicit project and activity IDs (see list_projects / " +
        "list_activities) and begin/end as local wall-clock times. Not retried automatically.",
      inputSchema: {
        project: id,
        activity: id,
        begin: localDateTime,
        end: localDateTime,
        description: description.optional(),
        tags: tags.optional(),
        billable: billable.optional(),
      },
      annotations: write,
    },
    run(async (input) => {
      const times = await validateTimes(account, input.begin, input.end);
      const created = await client.write(
        "POST",
        "/timesheets",
        Timesheet,
        { ...entryFields(input), ...times },
        { full: "true" },
      );

      return { created: toEntryView(created, names) };
    }),
  );

  server.registerTool(
    "update_timesheet",
    {
      title: "Correct a time entry",
      description:
        "Change selected fields of an existing entry. Omitted fields keep their current values. " +
        "`tags` replaces the whole tag list; an empty description clears it.",
      inputSchema: {
        id,
        project: id.optional(),
        activity: id.optional(),
        begin: localDateTime.optional(),
        end: localDateTime.optional(),
        description: description.optional(),
        tags: tags.optional(),
        billable: billable.optional(),
      },
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    run(async ({ id: entryId, ...input }) => {
      const changes = { ...entryFields(input), ...(await validateTimes(account, input.begin, input.end)) };

      if (Object.keys(changes).length === 0) {
        throw new ToolInputError("Nothing to update: pass at least one field to change.");
      }

      const updated = await client.write("PATCH", `/timesheets/${entryId}`, Timesheet, changes);

      return { updated: await describeEntry(client, updated, names), changedFields: Object.keys(changes) };
    }),
  );

  server.registerTool(
    "start_timer",
    {
      title: "Start a timer",
      description:
        "Start a running entry now. Refuses when the instance limit of running timers is already reached, " +
        "because Kimai would otherwise stop the oldest timer silently; stop one with stop_timer first.",
      inputSchema: {
        project: id,
        activity: id,
        description: description.optional(),
        tags: tags.optional(),
        billable: billable.optional(),
      },
      annotations: write,
    },
    run(async (input) => {
      const [config, active] = await Promise.all([
        client.get("/config/timesheet", TimesheetConfig),
        client.get("/timesheets/active", Timesheet.array()),
      ]);
      const running = active.map((entry) => toEntryView(entry, names));

      if (running.length >= config.activeEntriesHardLimit) {
        throw new ToolInputError(
          `Kimai allows ${config.activeEntriesHardLimit} running timer(s) and ${running.length} already running ` +
            `(${running.map((entry) => `#${entry.id} ${entry.project.name} / ${entry.activity.name}`).join(", ")}). ` +
            "Starting another would make Kimai stop the oldest automatically. Stop one with stop_timer first.",
        );
      }

      const started = await client.write("POST", "/timesheets", Timesheet, entryFields(input), { full: "true" });

      return { started: toEntryView(started, names), otherRunningTimers: running };
    }),
  );

  server.registerTool(
    "stop_timer",
    {
      title: "Stop a timer",
      description:
        "Stop one specific running entry (IDs come from get_context activeTimers). Not retried automatically.",
      inputSchema: { id },
      annotations: write,
    },
    run(async ({ id: entryId }) => {
      const current = await client.get(`/timesheets/${entryId}`, Timesheet);

      if (current.end) {
        return { alreadyStopped: true, entry: await describeEntry(client, current, names) };
      }

      const stopped = await client.write("PATCH", `/timesheets/${entryId}/stop`, Timesheet);

      return { stopped: await describeEntry(client, stopped, names) };
    }),
  );

  return server;
}

function run<Args>(handler: (args: Args) => Promise<unknown>) {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await handler(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
    }
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof UnknownOutcomeError) {
    return `UNKNOWN OUTCOME: ${error.message}`;
  }

  if (error instanceof KimaiError || error instanceof TimeInputError || error instanceof ToolInputError) {
    return error.message;
  }

  console.error("kimai-mcp: unexpected error", error);

  return "Unexpected internal error in kimai-mcp; details were written to the server log.";
}

type EntryFieldsInput = {
  project?: number | undefined;
  activity?: number | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  billable?: boolean | undefined;
};

function entryFields(input: EntryFieldsInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: input.project,
    activity: input.activity,
    description: input.description,
    tags: input.tags?.join(","),
    billable: input.billable,
  };

  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

async function validateTimes(account: Account, begin: string | undefined, end: string | undefined) {
  const times: { begin?: string; end?: string } = {};

  if (begin !== undefined) {
    times.begin = parseLocalDateTime(begin);
  }

  if (end !== undefined) {
    times.end = parseLocalDateTime(end);
  }

  if (times.begin === undefined && times.end === undefined) {
    return times;
  }

  const timeZone = (await account.timeZone()).name;
  const [beginEpoch, endEpoch] = [times.begin, times.end].map((time) =>
    time === undefined ? undefined : localToEpoch(time, timeZone),
  );

  if (beginEpoch !== undefined && endEpoch !== undefined && endEpoch <= beginEpoch) {
    throw new TimeInputError(`end (${times.end}) must be after begin (${times.begin}).`);
  }

  return times;
}

function dateRange(from: string | undefined, to: string | undefined) {
  if (from === undefined || to === undefined) {
    throw new ToolInputError("Pass both `from` and `to` (YYYY-MM-DD), or an `id`.");
  }

  parseLocalDate(from);
  parseLocalDate(to);

  if (to < from) {
    throw new ToolInputError(`to (${to}) is before from (${from}).`);
  }

  return { from, to };
}
