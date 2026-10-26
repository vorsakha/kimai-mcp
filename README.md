# kimai-mcp

Connect your AI assistant to [Kimai](https://www.kimai.org) to log work, correct time entries,
start and stop timers, and review your hours.

## Setup

Requires Node.js 22.18 or newer and a Kimai API token.

```sh
npm ci
npm run build
```

Copy `.env.example` to `.env` and fill in your connection settings. Create an API token from
**API Access** in your Kimai profile.

| Variable          | Required | Value                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `KIMAI_BASE_URL`  | Yes      | Your Kimai instance URL, using HTTPS.                                    |
| `KIMAI_API_TOKEN` | Yes      | Your personal API token.                                                 |
| `KIMAI_TIMEZONE`  | No       | IANA timezone fallback if Kimai does not report your account's timezone. |

Keep `.env` private. It is excluded from Git.

## Connect your assistant

Add this entry to your client's MCP configuration. Replace both paths with absolute paths to your checkout.
The client must support stdio MCP servers.

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

You can also supply the environment variables directly through your MCP client.

## Try it

- "Log yesterday from 09:00 to 11:30 on Project X, development, working on CODE-123."
- "Show my hours this week by project."
- "Change yesterday's CODE-123 entry to end at noon."
- "Start a timer for Project X."

## Good to know

- Times use your Kimai account's timezone. Date ranges include entries that start within the range;
  overnight work counts toward its start day.
- Summaries use Kimai's recorded durations and exclude running timers.
- Writes never retry automatically. `UNKNOWN OUTCOME` means the change may have succeeded;
  check your entries before trying again.
- Starting a timer at your instance's running-timer limit returns an error. Stop an existing timer first.
- Editing times and billable status depends on your account's permissions and Kimai's tracking mode.

Write tools have been tested offline but have not been exercised against a live instance.

## Development

```sh
npm run typecheck
npm test
npm run build
```
