import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Runs the real server over stdio against a local stub of the Kimai API. Nothing here talks to a real Kimai.

const TOKEN = "test-token-3f9a71c2";

type Recorded = { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | undefined };
type Route = (request: Recorded, response: ServerResponse) => void;

const xProject = { id: 1, name: "Project X", customer: { id: 5, name: "Acme" } };
const internal = { id: 2, name: "Internal", customer: { id: 6, name: "Coderockr" } };
const development = { id: 10, name: "Development" };
const meeting = { id: 11, name: "Meeting" };

function entry(
  id: number,
  begin: string,
  end: string | null,
  duration: number,
  project = xProject,
  activity = development,
) {
  return {
    id,
    begin,
    end,
    duration,
    description: `CODE-${id}`,
    tags: [],
    billable: true,
    exported: false,
    project,
    activity,
  };
}

// Five entries across the range: two days of finished work, one crossing midnight, one still running.
const entries = [
  entry(1, "2026-10-19T09:00:00-0300", "2026-10-19T11:30:00-0300", 9000),
  entry(2, "2026-10-19T13:00:00-0300", "2026-10-19T14:00:00-0300", 3600, internal, meeting),
  entry(3, "2026-10-20T09:00:00-0300", "2026-10-20T10:00:00-0300", 3600),
  entry(4, "2026-10-20T23:30:00-0300", "2026-10-21T00:30:00-0300", 3600),
  entry(5, "2026-10-21T08:00:00-0300", null, 0),
];

const projectCatalog = [
  { id: 1, name: "Project X", customer: 5, parentTitle: "Acme", globalActivities: true },
  { id: 2, name: "Internal", customer: 6, parentTitle: "Coderockr", globalActivities: false },
];

// Returned unfiltered, as Kimai does when it cannot resolve a project filter.
const activityCatalog = [
  { id: 10, name: "Development", project: null },
  { id: 11, name: "Meeting", project: 2, parentTitle: "Internal" },
  { id: 12, name: "Design", project: 1, parentTitle: "Project X" },
];

let requests: Recorded[] = [];
let routes: Record<string, Route> = {};

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

function baseRoutes(): Record<string, Route> {
  return {
    "GET /api/users/me": (_, res) =>
      json(res, 200, { id: 7, username: "andrei", alias: "Andrei", timezone: "America/Sao_Paulo" }),
    "GET /api/config/timesheet": (_, res) =>
      json(res, 200, {
        trackingMode: "default",
        activeEntriesHardLimit: 1,
        isAllowFutureTimes: false,
        isAllowOverlapping: true,
      }),
    "GET /api/timesheets/active": (_, res) => json(res, 200, [entries[4]]),
    "GET /api/timesheets/recent": (_, res) => json(res, 200, [entries[2]]),
    // Like a regular account on the live instance: collections are readable, detail endpoints are 403.
    "GET /api/projects": (_, res) => json(res, 200, projectCatalog),
    "GET /api/activities": (_, res) => json(res, 200, activityCatalog),
    "GET /api/projects/1": (_, res) => json(res, 403, { code: 403, message: "Access denied." }),
    "GET /api/activities/10": (_, res) => json(res, 403, { code: 403, message: "Access denied." }),
    // The stub pages by 2 regardless of the requested size, like a server with a smaller cap.
    "GET /api/timesheets": (req, res) => {
      const page = Number(req.query.get("page"));
      const items = entries.slice((page - 1) * 2, page * 2);
      json(res, 200, items, { "X-Total-Count": String(entries.length), "X-Total-Pages": "3", "X-Page": String(page) });
    },
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString();

  return text ? JSON.parse(text) : undefined;
}

const kimai = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://stub");
  const recorded = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    body: await readBody(request),
    auth: request.headers.authorization,
  };

  requests.push(recorded);

  const route = routes[`${recorded.method} ${recorded.path}`];

  if (route) {
    route(recorded, response);
  } else {
    json(response, 404, { code: 404, message: "Not found" });
  }
});

let client: Client;

