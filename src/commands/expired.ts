import { flag, int, str, type CommandDef, type Ctx } from "../args";
import { UsageError } from "../errors";
import { parseTime } from "../filters";
import { emitRecords, openSink, resolveFormat } from "../output";
import { formatNumber, note, openSession } from "../session";

const MAX_BATCH_SIZE = 10_000;
/** The API answers 400 to an `expired_since` more than 7 days back, or in the future. */
const MAX_WINDOW_DAYS = 7;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 86_400_000;
/**
 * `--since 7d` is 7 days before *our* clock; by the time the API reads it, it
 * is a moment older than its limit. Pull a start at the very edge in by this
 * much, which also leaves room for the pages of a long walk.
 */
const EDGE_MARGIN_MS = 5 * 60_000;

/** The start of the window, checked against the API's limits before anything is sent. */
function windowStart(raw: string, now: Date): string {
  const since = parseTime(raw, "--since", now);
  const at = Date.parse(since);
  const earliest = now.getTime() - MAX_WINDOW_MS;
  if (at < earliest) {
    throw new UsageError(
      `--since ${raw} is more than ${MAX_WINDOW_DAYS} days back, and the API keeps expired ids for ${MAX_WINDOW_DAYS} days ` +
        `(the earliest start now is ${new Date(earliest).toISOString()}). To catch up after a longer gap, sync the feed again and treat ids that no longer appear as expired.`,
    );
  }
  if (at > now.getTime()) throw new UsageError(`--since ${raw} is in the future.`);
  return at < earliest + EDGE_MARGIN_MS ? new Date(earliest + EDGE_MARGIN_MS).toISOString() : since;
}

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo expired takes no arguments. Use --since for the start of the window.");
  // Every id in the window by default: the endpoint is free, and a list cut
  // short leaves closed jobs live in the caller's store while the run looks
  // like a success. --limit is an opt-in cap; --all, the old way to ask for
  // everything, is still accepted.
  const all = flag(ctx.values, "all");
  const requested = int(ctx.values, "limit", { min: 1 });
  if (all && requested !== undefined) throw new UsageError("Use --limit N or --all, not both.");
  const limit = requested ?? Number.POSITIVE_INFINITY;

  const since = str(ctx.values, "since");
  const expiredSince = since !== undefined ? windowStart(since, ctx.io.now()) : undefined;

  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    const ids: string[] = [];
    let cursor = str(ctx.values, "cursor");
    let hasMore = true;
    let nextCursor: string | null = null;

    while (hasMore && ids.length < limit) {
      // connector-core 0.5.0 types this parameter as `limit`, which the API
      // ignores; the endpoint's page-size parameter is `batch_size`.
      const params = {
        ...(expiredSince !== undefined ? { expired_since: expiredSince } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        batch_size: Math.min(MAX_BATCH_SIZE, limit - ids.length),
      };
      const { data } = await session.client.getExpiredJobIds(params as Parameters<typeof session.client.getExpiredJobIds>[0]);
      ids.push(...(data.job_ids ?? []));
      hasMore = Boolean(data.has_more) && Boolean(data.next_cursor);
      nextCursor = hasMore ? data.next_cursor : null;
      if (nextCursor !== null && nextCursor === cursor) break;
      cursor = nextCursor ?? undefined;
    }

    await emitRecords(ctx, sink, format, {
      rows: ids.map((id) => ({ id })),
      columns: [{ key: "id" }],
      empty: "No jobs expired in that window.",
      envelope: () => ({ job_ids: ids, has_more: hasMore, next_cursor: nextCursor }),
    });
    note(ctx, `${formatNumber(ids.length)} expired job id${ids.length === 1 ? "" : "s"}.`);
    if (nextCursor) note(ctx, `more remain. next cursor: ${nextCursor}`);
  } finally {
    sink.close();
  }
  return 0;
}

export const expiredCommand: CommandDef = {
  name: "expired",
  summary: "List ids of jobs that expired recently (free)",
  usage: ["[--since WHEN] [--limit N] [--cursor CURSOR]"],
  description:
    "Runs GET /api/jobs/expired: ids of jobs that stopped appearing on the employer's career site, so you can close them in your own store. " +
    `Free; it counts toward the JobFeed rate limit. The window starts 24 hours ago unless --since says otherwise, and reaches back at most ${MAX_WINDOW_DAYS} days: an earlier --since is refused before anything is sent. ` +
    `Every page is walked, so the list holds every id in the window; --limit N stops early and prints the cursor to continue from. Not available with a sandbox key.`,
  options: {
    since: {
      type: "string",
      value: "WHEN",
      description: `Jobs that expired on or after this time: ISO 8601, or an age such as 24h or 3d. At most ${MAX_WINDOW_DAYS} days back (default: 24 hours ago).`,
    },
    limit: {
      type: "string",
      aliases: ["max"],
      value: "N",
      description: "Stop after N ids (also --max). Default: every id in the window.",
    },
    all: { type: "boolean", description: "Return every id in the window (the default; kept for older scripts)." },
    cursor: { type: "string", value: "CURSOR", description: "Continue from the `next cursor` of an earlier run." },
  },
  output: true,
  examples: ["jobo expired --since 24h --jsonl", "jobo expired --since 2026-11-18T00:00:00Z --csv -o expired.csv"],
  run,
};
