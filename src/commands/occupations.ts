import type { OccupationTaxonomyResponse } from "@jobo-ai/connector-core";

import type { CommandDef, Ctx } from "../args";
import { UsageError } from "../errors";
import { emitRecords, openSink, resolveFormat } from "../output";
import { formatNumber, note, openSession } from "../session";

interface OccupationRow {
  category: string;
  subcategory: string;
  id: string;
  name: string;
  isco_code: string | null;
  onet_soc_codes: string[];
}

export function flattenOccupations(taxonomy: OccupationTaxonomyResponse): OccupationRow[] {
  const rows: OccupationRow[] = [];
  for (const category of taxonomy.categories ?? []) {
    for (const subcategory of category.subcategories ?? []) {
      for (const occupation of subcategory.occupations ?? []) {
        rows.push({
          category: category.name,
          subcategory: subcategory.name,
          id: occupation.id,
          name: occupation.name,
          isco_code: occupation.isco_code ?? null,
          onet_soc_codes: occupation.onet_soc_codes ?? [],
        });
      }
    }
  }
  return rows;
}

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) {
    throw new UsageError("jobo occupations takes no arguments. To search occupations by name use `jobo filters occupations <query>`.");
  }
  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const { data } = await openSession(ctx).client.occupations();
    const rows = flattenOccupations(data);
    await emitRecords(ctx, sink, format, {
      rows,
      columns: [
        { key: "category", max: 28 },
        { key: "subcategory", max: 30 },
        { key: "name", max: 40 },
        { key: "id", max: 48 },
      ],
      csvColumns: [
        { key: "category" },
        { key: "subcategory" },
        { key: "id" },
        { key: "name" },
        { key: "isco_code" },
        { key: "onet_soc_codes" },
      ],
      empty: "The taxonomy is empty.",
      // --json keeps the API's nested shape unless --fields asked for flat rows.
      envelope: (projected) => (projected === rows ? data : { version: data.version, occupations: projected }),
    });
    note(ctx, `${formatNumber(rows.length)} occupations in ${formatNumber((data.categories ?? []).length)} categories (version ${data.version}).`);
  } finally {
    sink.close();
  }
  return 0;
}

export const occupationsCommand: CommandDef = {
  name: "occupations",
  summary: "Print the occupation taxonomy (free)",
  usage: [""],
  description:
    "Runs GET /api/occupations: categories, subcategories and occupations in one response. A category name goes in --job-categories, a subcategory name in --job-subcategories and an occupation id in --occupation-ids. " +
    "Filter on occupation ids, not names: names can change between releases. Free; not available with a sandbox key. " +
    "It is a large list, so to find one role prefer `jobo filters occupations <query>`.",
  output: true,
  notFound: "Occupations are not published in this environment.",
  examples: ["jobo occupations --csv -o occupations.csv", "jobo occupations --jsonl | grep -i nurse"],
  run,
};
