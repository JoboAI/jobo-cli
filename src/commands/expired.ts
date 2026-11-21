import { flag, int, str, type CommandDef, type Ctx } from "../args";
import { UsageError } from "../errors";
import { parseTime } from "../filters";
import { emitRecords, openSink, resolveFormat } from "../output";
import { formatNumber, note, openSession } from "../session";

const MAX_BATCH_SIZE = 10_000;
const DEFAULT_LIMIT = 1000;

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo expired takes no arguments. Use --since for the start of the window.");
  const all = flag(ctx.values, "all");
  const requested = int(ctx.values, "limit", { min: 1 });
  if (all && requested !== undefined) throw new UsageError("Use --limit N or --all, not both.");
  const limit = all ? Number.POSITIVE_INFINITY : (requested ?? DEFAULT_LIMIT);

  const since = str(ctx.values, "since");
  const expiredSince = since !== undefined ? parseTime(since, "--since", ctx.io.now()) : undefined;

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
  usage: ["[--since WHEN] [--limit N | --all] [--cursor CURSOR]"],
  description:
    "Runs GET /api/jobs/expired: ids of jobs that stopped appearing on the employer's career site, so you can close them in your own store. " +
    "Free; it counts toward the JobFeed rate limit. The window starts 24 hours ago unless --since says otherwise, and reaches back at most 7 days. Not available with a sandbox key.",
  options: {
    since: {
      type: "string",
      value: "WHEN",
      description: "Jobs that expired on or after this time: ISO 8601, or an age such as 24h or 3d. At most 7 days back (default: 24 hours ago).",
    },
    limit: { type: "string", value: "N", description: `Most ids to return (default ${formatNumber(DEFAULT_LIMIT)}). Pages are walked as needed.` },
    all: { type: "boolean", description: "Return every id in the window." },
    cursor: { type: "string", value: "CURSOR", description: "Continue from the `next cursor` of an earlier run." },
  },
  output: true,
  examples: ["jobo expired --since 24h --jsonl", "jobo expired --since 2026-11-18T00:00:00Z --all --csv -o expired.csv"],
  run,
};
