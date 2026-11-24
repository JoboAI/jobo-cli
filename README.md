# jobo-cli

Command-line client for the [Jobo jobs API](https://jobo.world/docs): search live job listings from
employer career sites and 200+ applicant tracking systems, stream the job feed, read hiring signals, and
look up companies, locations and filter values. It ships an [Agent Skill](#agent-skill) that teaches coding agents to use
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

Then turn on [tab completion](#shell-completion) for bash, zsh or fish.

## Authenticate

Sign in with your Jobo account ([sign up](https://enterprise.jobo.world/register) first if you have none):

```bash
jobo login                   # opens your browser to sign in with Jobo
jobo login --no-browser      # prints the sign-in URL without opening a browser
jobo auth --show             # where the key is stored, which one is in use (masked), and the account
jobo logout                  # remove the saved key, and revoke it if you signed in
```

`jobo login` opens Jobo's sign-in page. After you sign in and approve the request, an API key for your
account comes back to the command on `127.0.0.1` and is saved for you. The key is never printed. The
sign-in URL is always printed too, so you can open it yourself; the browser has to run on the same machine
as the command. The command waits five minutes, and Ctrl-C cancels it.

The key does not expire. The Jobo CLI is listed under **Developers → API Keys** in the
[dashboard](https://enterprise.jobo.world/api-keys) as a connected app. `jobo logout` revokes the key and
removes the CLI from that list; disconnecting it in the dashboard does the same from the other side. A key
you created and saved with `jobo auth` is only removed from this machine by `jobo logout`.

On a remote machine, in a script or in CI, use an API key. Create one in the dashboard under
**Developers → API Keys**, then:

```bash
jobo auth                    # prompts for the key without echoing it
jobo auth --api-key KEY      # or pass it
echo "$KEY" | jobo auth      # or pipe it
```

`jobo auth` checks the key's shape, then verifies it with one call that is never billed. `--no-verify`
skips the check. Both commands save the key to `$XDG_CONFIG_HOME/jobo/config.json` (default
`~/.config/jobo/config.json`; `%APPDATA%\jobo\config.json` on Windows) with mode `0600`.

Which key a command uses, first match wins:

1. `--api-key KEY` on the command
2. the `JOBO_API_KEY` environment variable
3. the saved key

Live keys start with `jbe_live_`. A sandbox key (`jbe_test_`) is free and returns fictional jobs in the
real response shape; it serves `search`, `job` and `company` only (not `signals`).

## What it costs

Jobo bills per job, not per request. Credits are the wallet's unit: 1,000 credits = $1.00.

| Command | Cost |
| --- | --- |
| `jobo search` | Every job returned: $3.00 per 1,000 jobs (3 credits each) after your plan's included jobs. An empty page is free. |
| `jobo feed` | Every job that is new to you: one you have not received through Feed, Export or Outbound in the last 30 days. Same rate. Jobs you already hold are delivered again at no charge. |
| `jobo signals` | Every hiring signal returned, at ten times the price of a job: 30 credits ($0.03) each after your plan's included signals. A signal read again is billed again. An empty page is free. |
| `jobo geocode` | $0.001 per lookup (1 credit), resolved or not. |
| `jobo job`, `company`, `companies`, `locations`, `filters`, `occupations`, `expired`, `usage` | Free. |

On the Unlimited plan, Search and Feed have no per-job charge. See [Billing](https://jobo.world/docs/billing).

The CLI is built so a mistake cannot run up a bill:

- `jobo search` fetches one page of 10 unless you ask for more. `--max N` walks whole pages up to N jobs
  and stops; there is no unbounded search.
- `jobo signals` reads 10 signals unless `--max N` says otherwise, and has no `--all`.
- `jobo feed` refuses to run without `--max N` or `--all`, and `--all` with no filter (the whole index)
  also needs `--yes`: without it the CLI prints how many jobs that is and the most it could cost, then
  stops.
- Arguments are validated before anything is billed, and an output file that already exists is refused
  before the request, not after it.
- What you were billed for is never thrown away: if a multi-page search fails part-way, the pages already
  fetched are written and the error says which `--page` to resume from.
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
jobo search --companies stripe.com,shopify.com --json
jobo search engineer --industries "Software Development" --company-categories saas --page-size 5
jobo search nurse --sort discovered_asc --discovered-after 2026-11-01 --discovered-before 2026-11-02 \
  --max 200 --csv -o nurses.csv
```

Every filter of the API is a flag, generated from the same contract the other Jobo connectors use:

| Flags | Values |
| --- | --- |
| `[query]` or `--q` (also `--query`), `--location`, `--search-description` | Free text. `--search-description false` matches titles only. `jobo locations` checks a place name. |
| `--work-model`, `--employment-type`, `--experience-level` | Fixed lists; see `jobo filters`. |
| `--language` | ISO 639-1 codes: `en`, `de`. |
| `--sources` | ATS ids such as `greenhouse`; `jobo filters sources`. |
| `--companies`, `--exclude-companies` | A company id, a website domain or a whole company name; `jobo companies`. |
| `--skills`, `--industries`, `--company-categories`, `--job-categories`, `--job-subcategories`, `--occupation-ids` (each with an `--exclude-` twin) | `jobo filters <facet>`. |
| `--min-salary-usd`, `--max-salary-usd` | US dollars a year. Only jobs that publish a salary can match. |
| `--posted-after`, `--posted-before`, `--discovered-after`, `--discovered-before` | ISO 8601, or an age: `24h`, `7d`, `2w`. |
| `--sort` | `relevance` (default), `discovered_asc`, `discovered_desc`. |
| `--description-format` | `markdown` (default), `html`, `enhanced`, `enhanced_html`. |

List flags repeat or take commas (`--skills Python,Go`). Flags whose values are names (`--industries`,
`--job-categories`, `--job-subcategories` and their `--exclude-` twins) are not split on commas, because
a name can contain one: repeat the flag. `--companies` splits a list of ids or domains
(`--companies stripe.com,shopify.com`) and keeps anything else whole, so `--companies "Acme, Inc."` is
one company.

A filter flag works in the singular or the plural (`--work-model`, `--work-models`), here and on the
feed. Fixed values are accepted in any case (`Remote`, as a job prints it, or `remote`). A mistyped flag
or value is refused before anything is sent, with the nearest match:

```text
error: Unknown flag --work-modle. Did you mean --work-model?
```

Values of the open vocabularies (sources, industries, skills, categories, companies) are matched
literally, so a wrong one returns zero results, not an error. Look the value up first; when a search
does match nothing, the CLI names the flags to check and the command that lists their valid values.

Paging: `--page N`, `--page-size N` (1–100, default 10) and `--max N` (also `--limit`). `--max` never
bills more than N: search pages by number, so only whole pages are fetched and a remainder is left
unfetched. The default order can shift between pages; for a stable walk use `--sort discovered_asc` with
a `--discovered-after`/`--discovered-before` window. Search stops at a depth of 100,000 results: use the
feed beyond that.

If a multi-page walk fails (a `429` on page 3, say), the pages it was billed for are still delivered:
JSONL and CSV are written page by page as they arrive, and a JSON document or table is written with what
there is, marked `"partial": true`. The command exits with the failure's own code and prints the flags
that carry on from there:

```text
200 jobs from pages 1–2 were fetched and billed before the error, and are written to out.jsonl.
Resume with the same filters and --page 3 --page-size 100 --max 300 --append.
```

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

jobo feed --max 500 --industries "Software Development" --company-primary-industries Finance
jobo feed --max 200 --body @feed.json --cursor-file feed.cursor -o jobs.jsonl --append
```

- `--max N` (also `--limit`) is exact: the last batch is shrunk to fit. `--batch-size N` (1–1000) sets
  the request size.
- `--all` with no filter, `--body` or cursor would sync the whole index. The CLI then looks up the index
  size (a free call), prints the job count and the most the run could cost, and stops; add `--yes` to go
  ahead.
- After every batch the next cursor is printed on stderr, and with `--cursor-file FILE` saved to that
  file once the batch's jobs are written. If the run dies, run the same command again: it resumes from
  the file. The file is removed when the scan completes. `--cursor CURSOR` resumes from a cursor you
  kept yourself. Cursors do not expire.
- A resumed scan can deliver a page again (a crash between writing a batch and saving its cursor), so
  with `--append` load the jobs by job id (an upsert), not as new rows.
- With `--json` or `--table` the jobs are written once, at the end, and the cursor file is saved only
  after that. If a later batch fails (a `402` when the balance runs out, a `503` after the retries), the
  jobs already fetched are still written, with `"partial": true` in the JSON, and the cursor file then
  points just past them.
- A cursor keeps the filters and batch size of the scan it came from; filters given with one are ignored.
- Filters are the feed's own (plural) fields, and it has no text query:
  - `--locations`, which has no exclude form. It takes `country=…[,region=…][,city=…]` or a bare country
    name, not free text: `jobo locations <query>` prints the exact value to paste. Repeat the flag to
    match any of several places.
  - `--sources`, `--work-models`, `--employment-types`, `--experience-levels`, `--languages`,
    `--companies`, `--job-categories`, `--job-subcategories`, `--occupation-ids`, `--industries`,
    `--company-primary-industries`, `--company-categories`, `--company-sizes`, `--company-revenues`,
    each with an `--exclude-` twin.
  - `--company-is-agency`, `--posted-after`, `--include-reactivated`, `--updated-after`,
    `--description-format`.
- `--body` passes a raw request body, inline (`--body '{"job_subcategories":{"include":["Nursing"]}}'`)
  or from a file (`--body @feed.json`), such as one written by the
  [Feed Builder](https://jobo.world/api/feed-builder). Filter flags are merged over it.
- Retries follow the API's rules: `429`, `500` and `503` are retried after `Retry-After`; `402` and a
  dead cursor (`400 invalid_cursor`, `409 feed_cursor_restart_required`) are not. A dead cursor exits 8:
  discard it and start a new scan. If it came from `--cursor-file FILE`, the file is moved to
  `FILE.dead` (replacing an older one), so the next run of the same command starts the new scan.
- Other formats: `--csv` streams too; `--json` and `--table` collect everything first.

### `jobo expired`

Ids of jobs that left the employer's career site, to close them in your own store. Free. Not available
with a sandbox key.

```bash
jobo expired --since 24h --jsonl
jobo expired --since 2026-11-18T00:00:00Z --csv -o expired.csv
```

The window starts 24 hours ago by default and reaches back at most 7 days: the API keeps expired ids no
longer, so an earlier `--since` is refused before anything is sent. Every page is walked, so the output
holds every id in the window. `--limit N` (also `--max`) stops after N ids and prints the cursor to
continue from on stderr. `--all` is still accepted; it is now the default.

### `jobo signals`

[Hiring signals](https://jobo.world/docs/guides/hiring-signals): one event at one company, detected
from its job postings. A hiring surge, a first job in a country, a leadership search, a new technology,
a slowdown. Not available with a sandbox key.

```bash
jobo signals --types hiring_surge,new_country --countries US --min-strength 70
jobo signals --domains stripe.com,shopify.com --detected-after 30d --max 25 --csv -o signals.csv
jobo signals --types hard_to_fill --functions Technology --seniority senior,director --job-countries US --jsonl
jobo signals --company-id 6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33 --types leadership_hire
```

**Each signal returned is billed at ten times the price of a job** (30 credits, $0.03, after your plan's
included signals), and a signal read again is billed again. A request that returns nothing is free.

- `--max N` is how many signals to read: **10 unless you say otherwise**, and the first line on stderr
  says so. Pages are walked until N is reached, and no page asks for more than is still wanted (200 at
  most). There is no `--all`. When more remain, stderr prints the next cursor; `--cursor CURSOR` with the
  same flags reads on.
- `--sort ORDER` picks the order: `detected_desc` (the default) is the newest detection day first;
  `created_asc` is the order Jobo stored the signals in, oldest first. A cursor belongs to the order it
  was printed under, so read on with the same `--sort`.
- One flag per filter, named like the API's query parameter: `--types`, `--domains`, `--company-ids`,
  `--exclude-domains`, `--countries`, `--company-sizes`, `--industries`, `--categories`,
  `--funding-stages`, `--founded-after`, `--exclude-agencies`, `--functions`, `--roles`, `--seniority`,
  `--technologies`, `--skills`, `--technology-categories`, `--job-countries`, `--job-regions`,
  `--job-cities`, `--min-strength`, `--min-new-jobs`, `--min-days-open`, `--reposted-only`,
  `--detected-after`, `--detected-before`, `--created-after`. Lists take commas or a repeated flag, at
  most 100 values. `--types`, `--seniority` and `--company-sizes` are checked, and completed, against
  their fixed values.
- `--company-id ID` reads one company. That endpoint takes only `--types`, `--min-strength`,
  `--detected-after`, `--detected-before` and `--created-after`; the CLI refuses any other filter by
  name before sending anything. To combine a company with other filters, use `--company-ids`.
- Every record carries the API's fields plus `type_label` ("Hiring surge") and `summary` ("17 new jobs
  this week vs 3.1 a week normally"), the wording Jobo's dashboard uses. The table shows the detection
  day, company, type, strength and summary. A type the CLI does not know is shown by its name.
- A request whose answer is lost (a timeout, a dropped connection, a 5xx) is not sent again: it may have
  been billed. Only a `429` is retried. If a later page fails, the signals already read are written
  (marked `"partial": true` in JSON) and stderr gives the cursor to read on from.

To read only what is new, read in stored order with `--sort created_asc`, and pass the `created_at` of
the last signal you read as `--created-after`, exactly as it came: it has microseconds, and the CLI sends
it unchanged. The run reads the signals stored after that one, oldest first, and no signal is read or
billed twice. After each read in stored order, stderr prints the value to continue from
(`continue from: --created-after …`), so you can keep it without parsing the output.

```bash
jobo signals --domains stripe.com --sort created_asc --created-after 2026-11-24T13:53:55.837281Z --max 50 --jsonl -o new.jsonl --append
```

Start the first read from a time, such as `--created-after 24h`. Without `--created-after`, stored order
starts at the oldest signal Jobo holds, and every signal read is billed. Signals stored before 2026-11-24
were stored in batches that share one `created_at`, and a time cannot resume inside such a batch: while
stderr prints a next cursor, read on with `--cursor` and the same flags until no more remain, then go
back to `--created-after`.

### `jobo company <id>` and `jobo companies <query>`

```bash
jobo companies stripe          # name or domain prefix → ids, domain, country, live job count
jobo company b5e6f7a8-1234-5678-9abc-def012345678
```

`jobo company` takes a company id (a GUID, `company.id` on a job), not a name or domain: given
`stripe.com`, it stops with a usage error that points to `jobo companies stripe.com`.

Both are free; `jobo company` works without an API key. One company can have several ids, one per
careers board, and `--companies` should get them all. `jobo companies` writes them the way the flag
takes them, and prints the flag for the first match on stderr, ready to paste into search or the feed:

```text
to filter on Stripe (the first match), in search or the feed: --companies b5e6f7a8-…,0a1b2c3d-…
```

### `jobo locations <query>`

```bash
jobo locations berlin
jobo locations san fran --limit 3
```

Places whose name starts with the query, spelled the way the job index stores them. Free, and the lookup
to use before filtering by place (`jobo geocode` is the billed one):

```text
PLACE                    CC  FEED --LOCATIONS VALUE
Berlin, Berlin, Germany  DE  country=Germany,region=Berlin,city=Berlin

search: --location "Berlin, Berlin, Germany"
feed: --locations country=Germany,region=Berlin,city=Berlin
```

The last column is the value `jobo feed --locations` takes; with `--json` it is each record's
`feed_location`. The place name is what `jobo search --location` takes. `--limit N` (1–10, default 5).
Not available with a sandbox key.

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
jobo filters occupations nurse     # occupations by name, most live jobs first
jobo occupations registered nurse  # the same search over the taxonomy, without job counts
jobo occupations --csv -o occupations.csv
```

Facets: `sources`, `industries`, `skills`, `company_categories`, `job_categories`, `job_subcategories`,
`occupations`. A facet can be written the way its flag is (`jobo filters job-categories`). `--limit N`
(1–250, default 50; also `--max`). The `value` column is what the matching search flag takes; for
occupations that is the occupation id. A query narrows a facet by the start of its values, except for
occupations, where every word must appear in the occupation's name. `jobo occupations` prints the whole
taxonomy, or the occupations a query matches. All free; none are available with a sandbox key.

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
an existing file is refused unless you pass `--overwrite` or, for JSONL and CSV, `--append`. A run that
fails before it has anything to write leaves no file behind (and leaves an `--overwrite` target as it
was), so the same command can simply be run again.

`--fields id,title,company.name` keeps only those fields, as dot paths. In a table or CSV they are the
columns, with values formatted for a cell (a job's locations as one string). In JSON and JSONL each
record is reduced to those keys and every value stays exactly as the API returned it: `locations` is
still the array, `date_posted` the full timestamp.

Data goes to stdout. Usage lines, progress, cursors, warnings and errors go to stderr, so piping stays
clean; `--quiet` silences everything on stderr but errors.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | The API refused the request, or another error |
| 2 | Bad arguments. Nothing was billed |
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

Jobo runs two hosted MCP servers, and `jobo mcp` prints how to add the right one to an AI client:

- **Developer server** (`https://dev-mcp.jobo.world/mcp`), for coding agents and IDEs. It looks up company
  ids, occupations and filter values and builds a checked search request while you write code. It takes
  your API key as a header, the same `JOBO_API_KEY` this CLI reads, and every tool on it is free.
- **Job search server** (`https://jobs-mcp.jobo.world/mcp`), for AI assistants. It gives the same search
  as this CLI without a terminal. It signs you in with your Jobo account through OAuth, so there is no API
  key to paste, and its searches bill like `jobo search`.

```bash
jobo mcp                # the clients this CLI has instructions for, and the server each one gets
jobo mcp claude-code    # the command to run, or the config to paste, for one client
jobo mcp cursor --json
```

`jobo mcp` only prints instructions. It never writes to another tool's configuration. See the
[MCP server docs](https://jobo.world/docs/connectors/mcp).

## Shell completion

`jobo completion <shell>` prints a completion script for bash, zsh or fish. Install it once:

```bash
# bash: add to ~/.bashrc
eval "$(jobo completion bash)"

# zsh: add to ~/.zshrc, after compinit
eval "$(jobo completion zsh)"

# fish: run once
jobo completion fish > ~/.config/fish/completions/jobo.fish
```

TAB then completes:

- commands and subcommands, and the flags of the command you are typing;
- the values of fixed lists (`--work-model`, `--experience-level`, `--sort`, `--company-sizes`, …),
  facet names for `jobo filters` and client ids for `jobo mcp`;
- live values, looked up with your saved key: ATS sources, industries and job categories (whole lists,
  cached for ten minutes), skills by prefix, companies by name (completed to their domain) and places
  (`--location "Berlin, Berlin, Germany"` for search, `--locations country=…` for the feed);
- the last item of a comma-separated value: `--work-model remote,hy` completes to `remote,hybrid`;
- file names for `-o` and `--cursor-file`, which are left to the shell.

The lookups call free endpoints only, give up after 4 seconds, never retry, and print nothing when
there is no key or no network, so TAB never hangs for long and never costs anything. The script itself is static:
it asks `jobo` for the candidates each time, so it does not need reinstalling when the CLI is updated.

## Environment

| Variable | Purpose |
| --- | --- |
| `JOBO_API_KEY` | API key. Beats the saved key; `--api-key` beats both. |
| `JOBO_API_URL` | API base URL, default `https://connect.jobo.world`. For proxies and tests; plain `http` is accepted for localhost only. |
| `JOBO_AUTH_URL` | Host `jobo login` signs in at, default `https://enterprise.jobo.world`. For tests; plain `http` is accepted for localhost only. |
| `XDG_CONFIG_HOME` | Moves the config file to `$XDG_CONFIG_HOME/jobo/config.json`. |
| `XDG_CACHE_HOME` | Moves the completion cache to `$XDG_CACHE_HOME/jobo` (default `~/.cache/jobo`; `%LOCALAPPDATA%\jobo\cache` on Windows). Safe to delete. |

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
