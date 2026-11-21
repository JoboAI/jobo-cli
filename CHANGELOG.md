# Changelog

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
  more than N jobs.
- **`jobo job <id>`:** one full listing.
- **`jobo feed`:** `POST /api/jobs/feed` as a cursor-walked JSONL stream. Requires `--max N` or `--all`;
  `--cursor` and `--cursor-file` resume a scan, and the next cursor is printed and saved after every
  batch.
- **`jobo expired`:** ids of recently expired jobs.
- **`jobo company <id>`, `jobo companies <query>`:** a company profile, and a name or domain lookup that
  returns the ids `--companies` takes.
- **`jobo geocode <location>`:** resolve a place name ($0.001 per lookup).
- **`jobo filters`, `jobo filters <facet> [query]`, `jobo occupations`:** valid filter values, with live
  job counts.
- **`jobo usage`:** the key in use and its rate-limit position, from a free call.
- **`jobo mcp [client]`:** print how to connect the hosted Jobo MCP server to an AI client. Print-only.
- **`jobo skill install | path | show`:** the bundled `jobo-job-search` Agent Skill.
- **Output:** a table in a terminal and JSON when piped; `--json`, `--jsonl`, `--csv`, `--table`,
  `--fields`, and `--output FILE` with `--overwrite` or `--append`. Data on stdout; usage lines,
  progress, cursors and errors on stderr.
- **Exit codes** for usage errors, authentication, insufficient credits, rate limits, not found, an
  unreachable API and a feed cursor that must be restarted.