before(async () => {
  await new Promise<void>((resolve) => kimai.listen(0, "127.0.0.1", resolve));
  const address = kimai.address();
  assert.ok(address !== null && typeof address === "object", "stub server has no TCP address");

  client = new Client({ name: "kimai-mcp-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/index.ts"],
      env: { KIMAI_BASE_URL: `http://127.0.0.1:${address.port}`, KIMAI_API_TOKEN: TOKEN },
      stderr: "ignore",
    }),
  );
});

after(async () => {
  await client.close();
  kimai.close();
});

beforeEach(() => {
  requests = [];
  routes = baseRoutes();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const [content] = result.content;

  return { isError: result.isError === true, text: content?.type === "text" ? content.text : "" };
}

async function callJson(name: string, args: Record<string, unknown> = {}) {
  const { isError, text } = await call(name, args);
  assert.equal(isError, false, text);

  return JSON.parse(text);
}

function sent(method: string, path: string) {
  return requests.filter((request) => request.method === method && request.path === path);
}

test("initializes over stdio, lists the tools and reports context in the account time zone", async () => {
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_timesheet",
    "get_context",
    "list_activities",
    "list_projects",
    "list_timesheets",
    "start_timer",
    "stop_timer",
    "summarize_time",
    "update_timesheet",
  ]);

  const context = await callJson("get_context");

  assert.deepEqual(context.timeZone, { name: "America/Sao_Paulo", source: "kimai-account" });
  assert.match(context.now.local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(
    context.activeTimers.map((timer: { id: number }) => timer.id),
    [5],
  );
  assert.ok(requests.every((request) => request.auth === `Bearer ${TOKEN}`));
});

test("summarize_time totals every page by start day and keeps running entries out of the totals", async () => {
  const summary = await callJson("summarize_time", { from: "2026-10-19", to: "2026-10-21", groupBy: "day" });
  const pages = sent("GET", "/api/timesheets");

  assert.deepEqual(
    pages.map((request) => request.query.get("page")),
    ["1", "2", "3"],
  );
  assert.equal(pages[0]?.query.get("begin"), "2026-10-19T00:00:00");
  assert.equal(pages[0]?.query.get("end"), "2026-10-21T23:59:59");

  assert.equal(summary.complete, true);
  assert.deepEqual(summary.total, { seconds: 19800, hours: 5.5, entries: 4 });
  assert.deepEqual(
    summary.groups.map((group: { day: string; seconds: number }) => [group.day, group.seconds]),
    [
      ["2026-10-19", 12600],
      ["2026-10-20", 7200],
    ],
  );
  assert.deepEqual(
    summary.running.entries.map((running: { id: number }) => running.id),
    [5],
  );

  // A page set that does not add up to X-Total-Count must fail, never produce partial totals.
  routes["GET /api/timesheets"] = (req, res) => {
    const page = Number(req.query.get("page"));
    json(res, 200, entries.slice((page - 1) * 2, page * 2), { "X-Total-Count": "6", "X-Total-Pages": "3" });
  };

  const partial = await call("summarize_time", { from: "2026-10-19", to: "2026-10-21" });

  assert.equal(partial.isError, true);
  assert.match(partial.text, /expected 6 entries, received 5/);

  // A finished entry without a duration must not count as zero in a "complete" total.
  routes["GET /api/timesheets"] = (_, res) =>
    json(res, 200, [{ ...entries[0], duration: null }], { "X-Total-Count": "1", "X-Total-Pages": "1" });

  const unknownDuration = await call("summarize_time", { from: "2026-10-19", to: "2026-10-21" });

  assert.equal(unknownDuration.isError, true);
  assert.match(unknownDuration.text, /Entry #1 has ended but Kimai returned no valid duration/);
});

test("create_timesheet sends account-local times once and treats unreadable answers as unknown", async () => {
  const rejected = await call("create_timesheet", {
    project: 1,
    activity: 10,
    begin: "2026-10-25T11:30",
    end: "2026-10-25T09:00",
  });

  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /must be after begin/);
  assert.equal(sent("POST", "/api/timesheets").length, 0);

  const input = {
    project: 1,
    activity: 10,
    begin: "2026-10-25T09:00",
    end: "2026-10-25T11:30",
    description: "CODE-123",
    tags: ["backend", "review"],
  };

  // Each of these may follow a committed write, so none may look like a definite failure or be retried.
  const unknownOutcomes: Record<string, Route> = {
    "dropped connection": (_, res) => res.socket?.destroy(),
    "non-JSON success": (_, res) => res.writeHead(200, { "Content-Type": "application/json" }).end("not-json"),
    "success cut off mid-body": (_, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      res.write('{"id":');
      setTimeout(() => res.destroy(), 20);
    },
  };

  for (const [label, route] of Object.entries(unknownOutcomes)) {
    requests = [];
    routes["POST /api/timesheets"] = route;

    const result = await call("create_timesheet", input);

    assert.equal(result.isError, true, label);
    assert.match(result.text, /^UNKNOWN OUTCOME: /, label);
    assert.equal(sent("POST", "/api/timesheets").length, 1, label);
  }

  assert.deepEqual(sent("POST", "/api/timesheets")[0]?.body, {
    project: 1,
    activity: 10,
    description: "CODE-123",
    tags: "backend,review",
    begin: "2026-10-25T09:00:00",
    end: "2026-10-25T11:30:00",
  });

  // A parsed validation answer proves nothing was saved: a definite, field-level error.
  routes["POST /api/timesheets"] = (_, res) =>
    json(res, 400, {
      code: 400,
      message: "Validation Failed",
      errors: { children: { end: { errors: ["End date must not be in the future."] } } },
    });

  const invalid = await call("create_timesheet", input);

  assert.equal(invalid.isError, true);
  assert.match(
    invalid.text,
    /^Kimai rejected POST \/timesheets \(HTTP 400\): end: End date must not be in the future\./,
  );
});

