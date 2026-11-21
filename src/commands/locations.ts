import type { LocationSuggestion } from "@jobo-ai/connector-core";

import { int, type CommandDef, type Ctx } from "../args";
import { UsageError } from "../errors";
import { feedLocation, placeName } from "../filters";
import { emitRecords, openSink, resolveFormat, shellWord } from "../output";
import { note, openSession } from "../session";

/** The API returns at most this many places. */
const MAX_SUGGESTIONS = 10;

async function run(ctx: Ctx): Promise<number> {
  const query = ctx.positionals.join(" ").trim();
  if (query.length < 2) {
    throw new UsageError('Usage: jobo locations <query>, e.g. jobo locations berlin. The query is the start of a place name, at least 2 characters.');
  }
  const limit = int(ctx.values, "limit", { min: 1, max: MAX_SUGGESTIONS });

  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const { data } = await openSession(ctx).client.suggestLocations(query, limit);
    const suggestions: LocationSuggestion[] = data.suggestions ?? [];
    // Each place also carries the value the feed's --locations flag takes for it.
    const rows = suggestions.map((place) => ({ ...place, feed_location: feedLocation(place) }));
    await emitRecords(ctx, sink, format, {
      rows,
      columns: [
        { key: "display_name", header: "place", get: (row) => placeName(row as LocationSuggestion), max: 44 },
        { key: "country_code", header: "cc" },
        { key: "feed_location", header: "feed --locations value", whole: true },
      ],
      csvColumns: [
        { key: "display_name", get: (row) => placeName(row as LocationSuggestion) },
        { key: "city" },
        { key: "region" },
        { key: "country" },
        { key: "country_code" },
        { key: "latitude" },
        { key: "longitude" },
        { key: "feed_location" },
      ],
      empty: "No place starts with that.",
      envelope: (projected) => ({ ...data, suggestions: projected }),
    });

    const top = rows[0];
    if (top) {
      const first = rows.length > 1 ? " (the first match)" : "";
      note(ctx, `search${first}: --location ${shellWord(placeName(top))}`);
      if (top.feed_location) note(ctx, `feed${first}: --locations ${shellWord(top.feed_location)}`);
    }
  } finally {
    sink.close();
  }
  return 0;
}

export const locationsCommand: CommandDef = {
  name: "locations",
  summary: "Find places by name, with the value the feed's --locations takes (free)",
  usage: ["<query> [--limit N]"],
  description:
    "Places whose name starts with the query, with the city, region and country names exactly as the job index stores them. " +
    "Each match comes with the `jobo feed --locations` value for it, ready to paste (country=…,region=…,city=…); the place name itself is what `jobo search --location` takes. " +
    "Free and never billed, unlike `jobo geocode`, which resolves one place to coordinates for $0.001 a lookup. Not available with a sandbox key.",
  options: {
    limit: {
      type: "string",
      aliases: ["max"],
      value: "N",
      description: `Most places to return, 1–${MAX_SUGGESTIONS} (default 5; also --max).`,
    },
  },
  output: true,
  examples: ["jobo locations berlin", "jobo locations san fran --limit 3", "jobo locations texas --json"],
  run,
};
