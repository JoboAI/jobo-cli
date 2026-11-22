import type { OccupationTaxonomyResponse } from "@jobo-ai/connector-core";

import type { CommandDef, Ctx } from "../args";
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

/**
 * The occupations whose name holds every word of `query`, or whose id starts
 * with it. The API's own facet search matches occupation ids only, so a search
 * by name has to read the taxonomy.
 */
export function matchOccupations(rows: readonly OccupationRow[], query: string): OccupationRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  const words = needle.split(/\s+/);
  return rows.filter((row) => {
    const name = row.name.toLowerCase();
    return row.id.toLowerCase().startsWith(needle) || words.every((word) => name.includes(word));
  });
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
  const query = ctx.positionals.join(" ").trim();
  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const { data } = await openSession(ctx).client.occupations();
    const all = flattenOccupations(data);
    const rows = matchOccupations(all, query);
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
      empty: query === "" ? "The taxonomy is empty." : `No occupation name matches "${query}".`,
      // --json keeps the API's nested shape unless a query or --fields asked for flat rows.
      envelope: (projected) => (query === "" && projected === rows ? data : { version: data.version, occupations: projected }),
    });
    note(
      ctx,
      query === ""
        ? `${formatNumber(rows.length)} occupations in ${formatNumber((data.categories ?? []).length)} categories (version ${data.version}).`
        : `${formatNumber(rows.length)} of ${formatNumber(all.length)} occupations match "${query}" (version ${data.version}).`,
    );
  } finally {
    sink.close();
  }
  return 0;
}

export const occupationsCommand: CommandDef = {
  name: "occupations",
  summary: "Print the occupation taxonomy, or find occupations by name (free)",
  usage: ["", "<query>"],
  description:
    "Runs GET /api/occupations: categories, subcategories and occupations in one response. A category name goes in --job-categories, a subcategory name in --job-subcategories and an occupation id in --occupation-ids. " +
    "Filter on occupation ids, not names: names can change between releases. Free; not available with a sandbox key. " +
    "It is a large list, so pass a query to find one role: every word must appear in the occupation's name. `jobo filters occupations <query>` runs the same search and adds live job counts.",
  output: true,
  notFound: "Occupations are not published in this environment.",
  examples: ["jobo occupations nurse", "jobo occupations registered nurse --json", "jobo occupations --csv -o occupations.csv"],
  run,
};
