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
import { openSession } from "../session";

const MAX_OPTIONS = 250;

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
  const [facet, ...rest] = ctx.positionals;
  const limit = int(ctx.values, "limit", { min: 1, max: MAX_OPTIONS });
  const format = resolveFormat(ctx.values, ctx.io);

  if (facet === undefined) {
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

  if (!(FILTER_FACETS as readonly string[]).includes(facet)) {
    throw new UsageError(`Unknown facet "${facet}". Facets: ${FILTER_FACETS.join(", ")}. For companies use \`jobo companies <query>\`.`);
  }
  const query = rest.join(" ").trim();
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

export const filtersCommand: CommandDef = {
  name: "filters",
  summary: "List valid filter values, with live job counts (free)",
  usage: ["", "<facet> [query] [--limit N]"],
  description:
    "With no argument: the fixed vocabularies (work models, employment types, experience levels, company categories, languages, sort orders) and every ATS source with its live job count. " +
    `With a facet: the values of one open vocabulary with live job counts, optionally narrowed by a query. Facets: ${FILTER_FACETS.join(", ")}. ` +
    "The `value` column is what the matching search flag takes; for occupations that is the occupation id, shown with its name and parent subcategory. " +
    "Never billed. Not available with a sandbox key.",
  options: {
    limit: { type: "string", value: "N", description: `Most values to return for a facet, 1–${MAX_OPTIONS} (default 50).` },
  },
  output: true,
  notFound: "That facet is not available: occupations are not published in this environment.",
  examples: ["jobo filters", "jobo filters skills pyth", "jobo filters occupations nurse --json", "jobo filters sources --limit 250 --csv"],
  run,
};
