# Changelog

## 0.2.0

`jobo mcp` now knows both hosted Jobo MCP servers and sets each client up for the right one.

### Added

- **`jobo mcp perplexity`:** how to add the Jobo MCP server to Perplexity as a custom remote connector.

### Changed

- **`jobo mcp <client>` for coding agents and IDEs** now prints the setup for the developer MCP server
  (`https://dev-mcp.jobo.world/mcp`): free lookups and a request builder, with your API key sent as a
  header. Assistants (ChatGPT, Claude, Perplexity) and Visual Studio still get the job search server, with
  OAuth sign-in. `jobo mcp` lists which server each client is set up for.
- `jobo mcp <client> --json` reports that client's server in `serverUrl` and `serverName`, and the file
  gains a `servers` map.
- Sign-in steps for the job search server say that sign-in starts on the first tool call.

## 0.1.0

First release.

### Added

- **`jobo auth`, `jobo auth --show`, `jobo logout`:** save an API key to
  `$XDG_CONFIG_HOME/jobo/config.json` (mode `0600`), prompted for without echo or read from stdin or
  `--api-key`. The key is verified with a call that is never billed. `JOBO_API_KEY` beats the saved key;
  `--api-key` on any command beats both.
- **`jobo search [query]`:** `POST /api/jobs/search` with every filter of the shared connector contract
  (`@jobo-ai/connector-core` 0.5.0) as a flag, including the `--exclude-` half of each include/exclude
  filter. `--page`, `--page-size` (default 10) and `--max N`, which walks whole pages and never bills
  more than N jobs. A walk that fails part-way still delivers the pages it was billed for (JSONL and CSV
  page by page, JSON marked `"partial": true`), exits with the failure's own code and prints the
  `--page` to resume from. A search that matches nothing names the open-vocabulary filters to check and
  the command that lists their valid values.
- **`jobo job <id>`:** one full listing.
- **`jobo feed`:** `POST /api/jobs/feed` as a cursor-walked JSONL stream. Requires `--max N` or `--all`;
  `--cursor` and `--cursor-file` resume a scan, and the next cursor is printed and saved after every
  batch. `--all` with no filter, `--body` or cursor would sync the whole index: it is refused, with the
  job count and the most it could cost, unless `--yes` is given. `--body` takes inline JSON or `@FILE`.
- **`jobo expired`:** ids of recently expired jobs. A `--since` beyond the API's 7-day window is refused
  before anything is sent.
- **`jobo company <id>`, `jobo companies <query>`:** a company profile, and a name or domain lookup that
  returns the ids `--companies` takes and prints the flag ready to paste.
- **`jobo locations <query>`:** a free place lookup. Each match comes with the value the feed's
  `--locations` takes (`country=…,region=…,city=…`), and the name search's `--location` takes.
- **`jobo geocode <location>`:** resolve a place name ($0.001 per lookup).
- **`jobo filters`, `jobo filters <facet> [query]`, `jobo occupations [query]`:** valid filter values,
  with live job counts. A facet can be spelled as its flag is (`job-categories` for `job_categories`).
  Occupations are searched by name: every word of the query must appear in the occupation's name. The
  API's own facet search matches occupation ids only, so the names are read from the taxonomy.
- **`jobo usage`:** the key in use and its rate-limit position, from a free call.
- **`jobo mcp [client]`:** print how to connect the hosted Jobo MCP server to an AI client. Print-only.
- **`jobo skill install | path | show`:** the bundled `jobo-job-search` Agent Skill.
- **`jobo completion bash | zsh | fish`:** a tab-completion script for each shell. It completes
  commands, flags, the values of fixed lists, facet names and MCP client ids, and looks up live values
  with the saved key: sources, industries and job categories (cached for ten minutes), skills, and
  companies (completed to their domain) and places as they are typed. In a comma-separated value the
  last item is completed. The lookups use free endpoints only, time out after 4 seconds and are
  silent on any failure. The script calls back into `jobo` for its candidates, so it never goes stale.
- **Forgiving input:** an unknown flag, command, subcommand, facet or fixed value is refused with the
  nearest match ("Did you mean --work-model?"). Filter flags work in the singular or the plural on both
  `search` and `feed` (`--work-model`, `--work-models`); `--limit` and `--max` are interchangeable;
  `--query` is `--q`; fixed values are accepted in any case (`Remote`). `--companies` splits a comma
  list of ids or domains and keeps a company name with a comma whole.
- **Output:** a table in a terminal and JSON when piped; `--json`, `--jsonl`, `--csv`, `--table`,
  `--fields`, and `--output FILE` with `--overwrite` or `--append`. With JSON, `--fields` only selects
  keys and leaves every value as the API returned it; a table or CSV formats values for a cell. A run
  that fails before writing anything leaves no output file behind. Data on stdout; usage lines,
  progress, cursors and errors on stderr.
- **Exit codes** for usage errors, authentication, insufficient credits, rate limits, not found, an
  unreachable API and a feed cursor that must be restarted.
