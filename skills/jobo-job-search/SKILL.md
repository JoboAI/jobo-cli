---
name: jobo-job-search
description: Search live job listings and job-market data with the `jobo` command-line tool (Jobo jobs API). Use when the user wants to find or filter open jobs by title, location, remote or hybrid, skills, salary, company, industry or seniority; fetch a job posting or company by id; export or sync jobs to JSON, JSONL or CSV; list jobs that expired; or connect the Jobo MCP server to an AI client.
---

# Jobo job search (`jobo` CLI)

`jobo` queries a live index of job listings collected from employer career sites and 200+ applicant
tracking systems. Run `jobo <command> --help` for every flag; this file is the short version.

## Setup

```bash
npm install -g jobo-cli        # Node 20+. Or run once with: npx jobo-cli <command>
jobo auth --show               # is a key configured? prints it masked; exit 3 means no
```

If no key is configured, ask the user to run `jobo auth` themselves (it prompts without echoing) or
to set `JOBO_API_KEY`. Keys are created at https://enterprise.jobo.world/api-keys. Never print a key,
and do not put one in a command you show the user: use the saved key or the environment variable.

A sandbox key (`jbe_test_…`) is free and returns fictional jobs. It only serves `search`, `job` and
`company`; every other command answers "not available with a sandbox key" (exit 6).

## Cost rules

These are real charges on the user's account. Follow them.

1. **`jobo search` bills every job it returns**: $3.00 per 1,000 jobs (3 credits each) once the
   plan's included jobs are used. An empty result costs nothing. The default is one page of 10.
   Ask for the page size you need (`--page-size 5`), not the maximum.
2. **Only walk pages when the user asked for volume.** `--max N` fetches whole pages up to N jobs
   and stops; there is no unbounded search. Never loop over `--page` to collect "everything". If a
   walk fails part-way, the pages already fetched (and billed) are still written, and stderr gives
   the flags to carry on with (`--page 3 --page-size 100 …`): resume from there, do not start over.
3. **These are free**: `jobo job`, `jobo company`, `jobo companies`, `jobo locations`,
   `jobo filters`, `jobo occupations`, `jobo expired`, `jobo usage`. Use `jobo job <id>` for a
   listing's full details instead of searching again.
4. **`jobo geocode` costs $0.001 per lookup**, resolved or not. To check a place name or build a
   location filter, use `jobo locations`, which is free.
5. **`jobo feed` bills every job that is new to the account** (not received in the last 30 days) at
   the same rate, and refuses to run without `--max N` or `--all`. Start with a small `--max`. Use
   `--all` only when the user explicitly asked for a full sync and knows the size: the first batch
   prints "about N jobs match this feed" on stderr. `--all` with no filter at all means the whole
   index: the CLI refuses it (exit 2) and prints the job count and the most it could cost. Show the
   user that message; add `--yes` only after they have confirmed that cost.
6. **Do not repeat a billed call to reformat it.** Save the output (`-o results.json`) and work
   from the file.
7. After a billed call, a `usage:` line on stderr says what was charged and the wallet balance.
   Mention the cost when it is not trivial. On exit code 4 (insufficient credits) stop and pass the
   top-up link in the error to the user; retrying fails the same way.

## Commands

| Command | What it does | Cost |
| --- | --- | --- |
| `jobo search [query] [filters]` | Search listings. `--page`, `--page-size` (1–100, default 10), `--max N` | Per job returned |
| `jobo job <id>` | One full listing | Free |
| `jobo feed (--max N \| --all) [filters]` | Bulk stream as JSONL, cursor-walked. `--cursor-file FILE` to resume | Per new job |
| `jobo expired [--since 24h] [--limit N]` | Ids of jobs that expired. `--since` reaches back 7 days at most; more is refused | Free |
| `jobo company <id>` | One company profile | Free |
| `jobo companies <query>` | Company name or domain prefix → ids and live job counts, and the `--companies` value to paste | Free |
| `jobo locations <query>` | Place name prefix → exact place names, and the feed's `--locations` value to paste | Free |
| `jobo geocode <location>` | Place name → coordinates and normalized names | $0.001 |
| `jobo filters` | Fixed vocabularies, and ATS sources with live job counts | Free |
| `jobo filters <facet> [query]` | Values of an open vocabulary, with live job counts | Free |
| `jobo occupations [query]` | The occupation taxonomy (large), or the occupations whose name matches | Free |
| `jobo usage` | Key in use and rate-limit position | Free |
| `jobo mcp [client]` | How to connect the hosted Jobo MCP server to an AI client (prints only) | Free |
| `jobo completion <bash\|zsh\|fish>` | Prints a tab-completion script for the user's shell (not something you need) | Free |

## Search filters

Every filter is a flag. List flags repeat or take commas (`--skills Python,Go`); filters whose
values are names (`--industries`, `--job-categories`, `--job-subcategories` and their `--exclude-`
twins) are never split on commas, so repeat the flag for each value. `--companies` splits a list of
ids or domains (`--companies ID1,ID2`, `--companies stripe.com,shopify.com`) and keeps a name whole.