test("activities are scoped through readable collections when detail endpoints are forbidden", async () => {
  const projectX = await callJson("list_activities", { project: 1 });

  assert.deepEqual(
    projectX.activities.map((activity: { id: number; global: boolean }) => [activity.id, activity.global]),
    [
      [10, true],
      [12, false],
    ],
  );
  assert.equal(sent("GET", "/api/projects")[0]?.query.get("ignoreDates"), "1");

  // Internal disallows global activities; Kimai's unfiltered answer must not leak them or other projects' activities.
  const internalOnly = await callJson("list_activities", { project: 2 });

  assert.deepEqual(
    internalOnly.activities.map((activity: { id: number }) => activity.id),
    [11],
  );

  const unknown = await call("list_activities", { project: 99 });

  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Project 99 is not among the projects this account can access/);
  assert.equal(sent("GET", "/api/projects/99").length, 0);
});

test("update_timesheet patches only the given fields and names the result via collections", async () => {
  routes["PATCH /api/timesheets/3"] = (_, res) =>
    json(res, 200, { ...entries[2], end: "2026-10-20T12:00:00-0300", duration: 10800, project: 1, activity: 10 });

  const result = await callJson("update_timesheet", { id: 3, end: "2026-10-20T12:00" });

  assert.deepEqual(sent("PATCH", "/api/timesheets/3")[0]?.body, { end: "2026-10-20T12:00:00" });
  assert.deepEqual(result.changedFields, ["end"]);
  assert.deepEqual(result.updated.project, { id: 1, name: "Project X", customer: "Acme" });
  assert.equal(result.updated.activity.name, "Development");
});

test("start_timer refuses instead of letting Kimai silently stop a running timer", async () => {
  const result = await call("start_timer", { project: 1, activity: 10 });

  assert.equal(result.isError, true);
  assert.match(result.text, /allows 1 running timer\(s\) and 1 already running \(#5 Project X \/ Development\)/);
  assert.equal(sent("POST", "/api/timesheets").length, 0);
});

test("Kimai error bodies are summarized without leaking the API token", async () => {
  routes["GET /api/timesheets/9"] = (req, res) =>
    json(res, 403, { code: 403, message: `Access denied for ${req.auth}` });

  const result = await call("list_timesheets", { id: 9 });

  assert.equal(result.isError, true);
  assert.match(result.text, /HTTP 403.*Access denied for Bearer \[redacted\].*locked/);
  assert.ok(!result.text.includes(TOKEN), "token leaked into tool output");
});
