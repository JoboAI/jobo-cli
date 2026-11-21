import type { CommandDef, Ctx } from "../args";
import { UsageError } from "../errors";
import { jobView } from "../jobs";
import { emitDocument, openSink, resolveFormat } from "../output";
import { openSession } from "../session";

async function run(ctx: Ctx): Promise<number> {
  const id = ctx.positionals[0]?.trim();
  if (!id || ctx.positionals.length > 1) throw new UsageError("Usage: jobo job <id>. The id is the `id` of a job from search or the feed.");

  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    const { data } = await session.client.getJob(id);
    await emitDocument(ctx, sink, format, data, jobView);
  } finally {
    sink.close();
  }
  return 0;
}

export const jobCommand: CommandDef = {
  name: "job",
  summary: "Fetch one job listing by id (free)",
  usage: ["<id>"],
  description:
    "Runs GET /api/jobs/{id}: the full listing, description included. Never billed; it counts toward the JobSearch rate limit.",
  output: true,
  notFound:
    "No job has that id. Ids come from `jobo search` or `jobo feed`; a live id is unknown to a sandbox key and the other way round.",
  examples: ["jobo job a1b2c3d4-e5f6-7890-abcd-ef1234567890", "jobo job a1b2c3d4-e5f6-7890-abcd-ef1234567890 --fields title,apply_url --json"],
  run,
};