The CLI forgives spelling, not meaning: a flag works in the singular or the plural (`--work-model`,
`--work-models`), a fixed value in any case (`Remote`), and `--limit` means `--max`. A mistyped flag
or fixed value exits 2 before anything is sent and names the nearest match ("Did you mean
--work-model?"): fix the command and run it again.

- Text and place: a query argument (or `--q`), `--location "Berlin, Germany"`,
  `--search-description false` for title-only matching. Quote a phrase for an exact title match.
- Fixed vocabularies: `--work-model remote|hybrid|onsite`,
  `--employment-type full-time|part-time|contract|internship|freelance|temporary`,
  `--experience-level intern|entry|mid|senior|lead|executive`, `--language en,de` (ISO 639-1).
- Open vocabularies, each with an `--exclude-` twin: `--skills`, `--companies`, `--industries`,
  `--company-categories`, `--job-categories`, `--job-subcategories`, `--occupation-ids`. Also
  `--sources` (ATS ids such as greenhouse).
- Numbers and dates: `--min-salary-usd`, `--max-salary-usd`, `--posted-after`, `--posted-before`,
  `--discovered-after`, `--discovered-before`. Dates are ISO 8601 or an age: `24h`, `7d`, `2w`.
- Order and shape: `--sort relevance|discovered_asc|discovered_desc`,
  `--description-format markdown|html|enhanced|enhanced_html`.

**Values are matched literally. A wrong value is not an error: it returns zero results.** A fixed
vocabulary is checked by the CLI before sending; for the open ones, look the value up first (free):

```bash
jobo filters                      # fixed vocabularies + every source with its job count
jobo filters skills pyth          # skills starting with "pyth"
jobo filters job_categories       # facets: sources, industries, skills, company_categories,
jobo filters occupations nurse    #         job_categories, job_subcategories, occupations (by name)
jobo companies stripe             # company → ids, and on stderr the --companies value to paste
jobo locations berlin             # place → exact names, and the feed's --locations value
```

When a search does return nothing and one of these filters was used, a `note:` on stderr names the
flags to check and the lookup command for each. Check the values before concluding there are no
such jobs.

For occupations, `--occupation-ids` takes the id in the `value` column, not the name. Salary filters
only match jobs whose employer published a salary.

## Output

- Stdout is data only; costs, notes, cursors and errors go to stderr. When stdout is not a terminal
  the default is JSON. `--jsonl`, `--csv` and `--table` choose another format; `-o FILE` writes a
  file (refused if it exists, unless `--overwrite` or `--append`). A run that fails before writing
  anything leaves no file, so the same command can be run again.
- `jobo search --json` prints `{ "jobs": [...], "total", "page", "page_size", "total_pages", ... }`.
- Keep output small. `--include-fields none` drops descriptions and the other heavy fields from
  search results (same price), and `--fields id,title,company.name,locations,apply_url` reduces
  each record to those keys. In JSON the values stay as the API returns them (`locations` is an
  array of objects); only a table or CSV flattens them to text. Fetch the full text of the few
  listings that matter with `jobo job`.
- `--quiet` silences the stderr notes.
- Exit codes: 0 ok, 1 error, 2 bad arguments (nothing was billed), 3 no or rejected key,
  4 insufficient credits, 5 rate limited, 6 not found, 7 API unreachable, 8 feed cursor must restart.

## Examples

Remote senior Python roles posted this week, five results, compact:

```bash
jobo search "python engineer" --work-model remote --experience-level senior,lead \
  --posted-after 7d --page-size 5 --include-fields none \
  --fields id,title,company.name,locations,date_posted,apply_url
```

Read one listing in full (free), from an id in the results:

```bash
jobo job a1b2c3d4-e5f6-7890-abcd-ef1234567890 --json
```

Jobs at one company: resolve the company first, then filter on every id it has:

```bash
jobo companies stripe --json            # → suggestions[].ids; stderr has the --companies line
jobo search --companies ID1,ID2 --page-size 10 --include-fields none
```

Nursing jobs in Texas paying at least $90k, as a CSV the user can open:

```bash
jobo filters job_subcategories nurs     # confirm the exact subcategory name
jobo search --job-subcategories Nursing --location "Texas, United States" \
  --min-salary-usd 90000 --page-size 25 --csv -o nursing-texas.csv
```

A bounded bulk pull, resumable if it stops (the feed has no text query; it takes structured
filters, and `--locations` is `country=…[,region=…][,city=…]`, never free text):

```bash
jobo feed --max 500 --sources greenhouse,lever --work-models remote \
  --updated-after 24h --cursor-file feed.cursor --output jobs.jsonl --append
```

The same for one city: look the place up first (free) and paste the value it prints:

```bash
jobo locations austin                   # → feed: --locations "country=United States,region=Texas,city=Austin"
jobo feed --max 200 --locations "country=United States,region=Texas,city=Austin" \
  --job-subcategories Nursing --cursor-file austin.cursor --output austin-nursing.jsonl --append
```

Connect an AI client to the hosted MCP server instead of using the CLI:

```bash
jobo mcp            # lists supported clients
jobo mcp cursor     # prints the config to add; it never edits files itself
```
