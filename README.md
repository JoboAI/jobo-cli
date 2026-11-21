# jobo-cli

Command-line client for the [Jobo jobs API](https://jobo.world/docs): search live job listings from
employer career sites and 200+ applicant tracking systems, stream the job feed, and look up companies,
locations and filter values. It ships an [Agent Skill](#agent-skill) that teaches coding agents to use
it, and prints the setup for the hosted [MCP server](#mcp-server).

```bash
jobo search "data engineer" --location "Berlin, Germany" --work-model remote,hybrid
```

No runtime dependencies: one package, Node 20 or later.

## Install

```bash
npm install -g jobo-cli      # installs the `jobo` command
npx jobo-cli --help          # or run it without installing
```

## Authenticate

Create an API key in the [dashboard](https://enterprise.jobo.world/api-keys) under **Developers → API
Keys** ([sign up](https://enterprise.jobo.world/register) first if you have no account), then:

```bash
jobo auth                    # prompts for the key without echoing it
jobo auth --api-key KEY      # or pass it
echo "$KEY" | jobo auth      # or pipe it
jobo auth --show             # where the key is stored and which one is in use, masked
jobo logout                  # remove the saved key
```

`jobo auth` checks the key's shape, then verifies it with one call that is never billed, and saves it to
`$XDG_CONFIG_HOME/jobo/config.json` (default `~/.config/jobo/config.json`; `%APPDATA%\jobo\config.json`
on Windows) with mode `0600`. `--no-verify` skips the check.

Which key a command uses, first match wins:

1. `--api-key KEY` on the command
2. the `JOBO_API_KEY` environment variable
3. the saved key

Live keys start with `jbe_live_`. A sandbox key (`jbe_test_`) is free and returns fictional jobs in the
real response shape; it serves `search`, `job` and `company` only.

## What it costs

Jobo bills per job, not per request. Credits are the wallet's unit: 1,000 credits = $1.00.

| Command | Cost |
| --- | --- |
| `jobo search` | Every job returned: $3.00 per 1,000 jobs (3 credits each) after your plan's included jobs. An empty page is free. |
| `jobo feed` | Every job that is new to you: one you have not received through Feed, Export or Outbound in the last 30 days. Same rate. Jobs you already hold are delivered again at no charge. |
| `jobo geocode` | $0.001 per lookup (1 credit), resolved or not. |
| `jobo job`, `company`, `companies`, `filters`, `occupations`, `expired`, `usage` | Free. |

On the Unlimited plan, Search and Feed have no per-job charge. See [Billing](https://jobo.world/docs/billing).

The CLI is built so a mistake cannot run up a bill:

- `jobo search` fetches one page of 10 unless you ask for more. `--max N` walks whole pages up to N jobs
  and stops; there is no unbounded search.
- `jobo feed` refuses to run without `--max N` or `--all`.
- Arguments are validated before anything is sent, and an output file that already exists is refused
  before the request, not after it.
- Every billed request prints what it cost on stderr:

  ```text
  usage: 30 credits ($0.03) charged · wallet 4,970 credits ($4.97)
  ```

The wallet must cover a full page before a request runs (`--page-size` jobs for search, `--batch-size`
for the feed), so use a smaller size on a low balance. A `402` is never retried; the error carries the
top-up link.

## Commands

Every command takes `--help`.

### `jobo search [query]`

`POST /api/jobs/search`. Billed per job returned.

```bash
jobo search "python engineer" --work-model remote --experience-level senior,lead --posted-after 7d
jobo search --skills Python --exclude-skills PHP --min-salary-usd 120000 --page-size 5
jobo search --companies stripe.com --json
jobo search nurse --sort discovered_asc --discovered-after 2026-11-01 --discovered-before 2026-11-02 \
  --max 200 --csv -o nurses.csv
```

Every filter of the API is a flag, generated from the same contract the other Jobo connectors use:

| Flags | Values |
| --- | --- |
| `[query]` or `--q`, `--location`, `--search-description` | Free text. `--search-description false` matches titles only. |
| `--work-model`, `--employment-type`, `--experience-level` | Fixed lists; see `jobo filters`. |
| `--language` | ISO 639-1 codes: `en`, `de`. |
| `--sources` | ATS ids such as `greenhouse`; `jobo filters sources`. |
| `--companies`, `--exclude-companies` | A company id, a website domain or a whole company name; `jobo companies`. |
| `--skills`, `--industries`, `--company-categories`, `--job-categories`, `--job-subcategories`, `--occupation-ids` (each with an `--exclude-` twin) | `jobo filters <facet>`. |
| `--min-salary-usd`, `--max-salary-usd` | Numbers. |
| `--posted-after`, `--posted-before`, `--discovered-after`, `--discovered-before` | ISO 8601, or an age: `24h`, `7d`, `2w`. |
| `--sort` | `relevance` (default), `discovered_asc`, `discovered_desc`. |
| `--description-format` | `markdown` (default), `html`, `enhanced`, `enhanced_html`. |

List flags repeat or take commas (`--skills Python,Go`). Flags whose values are names (`--companies`,
`--industries`, `--job-categories`, `--job-subcategories` and their `--exclude-` twins) are not split on
commas, because the names can contain one: repeat the flag.

Filter values are matched literally, so a wrong value returns zero results, not an error. The CLI
rejects an unknown value of a fixed list before sending; for the others, look the value up first.

Paging: `--page N`, `--page-size N` (1–100, default 10) and `--max N`. `--max` never bills more than N:
search pages by number, so only whole pages are fetched and a remainder is left unfetched. The default
order can shift between pages; for a stable walk use `--sort discovered_asc` with a
`--discovered-after`/`--discovered-before` window. Search stops at a depth of 100,000 results: use the
feed beyond that.

`--include-fields none` returns the core fields only (no description, summary, qualifications,
responsibilities or benefits) at the same price; `--facets work_model,sources` adds facet counts to the
JSON output.

### `jobo job <id>`

One full listing. Free.

```bash
jobo job a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### `jobo feed`

`POST /api/jobs/feed`, cursor-walked, written as JSONL (one job per line). Billed per new job, so it
needs `--max N` or `--all`. Not available with a sandbox key.

```bash
jobo feed --max 500 --sources greenhouse,lever --work-models remote > jobs.jsonl

jobo feed --all --locations "country=United States" --job-subcategories Nursing \
  --company-is-agency false --cursor-file nursing.cursor --output nursing.jsonl --append
```

- `--max N` is exact: the last batch is shrunk to fit. `--batch-size N` (1–1000) sets the request size.
- After every batch the next cursor is printed on stderr, and with `--cursor-file FILE` saved to that
  file once the batch's jobs are written. If the run dies, run the same command again: it resumes from
  the file. The file is removed when the scan completes. `--cursor CURSOR` resumes from a cursor you
  kept yourself. Cursors do not expire.
- A cursor keeps the filters and batch size of the scan it came from; filters given with one are ignored.
- Filters are the feed's own (plural) fields: `--locations`, `--sources`, `--work-models`,
  `--employment-types`, `--experience-levels`, `--languages` and their `--exclude-` twins;
  `--companies`, `--job-categories`, `--job-subcategories`, `--occupation-ids`, `--industries`,
  `--company-primary-industries`, `--company-categories`, `--company-sizes`, `--company-revenues`, each
  with an `--exclude-` twin; `--company-is-agency`, `--posted-after`, `--include-reactivated`,
  `--updated-after`, `--description-format`. `--locations` takes `country=…[,region=…][,city=…]` or a
  bare country name. `--body JSON|@FILE` passes a raw request body, such as one written by the
  [Feed Builder](https://jobo.world/api/feed-builder).
- Retries follow the API's rules: `429`, `500` and `503` are retried after `Retry-After`; `402` and a
  dead cursor (`400 invalid_cursor`, `409 feed_cursor_restart_required`) are not. A dead cursor exits 8:
  discard it and start a new scan.
- Other formats: `--csv` streams too; `--json` and `--table` collect everything first.

### `jobo expired`

Ids of jobs that left the employer's career site, to close them in your own store. Free. Not available
with a sandbox key.

```bash
jobo expired --since 24h --jsonl
jobo expired --since 2026-11-18T00:00:00Z --all --csv -o expired.csv
```

The window starts 24 hours ago by default and reaches back at most 7 days. `--limit N` (default 1,000)
caps the ids returned; `--all` returns the whole window.

### `jobo company <id>` and `jobo companies <query>`

```bash
jobo companies stripe          # name or domain prefix → ids, domain, country, live job count
jobo company b5e6f7a8-1234-5678-9abc-def012345678
```

Both are free; `jobo company` works without an API key. One company can have several ids, one per
careers board: pass every id from `ids` to `--companies`.

### `jobo geocode <location>`

```bash
jobo geocode "San Francisco, CA"
```

Coordinates and normalized city, region and country names. **$0.001 per lookup**, charged whether or not
the place resolves; an unresolved place prints `succeeded: false` and exits 1. Not available with a
sandbox key.

### `jobo filters` and `jobo occupations`

```bash
jobo filters                       # fixed vocabularies, and every source with its live job count
jobo filters skills pyth           # values of one open vocabulary, optionally narrowed by a query
jobo filters occupations nurse --json
jobo occupations --csv -o occupations.csv
```

Facets: `sources`, `industries`, `skills`, `company_categories`, `job_categories`, `job_subcategories`,
`occupations`. `--limit N` (1–250, default 50). The `value` column is what the matching search flag
takes; for occupations that is the occupation id. `jobo occupations` prints the whole taxonomy. All
free; none are available with a sandbox key.

### `jobo usage`

```bash
jobo usage
```

Makes one free call and reports the key in use and its rate-limit position. The API has no balance
endpoint: it reports the wallet balance and included jobs only on billed Search and Feed responses, which
is the `usage:` line those commands print. The balance is also on the
[billing page](https://enterprise.jobo.world/credits).

## Output

| stdout | Default format |
| --- | --- |
| A terminal | A table (the feed: JSONL) |
| A pipe or file | JSON (the feed: JSONL) |

`--json`, `--jsonl`, `--csv` and `--table` choose a format. `--output FILE` (`-o`) writes a file and
takes its format from the extension (`.json`, `.jsonl`, `.ndjson`, `.csv`) unless a flag says otherwise;
an existing file is refused unless you pass `--overwrite` or, for JSONL and CSV, `--append`.

`--fields id,title,company.name` keeps only those fields, as dot paths: the columns of a table or CSV,
and the keys of each JSON record.

Data goes to stdout. Usage lines, progress, cursors, warnings and errors go to stderr, so piping stays
clean; `--quiet` silences everything on stderr but errors.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The API refused the request, or another error |
| 2 | Bad arguments. Nothing was sent |
| 3 | No API key, a malformed one, or one the API rejected |
| 4 | Insufficient credits (`402`) |
| 5 | Rate limited (`429`) after retries |
| 6 | Not found, or not available with a sandbox key |
| 7 | The API could not be reached, or kept failing after retries |
| 8 | The feed cursor cannot be continued: start a new scan |

## Agent Skill

The package includes an [Agent Skill](skills/jobo-job-search/SKILL.md), `jobo-job-search`: instructions
that tell a coding agent when to reach for this CLI, which flags exist, how to look up valid filter
values, and the cost rules it has to respect.

```bash
jobo skill install               # → ~/.claude/skills/jobo-job-search
jobo skill install --project     # → ./.claude/skills/jobo-job-search
jobo skill install --dir PATH    # → PATH/jobo-job-search
jobo skill path                  # where the bundled skill folder lives
jobo skill show >> AGENTS.md     # print SKILL.md, for agents that read one instructions file
```

An existing copy is left alone unless you pass `--overwrite`.

## MCP server

For an AI client, the hosted Jobo MCP server (`https://jobs-mcp.jobo.world/mcp`) gives the same search
without a terminal. It signs you in with your Jobo account through OAuth, so there is no API key to
paste, and its searches bill like `jobo search`.

```bash
jobo mcp                # the clients this CLI has instructions for
jobo mcp claude-code    # the command to run, or the config to paste, for one client
jobo mcp cursor --json
```

`jobo mcp` only prints instructions. It never writes to another tool's configuration. See the
[MCP server docs](https://jobo.world/docs/connectors/mcp).

## Environment

| Variable | Purpose |
| --- | --- |
| `JOBO_API_KEY` | API key. Beats the saved key; `--api-key` beats both. |
| `JOBO_API_URL` | API base URL, default `https://connect.jobo.world`. For proxies and tests; plain `http` is accepted for localhost only. |
| `XDG_CONFIG_HOME` | Moves the config file to `$XDG_CONFIG_HOME/jobo/config.json`. |

## Development

This package lives in the Jobo monorepo under `Jobo.Connectors/cli/` and is standalone: it has its own
lockfile and is not an npm workspace member.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`@jobo-ai/connector-core`, the client shared by every Jobo connector, is a devDependency pinned to an
exact version and inlined into `dist/` at build time, so the published package has no runtime
dependencies. The search flags are generated from that package's filter contract, and a test fails when
the contract gains a filter the CLI has no proof for. Tests run against a fake transport: no network and
no API key.

## License

MIT
