import {
  COMPANY_CATEGORIES,
  DESCRIPTION_FORMATS,
  INCLUDE_FIELDS,
  LANGUAGES,
  SEARCH_SORTS,
  type FilterOptionsFacet,
  type JobFacet,
} from "@jobo-ai/connector-core";

import { int, wrap, type CommandDef, type Ctx } from "../args";
import { UsageError } from "../errors";
import { FILTER_FACETS } from "../filters";
import { emitDocument, emitRecords, openSink, resolveFormat, toTable } from "../output";
import { formatNumber, note, openSession } from "../session";
import { canonical, didYouMean } from "../suggest";
import { flattenOccupations, matchOccupations } from "./occupations";

/** The most values one facet request returns. */
export const MAX_OPTIONS = 250;

/** What a facet lookup returns when --limit is not given: the API's own default. */
const DEFAULT_OPTIONS = 50;

/** Vocabularies the API does not serve live: fixed lists from the shared contract. */
const CONTRACT_VOCABULARIES = {
  company_categories: [...COMPANY_CATEGORIES],
  languages: LANGUAGES.map((language) => ({ code: language.code, name: language.name })),
  sort: [...SEARCH_SORTS],
  description_format: [...DESCRIPTION_FORMATS],
  include_fields: [...INCLUDE_FIELDS],
};

function vocabularyView(document: unknown): string {
  const data = document as {
    enums?: Record<string, string[]>;
    sources?: JobFacet[];
    contract: typeof CONTRACT_VOCABULARIES;
    facets: readonly string[];
  };
  const line = (flag: string, values: readonly string[]) => wrap(`${flag}: ${values.join(", ")}`, 100, "").replace(/\n/g, "\n    ");
  const out: string[] = ["Fixed vocabularies (send these values exactly)", ""];
  out.push(line("--work-model", data.enums?.work_models ?? []));
  out.push(line("--employment-type", data.enums?.employment_types ?? []));
  out.push(line("--experience-level", data.enums?.experience_levels ?? []));
  out.push(line("--company-categories", data.contract.company_categories));
  out.push(line("--sort", data.contract.sort));
  out.push(line("--description-format", data.contract.description_format));
  out.push(line("--include-fields", data.contract.include_fields));
  out.push(line("--language", data.contract.languages.map((language) => language.code)));
  out.push("", "Sources (--sources), with live job counts", "");
  out.push(toTable(data.sources ?? [], [{ key: "key", header: "source" }, { key: "count", header: "jobs" }]).trimEnd());
  out.push("", `Open vocabularies: jobo filters <facet> [query], where facet is one of ${data.facets.join(", ")}.`);
  out.push("Companies: jobo companies <query>.");
  return `${out.join("\n")}\n`;
}

