# kimai-mcp

A small [MCP](https://modelcontextprotocol.io) server for **personal** time tracking on a
[Kimai](https://www.kimai.org) instance (by default `https://kimai.coderockr.com`). It lets an agent log work,
correct entries, run timers and review hours. It runs over stdio, launched by your MCP host, and talks to Kimai's
REST API over HTTPS. It has no database, web UI or admin/invoicing features.

## Install and build

Requires Node.js 22.18 or newer.

```sh
npm ci
npm run build        # compiles src/ to dist/
```

The entry point is `dist/index.js` (also exposed as the `kimai-mcp` bin).

## Credentials and environment

| Variable          | Required | Purpose                                                                                                        |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `KIMAI_API_TOKEN` | yes      | Personal API token (Kimai → your profile → API Access). Sent as `Authorization: Bearer …`.                     |
| `KIMAI_BASE_URL`  | no       | Instance URL. Defaults to `https://kimai.coderockr.com`. Must be `https://` (http only for localhost).         |
| `KIMAI_TIMEZONE`  | no       | IANA zone fallback, used only if Kimai does not report the account zone. Must match the account if both exist. |

`.env.example` lists these variables with placeholders. Keep real values in `.env` (git-ignored, like every
`.env.*` except the example) and keep that file private (`chmod 600 .env`). The server only reads its process
environment. It does not parse `.env` itself: let Node load the file with `--env-file` (below), or pass the
variables through the client config.

The token is never logged or returned to the model. Error text from Kimai is redacted before it reaches the model.

## MCP client configuration

Any stdio-capable MCP client works. The recommended setup lets Node load the existing `.env`, so the token never
gets copied into the client's JSON (Claude Code / Claude Desktop style):

```json
{
  "mcpServers": {
    "kimai": {
      "command": "node",
      "args": ["--env-file=/absolute/path/to/kimai-mcp/.env", "/absolute/path/to/kimai-mcp/dist/index.js"]
    }
  }
}
```

Use absolute paths, because clients start servers from an unrelated working directory. Node exits with an error if
the file is missing. Variables already set in the client's environment take precedence over the file.

Alternatively, pass the variables directly with an `"env": { "KIMAI_API_TOKEN": "…" }` block in the same entry.

Stdout carries only MCP protocol messages; diagnostics go to stderr.

## Tools

| Tool               | What it does                                                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_context`      | User, account time zone with current local date-time and weekday, tracking rules (`trackingMode`, `activeEntriesHardLimit`, `isAllowFutureTimes`, `isAllowOverlapping`), running timers, recent project/activity combinations. Call it first. |
| `list_projects`    | Visible, currently active projects matching `term` and optional `customer` ID, with customer names.                                                                                                                                           |
| `list_activities`  | With `project`: that project's activities plus global ones when the project allows them, i.e. the valid set.                                                                                                                                  |
| `list_timesheets`  | One entry by `id`, or the user's entries in `from`..`to` with `project`/`activity`/`term` filters and pagination.                                                                                                                             |
| `summarize_time`   | Totals for `from`..`to`, grouped by `day`, `project` or `activity`, from **all** pages.                                                                                                                                                       |
| `create_timesheet` | Log finished work: `project`, `activity`, `begin`, `end`, optional `description`, `tags`, `billable`.                                                                                                                                         |
| `update_timesheet` | Change selected fields of entry `id`; omitted fields are preserved.                                                                                                                                                                           |
| `start_timer`      | Start a running entry now for `project`/`activity`.                                                                                                                                                                                           |
| `stop_timer`       | Stop running entry `id`.                                                                                                                                                                                                                      |

Tools take explicit IDs and structured values. The calling agent resolves "Project X" or "yesterday" through
`get_context`, `list_projects` and `list_activities`, and should ask the user when more than one match fits. Results
are compact JSON with IDs and human-readable names.

### Example flows

- _"Log yesterday from 09:00 to 11:30 on Project X, development, working on CODE-123"_:
  `get_context` (today's date) → `list_projects {term: "Project X"}` → `list_activities {project: 12}` →
  `create_timesheet {project: 12, activity: 40, begin: "2026-10-25T09:00", end: "2026-10-25T11:30", description: "CODE-123"}`.
- _"Show my hours this week by project"_: `get_context` → `summarize_time {from: "2026-10-26", to: "2026-11-01", groupBy: "project"}`.
- _"Change yesterday's CODE-123 entry to end at noon"_: `list_timesheets {from: "2026-10-25", to: "2026-10-25", term: "CODE-123"}` →
  `update_timesheet {id: 981, end: "2026-10-25T12:00"}`.
- _"Start a timer for Project X"_: `list_projects` → `list_activities` → `start_timer {project: 12, activity: 40}`.

## Date and time semantics

- **Account time zone.** Kimai interprets every date-time it receives in the user's account time zone, not the
  zone of the machine running this server. The zone comes from `GET /api/users/me`. `KIMAI_TIMEZONE` is only a
  fallback, and a mismatch with the account is reported as an error rather than guessed around.
- **Input format.** Write tools take wall-clock times `YYYY-MM-DDTHH:mm[:ss]` with no `Z` or offset. Inputs with
  an offset, invalid calendar dates, times skipped by a DST change and times repeated by a DST change are
  rejected before anything is sent. `end` must be after `begin`.
- **Output format.** Times are returned as Kimai sends them: ISO-8601 with the entry's offset (e.g.
  `2026-10-25T09:00:00-0300`).
- **Ranges.** `from`/`to` are inclusive dates. Kimai filters on an entry's **start**, so a range covers entries
  starting between `from 00:00:00` and `to 23:59:59`. An entry crossing midnight belongs entirely to its start day,
  both for filtering and for `groupBy: "day"`.
- **Durations.** Totals add up Kimai's own `duration` seconds, which already reflect configured rounding and breaks.
  `hours` is that value rounded to two decimals.
- **Running entries** have no final duration. `summarize_time` lists them under `running` and excludes them from
  every total.

## Safety behaviour

- **No automatic retries.** Nothing is retried. If a write is sent but the answer is missing (network drop,
  timeout), a server error (HTTP 5xx), or a success that cannot be read or parsed (cut off mid-body, not JSON,
  unexpected shape), the tool reports `UNKNOWN OUTCOME`: the change may or may not have been applied. Check with
  `list_timesheets` or `get_context` before trying again. Only answers that prove nothing was saved (HTTP 4xx, or a
  parsed validation response) are reported as definite failures.
- **Complete summaries or none.** `summarize_time` pages through everything (500 per page, ordered by ID) and
  checks the result against `X-Total-Count`. Missing pagination headers, a count mismatch, a finished entry
  without a valid duration, or more than 5000 entries produce an error, never partial or understated totals.
- **No surprise timer stops.** Kimai stops the oldest running timer when a new one would exceed
  `activeEntriesHardLimit`. `start_timer` refuses in that case and lists the running timers so they can be stopped
  explicitly with `stop_timer`. Already stopped entries are reported as `alreadyStopped` without a write.
- **Activity validity.** `list_activities` first checks that the project is among the account's projects, because
  Kimai silently ignores an unknown project filter and would return every activity. It then keeps only that
  project's activities, plus global ones when the project's "global activities" setting allows them.
- **Collections only.** Regular accounts may read `GET /api/projects` and `GET /api/activities`, but get 403 from
  the detail endpoints `/api/projects/{id}` and `/api/activities/{id}`. All project/activity lookups therefore go
  through the collections (`/api/projects?ignoreDates=1&visible=3` and `/api/activities?project=…`). Names on
  single-entry results (`list_timesheets` by `id`, `update_timesheet`, `stop_timer`) are filled in on a best-effort
  basis. A failed lookup leaves a name `null` but never turns a successful write into an error.
- **Clear errors.** 401 points at the token. 403 mentions locked entries (exported or in a lockdown period) and
  permissions. Validation messages are returned field by field. Requests time out after 30 seconds.

## Development

```sh
npm run typecheck    # tsc over src and test
npm test             # node:test, offline (a local stub stands in for Kimai)
npm run format       # prettier
npm run build
```

Tests never contact a real Kimai server. `test/server.test.ts` launches the real server over stdio against a local
HTTP stub. Like a regular account, the stub answers 403 on project/activity detail endpoints. The tests cover:
initialization and tool listing; account-zone context; multi-page summaries, including a count mismatch and a
finished entry without a duration; single-attempt writes where dropped, non-JSON and truncated successes are
unknown outcomes and validation errors are definite; activity scoping through the collections; partial updates;
the timer limit; and token redaction. `test/time.test.ts` covers date-time parsing, DST gaps and overlaps, and config validation.

Run tests inside resource limits, e.g.:

```sh
systemd-run --user --pipe --wait --collect --working-directory="$PWD" --setenv=PATH="$PATH" \
  -p MemoryMax=1G -p CPUQuota=100% -p TasksMax=128 -p RuntimeMaxSec=180s npm test
```

## Verification status and known limits

- **Live verification is read-only.** On 2026-10-26 the target instance (`https://kimai.coderockr.com`) reported
  **Kimai 2.70.1** and account time zone `America/Sao_Paulo`. With the compiled server and a regular account,
  authenticated reads succeeded for `get_context`, `list_projects`, `list_activities`, `list_timesheets` (date
  range and by ID, including project/activity names) and `summarize_time`. The same check showed that detail
  endpoints `/api/projects/{id}` and `/api/activities/{id}`
  return 403 while the collections return 200.
- Collection-based project/activity lookups, including `ignoreDates=1&visible=3`, passed the live read-only recheck
  with this account. They also have offline coverage for unknown projects and global activity rules.
- **Write tools (`create_timesheet`, `update_timesheet`, `start_timer`, `stop_timer`) have never run against the
  real instance.** They are verified only offline against the stub, built from Kimai's current source
  (`TimesheetController`, `TimesheetApiEditForm`, tracking modes, `TimesheetService`).
- Response shapes are validated at runtime, so API drift shows up as a clear "unexpected shape" error rather than
  wrong data.
- Tracking modes other than `default` (`punch`, `duration_fixed_begin`) only let privileged users set `begin`/`end`
  through the API. Kimai then rejects `create_timesheet` and time changes in `update_timesheet` with an
  "extra fields" validation error, which the tool explains.
- `billable` is only accepted if the account has the matching Kimai permission.
- `list_projects` uses Kimai's default project filter: visible projects whose start/end dates include today.
- `groupBy: "day"` uses the start date as Kimai reports it, i.e. in the time zone stored on each entry. This only
  differs from the current account zone for entries created before an account time-zone change.
