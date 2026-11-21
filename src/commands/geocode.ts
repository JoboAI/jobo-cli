import type { CommandDef, Ctx } from "../args";
import { EXIT, UsageError } from "../errors";
import { emitDocument, openSink, resolveFormat, toJson } from "../output";
import { note, openSession, reportUsage } from "../session";

async function run(ctx: Ctx): Promise<number> {
  const location = ctx.positionals.join(" ").trim();
  if (location === "") throw new UsageError('Usage: jobo geocode <location>, e.g. jobo geocode "San Francisco, CA".');

  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    const { data } = await session.client.geocode(location);
    reportUsage(ctx, session);
    // No key/value view: the result nests a list of places, which reads best as JSON.
    await emitDocument(ctx, sink, format, data, toJson);
    if (data.succeeded === false) {
      const reason = typeof data.error === "string" ? `: ${data.error}` : "";
      note(ctx, `not resolved${reason} (the lookup is still charged).`);
      return EXIT.ERROR;
    }
  } finally {
    sink.close();
  }
  return 0;
}

export const geocodeCommand: CommandDef = {
  name: "geocode",
  summary: "Resolve a place name to coordinates ($0.001 per lookup)",
  usage: ["<location>"],
  description:
    "Runs GET /api/locations/geocode: coordinates and normalized city, region and country names for a free-text place. " +
    "Each lookup costs $0.001 (1 credit) from the wallet, resolved or not; included jobs and the Unlimited plan do not cover it. " +
    "A place that cannot be resolved still answers with succeeded: false; this command then exits 1. Not available with a sandbox key.",
  output: true,
  examples: ['jobo geocode "San Francisco, CA"', "jobo geocode Berlin --json"],
  run,
};
