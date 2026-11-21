import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { JOB_FEED_FILTER_KEYS, type Job, type JobFeedParams } from "@jobo-ai/connector-core";

import { flag, int, str, type CommandDef, type Ctx } from "../args";
import { URLS, UsageError } from "../errors";
import { feedFilterOptions, flagName, parseFeedFilters } from "../filters";
import { JOB_CSV_COLUMNS, JOB_TABLE_COLUMNS } from "../jobs";
import { emitRecords, openSink, resolveFormat } from "../output";
import { FEED_TIMEOUT_MS, formatNumber, note, openSession, usageLine } from "../session";

const MAX_BATCH_SIZE = 1000;

/** `--body`: inline JSON, or `@file` to read it from a file. */
function readBody(ctx: Ctx): Record<string, unknown> {
  const raw = str(ctx.values, "body");
  if (raw === undefined) return {};
  const text = raw.startsWith("@") ? readFileSync(resolve(ctx.io.cwd, raw.slice(1)), "utf8") : raw;
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
      if (cursorPath) {
        if (nextCursor) saveCursor(cursorPath, nextCursor);
        else rmSync(cursorPath, { force: true });
      }

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
      await emitRecords(ctx, sink, format, {
        rows: buffered,
        columns: JOB_TABLE_COLUMNS,
        csvColumns: JOB_CSV_COLUMNS,
        empty: "No jobs matched.",
        envelope: (rows) => ({ jobs: rows, next_cursor: nextCursor, has_more: hasMore }),
      });
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
    if (batches > 0 && nextCursor) {
      note(ctx, `${formatNumber(delivered)} jobs were delivered before the error. Resume with ${cursorPath ? `--cursor-file ${cursorFile}` : `--cursor ${nextCursor}`}.`);
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
    "Because the first sync of a broad feed bills every job in it, an explicit --max N or --all is required. --max is exact: the last batch is shrunk to fit.\n\n" +
    "The next cursor is printed on stderr after every batch and, with --cursor-file, saved to that file once the batch's jobs are written, so a crashed run resumes where it stopped: run the same command again. " +
    "The file is removed when the scan completes. Cursors do not expire. A cursor keeps the filters and batch size it was created with; filters given alongside one are ignored. " +
    "The wallet must cover a full batch before each request runs (3,000 credits for a batch of 1,000 with no plan), so use a smaller --batch-size on a low balance.\n\n" +
    `Not available with a sandbox key. Build a filter set interactively at ${URLS.feedBuilder} and pass it with --body.`,
  options: {
    ...feedFilterOptions(),
    max: { type: "string", value: "N", description: "Stop after N jobs. Never delivers more.", group: "Paging" },
    all: { type: "boolean", description: "Stream every matching job, with no cap.", group: "Paging" },
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
      group: "Paging",
    },
    body: {
      type: "string",
      value: "JSON|@FILE",
      description: `A raw feed request body as JSON, or @file to read one. Filter flags are merged over it. Body keys: ${JOB_FEED_FILTER_KEYS.join(", ")}.`,
      group: "Filters",
    },
  },
  output: true,
  sizeFlag: "--batch-size",
  examples: [
    "jobo feed --max 500 --sources greenhouse,lever --work-models remote > jobs.jsonl",
    'jobo feed --all --locations "country=United States" --job-subcategories Nursing --company-is-agency false --cursor-file nursing.cursor --output nursing.jsonl --append',
    "jobo feed --max 1000 --updated-after 24h --exclude-employment-types internship --csv -o new-jobs.csv",
  ],
  run,
};
