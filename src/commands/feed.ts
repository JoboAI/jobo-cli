import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { JOB_FEED_FILTER_KEYS, type Job, type JobFeedParams } from "@jobo-ai/connector-core";

import { flag, int, str, type CommandDef, type Ctx } from "../args";
import { EXIT, URLS, UsageError, describeError } from "../errors";
import { feedFilterOptions, flagName, parseFeedFilters } from "../filters";
import { JOB_CSV_COLUMNS, JOB_TABLE_COLUMNS } from "../jobs";
import { emitRecords, openSink, resolveFormat } from "../output";
import { FEED_TIMEOUT_MS, formatNumber, note, openSession, quickClient, usageLine } from "../session";

const MAX_BATCH_SIZE = 1000;
/** 3 credits a job: $3.00 per 1,000. */
const CREDITS_PER_JOB = 3;
const SIZE_LOOKUP_TIMEOUT_MS = 5000;

/** Body keys that shape the output or the scan without narrowing it: alone, they still mean every job. */
const NOT_NARROWING: ReadonlySet<string> = new Set(["description_format", "include_reactivated", "stable_scan"]);

/** `--body`: inline JSON, or `@file` to read it from a file. */
function readBody(ctx: Ctx): Record<string, unknown> {
  const raw = str(ctx.values, "body");
  if (raw === undefined) return {};
  let text = raw;
  if (raw.startsWith("@")) {
    const path = resolve(ctx.io.cwd, raw.slice(1));
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason =
        code === "ENOENT" ? "there is no such file" : code === "EISDIR" ? "it is a directory" : (error as Error).message;
      throw new UsageError(`--body ${raw}: cannot read ${path}: ${reason}.`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError("--body must be a JSON object, or @file naming a file that holds one.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError("--body must be a JSON object.");
  }
  const body = { ...(parsed as Record<string, unknown>) };
  // Paging belongs to the flags: a cursor or batch size hidden in a body would dodge the cap.
  for (const key of ["cursor", "batch_size"]) {
    if (key in body) throw new UsageError(`--body must not set ${key}; use --${flagName(key)} instead.`);
  }
  return body;
}

/** Write-then-rename, so a crash mid-write cannot leave half a cursor behind. */
function saveCursor(path: string, cursor: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${cursor}\n`);
  renameSync(temp, path);
}

/**
 * Move a cursor file the API will never continue to `<file>.dead`, replacing
 * an older one. Left in place, it would fail a scheduled run the same way
 * every time; moved aside, the same command starts a new scan, and the dead
 * cursor is still there to look at.
 */
function setCursorAside(path: string): string {
  const dead = `${path}.dead`;
  rmSync(dead, { force: true });
  renameSync(path, dead);
  return dead;
}

/**
 * How many live jobs the index holds, from the free filter vocabulary (the
 * job count of every source). Null when it cannot be had: the refusal that
 * quotes it must not depend on it.
 */
async function indexSize(ctx: Ctx): Promise<number | null> {
  try {
    const client = quickClient(ctx.io, {
      timeoutMs: SIZE_LOOKUP_TIMEOUT_MS,
      apiKey: str(ctx.values, "api-key"),
      apiUrl: str(ctx.values, "api-url"),
    });
    if (!client) return null;
    const { data } = await client.filters();
    const total = (data.sources ?? []).reduce(
      (sum, source) => sum + (typeof source.count === "number" ? source.count : 0),
      0,
    );
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** `--all` with nothing to narrow it is the whole index: say what that is, and stop unless it was confirmed. */
async function refuseWholeIndex(ctx: Ctx): Promise<never> {
  const size = await indexSize(ctx);
  const scale =
    size !== null
      ? `about ${formatNumber(size)} jobs, up to ${formatNumber(size * CREDITS_PER_JOB)} credits (about $${formatNumber(Math.round((size * CREDITS_PER_JOB) / 1000))}) if every one is new to you`
      : "every live job, at $3.00 per 1,000 that are new to you (the index size could not be fetched)";
  throw new UsageError(
    `jobo feed --all with no filter streams the whole index: ${scale}. ` +
      "Add a filter, cap the run with --max N, or pass --yes to sync everything.",
  );
}

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) {
    throw new UsageError(`jobo feed takes no arguments (got "${ctx.positionals[0]}"). The feed has no text query: use the filter flags.`);
  }
  const max = int(ctx.values, "max", { min: 1 });
  const all = flag(ctx.values, "all");
  if (max === undefined && !all) {
    throw new UsageError(
      "jobo feed bills every job that is new to you, so it never runs unbounded by default. Pass --max N to stop after N jobs, or --all to stream everything that matches.",
    );
  }
  if (max !== undefined && all) throw new UsageError("Use --max N or --all, not both.");

  const requestedBatch = int(ctx.values, "batch-size", { min: 1, max: MAX_BATCH_SIZE });
  const filters: JobFeedParams = { ...readBody(ctx), ...parseFeedFilters(ctx.values, ctx.io.now()) };

  const cursorFile = str(ctx.values, "cursor-file");
  const cursorPath = cursorFile ? resolve(ctx.io.cwd, cursorFile) : null;
  let cursor = str(ctx.values, "cursor");
  if (cursor === undefined && cursorPath && existsSync(cursorPath)) {
    cursor = readFileSync(cursorPath, "utf8").trim() || undefined;
    if (cursor) note(ctx, `resuming from the cursor in ${cursorPath}`);
  }
  if (cursor && Object.keys(filters).length > 0) {
    note(ctx, "note: a cursor keeps the filters of the scan it came from; the filters on this command line are ignored.");
  }
  // A cursor carries its scan's filters, so only a fresh scan can be the whole index.
  const narrowed = Object.keys(filters).some((key) => !NOT_NARROWING.has(key));
  if (all && !cursor && !narrowed && !flag(ctx.values, "yes")) await refuseWholeIndex(ctx);

  // The feed is a stream: JSONL unless a format is asked for, even in a terminal.
  const format = resolveFormat(ctx.values, ctx.io, { tty: "jsonl", piped: "jsonl" });
  const streaming = format === "jsonl" || format === "csv";
  const sink = openSink(ctx, format);
  const session = openSession(ctx, { timeoutMs: FEED_TIMEOUT_MS });

  const buffered: Job[] = [];
  let delivered = 0;
  let batches = 0;
  let nextCursor: string | null = cursor ?? null;
  let hasMore = true;
  let headerWritten = sink.continuing;
  // Set once the buffered jobs have been handed to emitRecords: a failure after
  // that must not write them a second time.
  let flushed = false;

  // The cursor file only ever moves past jobs that are already written. In a
  // row format that is after every batch; in a JSON document or a table, where
  // nothing is written until the end, it is after that one write (or after the
  // partial write that an error leaves). A cursor saved ahead of its jobs would
  // make a resume skip them, and they were already billed.
  const persistCursor = (next: string | null) => {
    if (!cursorPath) return;
    if (next) saveCursor(cursorPath, next);
    else rmSync(cursorPath, { force: true });
  };
  const emitBuffered = (partial: boolean) =>
    emitRecords(ctx, sink, format, {
      rows: buffered,
      columns: JOB_TABLE_COLUMNS,
      csvColumns: JOB_CSV_COLUMNS,
      empty: "No jobs matched.",
      envelope: (rows) => ({ jobs: rows, next_cursor: nextCursor, has_more: hasMore, ...(partial ? { partial: true } : {}) }),
    });

  try {
    while (hasMore) {
      const remaining = max !== undefined ? max - delivered : Number.POSITIVE_INFINITY;
      if (remaining <= 0) break;

      // A page never holds more than the cap has left. The cursor keeps the
      // scan's batch size; a continuation may lower it, never raise it.
      const size = Math.min(requestedBatch ?? MAX_BATCH_SIZE, remaining);
      const request: JobFeedParams = cursor
        ? { cursor, ...(requestedBatch !== undefined || size < MAX_BATCH_SIZE ? { batch_size: size } : {}) }
        : { ...filters, batch_size: size };

      const { data } = await session.client.feed(request);
      batches++;
      const jobs = data.jobs ?? [];

      // Jobs first, cursor second: a crash between the two re-delivers a page
      // (free, it was already received) instead of losing one.
      if (streaming) {
        await emitRecords(ctx, { ...sink, continuing: headerWritten }, format, {
          rows: jobs,
          columns: JOB_TABLE_COLUMNS,
          csvColumns: JOB_CSV_COLUMNS,
          envelope: (rows) => rows,
        });
        headerWritten = true;
      } else {
        buffered.push(...jobs);
      }
      delivered += jobs.length;

      const previous = cursor;
      hasMore = Boolean(data.has_more) && Boolean(data.next_cursor);
      nextCursor = hasMore ? data.next_cursor : null;
      if (streaming) persistCursor(nextCursor);

      if (batches === 1 && typeof data.estimated_total === "number") {
        note(ctx, `about ${formatNumber(data.estimated_total)} jobs match this feed`);
      }
      // The first page explains its warnings in the body; a continuation only
      // names them in a header (batch_size_capped, for one).
      const warnings = (data as { warnings?: Array<{ message?: string }> | null }).warnings ?? [];
      for (const warning of warnings) if (warning.message) note(ctx, `warning: ${warning.message}`);
      if (warnings.length === 0 && session.headers()["x-jobo-warnings"]) {
        note(ctx, `warning: ${session.headers()["x-jobo-warnings"]}`);
      }
      const usage = usageLine(session.usage(), session.headers());
      note(
        ctx,
        `batch ${batches}: ${formatNumber(jobs.length)} jobs${usage ? ` · ${usage}` : ""} · ${formatNumber(delivered)} delivered${max !== undefined ? ` of ${formatNumber(max)}` : ""}`,
      );
      if (session.headers()["x-billing-status"]?.toLowerCase() === "unconfirmed") {
        note(ctx, "warning: this batch was delivered but wallet settlement could not be confirmed; do not replay it automatically.");
      }
      if (nextCursor) note(ctx, `next cursor: ${nextCursor}`);

      if (nextCursor && nextCursor === previous) {
        note(ctx, "warning: the API returned the same cursor again; stopping instead of looping on it.");
        break;
      }
      cursor = nextCursor ?? undefined;
    }

    if (!streaming) {
      flushed = true;
      await emitBuffered(false);
      persistCursor(nextCursor);
    }

    if (!hasMore) {
      note(ctx, `feed complete: ${formatNumber(delivered)} jobs in ${batches} batch${batches === 1 ? "" : "es"}.${cursorPath ? ` Removed ${cursorPath}.` : ""}`);
    } else {
      note(
        ctx,
        `stopped at --max ${formatNumber(max ?? delivered)} with more to come. Resume with ${cursorPath ? `the same --cursor-file ${cursorFile}` : `--cursor ${nextCursor}`}.`,
      );
    }
  } catch (error) {
    // The batches before the failure are billed. In a buffered format they are
    // still in memory: write them, marked partial, and only then move the
    // cursor file past them. If that write fails too, the cursor stays where it
    // was, so a resume delivers those jobs again instead of skipping them.
    let written = streaming;
    if (!streaming && !flushed && batches > 0) {
      try {
        await emitBuffered(true);
        persistCursor(nextCursor);
        written = true;
      } catch {
        // The original error is the one to report.
      }
    }
    if (written && batches > 0 && nextCursor) {
      const where = sink.path ? ` and written to ${sink.path}` : "";
      note(ctx, `${formatNumber(delivered)} jobs were delivered${where} before the error. Resume with ${cursorPath ? `--cursor-file ${cursorFile}` : `--cursor ${nextCursor}`}.`);
    }
    // A dead cursor fails the same way on every run. If it is the one in the
    // cursor file, move the file aside so the same command starts a new scan.
    if (cursorPath && cursor && describeError(error).exitCode === EXIT.CURSOR && existsSync(cursorPath)) {
      if (readFileSync(cursorPath, "utf8").trim() === cursor) {
        const dead = setCursorAside(cursorPath);
        note(
          ctx,
          `The API will not continue the cursor in ${cursorPath}: moved it to ${dead}. The scan must start again; the next run of this command starts it from the beginning.`,
        );
      }
    }
    throw error;
  } finally {
    sink.close();
  }
  return 0;
}

export const feedCommand: CommandDef = {
  name: "feed",
  summary: "Stream the job feed as JSONL (billed per new job; needs --max or --all)",
  usage: ["(--max N | --all) [filters] [--batch-size N] [--cursor CURSOR] [--cursor-file FILE]"],
  description:
    "Runs POST /api/jobs/feed and walks its cursor, oldest job first, writing one JSON job per line. " +
    "A job is billed when you have not received it through Feed, Export or Outbound in the last 30 days: included jobs first, then the wallet at $3.00 per 1,000 new jobs. Jobs you already hold are delivered again at no charge. " +
    "Because the first sync of a broad feed bills every job in it, an explicit --max N or --all is required. --max is exact: the last batch is shrunk to fit. " +
    "--all with no filter, --body or cursor would sync the whole index: it is refused, with the job count and the most it could cost, unless you add --yes.\n\n" +
    "The next cursor is printed on stderr after every batch and, with --cursor-file, saved to that file once the batch's jobs are written, so a crashed run resumes where it stopped: run the same command again. " +
    "With --json or --table the jobs are written once, at the end, and the file is saved after that; a run that fails part-way writes the jobs it has, marked partial, before saving it. " +
    "A resumed scan can deliver a page again, so load the jobs by id. " +
    "The file is removed when the scan completes. If the API will not continue its cursor (exit 8), it is moved to FILE.dead and the next run starts a new scan. " +
    "Cursors do not expire. A cursor keeps the filters and batch size it was created with; filters given alongside one are ignored. " +
    "The wallet must cover a full batch before each request runs (3,000 credits for a batch of 1,000 with no plan), so use a smaller --batch-size on a low balance.\n\n" +
    "The feed's filters are its own: plural, structured, and with no text query. A flag in the singular works too (--work-model for --work-models), and a fixed value in any case. " +
    `Not available with a sandbox key. Build a filter set interactively at ${URLS.feedBuilder} and pass it with --body.`,
  options: {
    ...feedFilterOptions(),
    max: {
      type: "string",
      aliases: ["limit"],
      value: "N",
      description: "Stop after N jobs (also --limit). Never delivers more.",
      group: "Paging",
    },
    all: { type: "boolean", description: "Stream every matching job, with no cap.", group: "Paging" },
    yes: {
      type: "boolean",
      description: "Confirm --all with no filter, --body or cursor: sync the whole index.",
      group: "Paging",
    },
    "batch-size": {
      type: "string",
      value: "N",
      description: `Jobs per request, 1–${MAX_BATCH_SIZE} (default ${MAX_BATCH_SIZE}). A resumed scan can lower its batch size but not raise it.`,
      group: "Paging",
    },
    cursor: { type: "string", value: "CURSOR", description: "Resume from this cursor (a `next cursor` line of an earlier run).", group: "Paging" },
    "cursor-file": {
      type: "string",
      value: "FILE",
      description: "Resume from the cursor in FILE if it exists, and save the next cursor to it after every batch.",
      complete: { kind: "file" },
      group: "Paging",
    },
    body: {
      type: "string",
      value: "JSON|@FILE",
      description:
        `A raw feed request body as JSON, or @FILE to read one from a file: --body '{"job_subcategories":{"include":["Nursing"]}}' or --body @feed.json. ` +
        `Filter flags are merged over it. Body keys: ${JOB_FEED_FILTER_KEYS.join(", ")}.`,
      group: "Filters",
    },
  },
  output: true,
  sizeFlag: "--batch-size",
  examples: [
    "jobo feed --max 500 --sources greenhouse,lever --work-models remote > jobs.jsonl",
    'jobo feed --all --locations "country=United States" --job-subcategories Nursing --company-is-agency false --cursor-file nursing.cursor --output nursing.jsonl --append',
    "jobo feed --max 1000 --updated-after 24h --exclude-employment-types internship --csv -o new-jobs.csv",
    'jobo feed --max 500 --industries "Software Development" --company-primary-industries Finance --company-sizes 201-500,501-1000',
    "jobo feed --max 200 --body @feed.json --cursor-file feed.cursor -o jobs.jsonl --append",
  ],
  run,
};