async function run(ctx: Ctx): Promise<number> {
  const [given, ...rest] = ctx.positionals;
  const limit = int(ctx.values, "limit", { min: 1, max: MAX_OPTIONS });
  const format = resolveFormat(ctx.values, ctx.io);

  if (given === undefined) {
    if (limit !== undefined) throw new UsageError("--limit applies to a facet: jobo filters <facet> [query] --limit N.");
    const sink = openSink(ctx, format);
    try {
      const { data } = await openSession(ctx).client.filters();
      const document = { ...data, contract: CONTRACT_VOCABULARIES, facets: FILTER_FACETS };
      if (format === "jsonl" || format === "csv") {
        // Row formats list the one live vocabulary: the sources and their counts.
        await emitRecords(ctx, sink, format, {
          rows: data.sources ?? [],
          columns: [{ key: "key" }, { key: "count" }],
          envelope: () => document,
        });
      } else {
        await emitDocument(ctx, sink, format, document, vocabularyView);
      }
    } finally {
      sink.close();
    }
    return 0;
  }

  // The flag is --job-categories and the facet job_categories: take either spelling, in any case.
  const facet = canonical(given, FILTER_FACETS);
  if (facet === undefined) {
    const elsewhere = /^compan/i.test(given)
      ? " Companies are looked up with `jobo companies <query>`."
      : /^locat/i.test(given)
        ? " Places are looked up with `jobo locations <query>`."
        : didYouMean(given, FILTER_FACETS);
    throw new UsageError(`Unknown facet "${given}".${elsewhere} Facets: ${FILTER_FACETS.join(", ")}.`);
  }
  const query = rest.join(" ").trim();
  if (facet === "occupations" && query !== "") return occupationsByName(ctx, query, limit ?? DEFAULT_OPTIONS);
  const sink = openSink(ctx, format);
  try {
    const { data } = await openSession(ctx).client.filterOptions(facet as FilterOptionsFacet, {
      ...(query !== "" ? { q: query } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const named = (data.options ?? []).some((option) => option.name != null);
    await emitRecords(ctx, sink, format, {
      rows: data.options ?? [],
      columns: [
        { key: "key", header: "value", max: 60 },
        ...(named ? [{ key: "name", max: 40 }, { key: "parent", max: 30 }] : []),
        { key: "count", header: "jobs" },
      ],
      empty: "No values match.",
      envelope: (rows) => ({ ...data, options: rows }),
    });
  } finally {
    sink.close();
  }
  return 0;
}

/**
 * `jobo filters occupations <query>`. The facet endpoint's `q` matches
 * occupation ids, not names, so a name is looked up in the taxonomy. The facet
 * is still read once, for the live job counts of the occupations it lists.
 */
async function occupationsByName(ctx: Ctx, query: string, limit: number): Promise<number> {
  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    const [taxonomy, counted] = await Promise.all([
      session.client.occupations(),
      session.client.filterOptions("occupations", { limit: MAX_OPTIONS }),
    ]);
    const counts = new Map((counted.data.options ?? []).map((option) => [option.key, option.count]));
    const matches = matchOccupations(flattenOccupations(taxonomy.data), query)
      .map((row) => ({ key: row.id, count: counts.get(row.id) ?? null, name: row.name, parent: row.subcategory }))
      // Most live jobs first; an occupation outside the counted list has no figure and sorts after.
      .sort((a, b) => (b.count ?? -1) - (a.count ?? -1) || a.name.localeCompare(b.name));
    const rows = matches.slice(0, limit);
    await emitRecords(ctx, sink, format, {
      rows,
      columns: [
        { key: "key", header: "value", max: 60 },
        { key: "name", max: 40 },
        { key: "parent", max: 30 },
        { key: "count", header: "jobs" },
      ],
      empty: `No occupation name matches "${query}".`,
      envelope: (projected) => ({ facet: "occupations", options: projected }),
    });
    if (matches.length > rows.length) {
      note(ctx, `showing ${formatNumber(rows.length)} of ${formatNumber(matches.length)} matches; raise --limit or add a word.`);
    }
    if (rows.some((row) => row.count === null)) {
      note(ctx, `jobs is blank outside the ${MAX_OPTIONS} occupations with the most live jobs.`);
    }
  } finally {
    sink.close();
  }
  return 0;
}

export const filtersCommand: CommandDef = {
  name: "filters",
  summary: "List valid filter values, with live job counts (free)",
  usage: ["", "<facet> [query] [--limit N]"],
  description:
    "With no argument: the fixed vocabularies (work models, employment types, experience levels, company categories, languages, sort orders) and every ATS source with its live job count. " +
    `With a facet: the values of one open vocabulary with live job counts, optionally narrowed by a query. Facets: ${FILTER_FACETS.join(", ")}. ` +
    "A facet may be written as its flag is (job-categories for job_categories). " +
    "The `value` column is what the matching search flag takes; for occupations that is the occupation id, shown with its name and parent subcategory. " +
    "Never billed. Not available with a sandbox key.",
  options: {
    limit: {
      type: "string",
      aliases: ["max"],
      value: "N",
      description: `Most values to return for a facet, 1–${MAX_OPTIONS} (default 50; also --max).`,
    },
  },
  args: [{ choices: FILTER_FACETS }],
  output: true,
  notFound: "That facet is not available: occupations are not published in this environment.",
  examples: ["jobo filters", "jobo filters skills pyth", "jobo filters occupations nurse --json", "jobo filters sources --limit 250 --csv"],
  run,
};
