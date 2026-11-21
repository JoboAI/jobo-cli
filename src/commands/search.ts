import {
  INCLUDE_FIELDS,
  toJobSearchBody,
  type Job,
  type JobSearchResponse,
  type SearchWarning,
} from "@jobo-ai/connector-core";

import { int, list, type CommandDef, type Ctx } from "../args";
import { UsageError } from "../errors";
import { LIST_HINT, parseSearchFilters, searchFilterOptions, unmatchedValueHint } from "../filters";
import { JOB_CSV_COLUMNS, JOB_TABLE_COLUMNS } from "../jobs";
import { emitRecords, openSink, resolveFormat } from "../output";
import { formatNumber, note, openSession, reportUsage } from "../session";

/** Smaller than the API's default of 25: every job on the page is billed. */
export const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
/** Search stops at this depth (page × page_size); the feed is the tool beyond it. */
const MAX_DEPTH = 100_000;
/** `--include-fields none`: the core fields only. */
const NO_FIELDS = "none";

function csvList(ctx: Ctx, name: string): string[] | undefined {
  const raw = list(ctx.values, name);
  if (!raw) return undefined;
  const values = raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length === 1 && values[0]?.toLowerCase() === NO_FIELDS ? [] : values;
}

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 1) {
    throw new UsageError("jobo search takes one query. Quote it if it has spaces: jobo search \"data engineer\".");
  }
  const filters = parseSearchFilters(ctx.values, ctx.io.now());
  const positional = ctx.positionals[0]?.trim();
  if (positional) {
    if (filters.q !== undefined) throw new UsageError("Give the query once: as an argument or with --q, not both.");
    filters.q = positional;
  }

  const requestedSize = int(ctx.values, "page-size", { min: 1, max: MAX_PAGE_SIZE });
  const firstPage = int(ctx.values, "page", { min: 1 }) ?? 1;
  const max = int(ctx.values, "max", { min: 1 });

  const includeFields = csvList(ctx, "include-fields");
  if (includeFields?.includes(NO_FIELDS)) {
    throw new UsageError(`--include-fields: "${NO_FIELDS}" stands alone; it cannot be combined with field names.`);
  }
  const includeFacets = csvList(ctx, "facets");

  // --max is a hard cap on jobs billed. Search pages by number, so every page
  // has to be the same size: only whole pages are fetched, and a remainder is
  // left unfetched rather than billed and thrown away.
  const pageSize = max !== undefined ? Math.min(requestedSize ?? MAX_PAGE_SIZE, max) : (requestedSize ?? DEFAULT_PAGE_SIZE);
  const pageCount = max !== undefined ? Math.floor(max / pageSize) : 1;
  const lastPage = firstPage + pageCount - 1;
  if (lastPage * pageSize > MAX_DEPTH) {
    throw new UsageError(
      `Search stops at a depth of ${formatNumber(MAX_DEPTH)} results (page × page size). Use \`jobo feed\` for anything deeper.`,
    );
  }

  const format = resolveFormat(ctx.values, ctx.io);
  // Row formats go out page by page, so a walk that dies holds nothing back; a
  // JSON document or a table is written once, with whatever was fetched.
  const streaming = format === "jsonl" || format === "csv";
  const sink = openSink(ctx, format);
  const session = openSession(ctx);

  if (pageCount > 1 && (filters.sort ?? "relevance") === "relevance") {
    note(
      ctx,
      "note: the default order can shift between pages, so a job may repeat (and is billed again). For a stable walk use --sort discovered_asc with --discovered-after and --discovered-before.",
    );
  }

  const buffered: Job[] = [];
  const seen = new Set<string>();
  const warnings = new Map<string, SearchWarning>();
  let first: JobSearchResponse | null = null;
  let pagesFetched = 0;
  let repeats = 0;
  let headerWritten = sink.continuing;

  const emit = (rows: readonly Job[], extra: Record<string, unknown> = {}) =>
    emitRecords(ctx, { ...sink, continuing: headerWritten }, format, {
      rows,
      columns: JOB_TABLE_COLUMNS,
      csvColumns: JOB_CSV_COLUMNS,
      empty: "No jobs matched.",
      envelope: (projected) => ({
        ...(first as JobSearchResponse),
        jobs: projected,
        ...(pagesFetched > 1 ? { pages_fetched: pagesFetched } : {}),
        ...extra,
      }),
    });

  try {
    try {
      for (let page = firstPage; page <= lastPage; page++) {
        const body = toJobSearchBody(filters, {
          page,
          page_size: pageSize,
          ...(includeFields ? { include_fields: includeFields } : {}),
          ...(includeFacets ? { include_facets: includeFacets } : {}),
        });
        const { data } = await session.client.searchJobsAdvanced(body);
        pagesFetched++;
        first ??= data;
        reportUsage(ctx, session, pageCount > 1 ? `page ${page}` : "usage");

        for (const warning of data.warnings ?? []) warnings.set(`${warning.code}:${warning.message}`, warning);
        const fresh: Job[] = [];
        for (const job of data.jobs ?? []) {
          if (seen.has(job.id)) {
            repeats++;
            continue;
          }
          seen.add(job.id);
          fresh.push(job);
        }
        if (streaming) {
          await emit(fresh);
          headerWritten = true;
        } else {
          buffered.push(...fresh);
        }
        if ((data.jobs ?? []).length < pageSize || page >= (data.total_pages ?? page)) break;
      }
    } catch (error) {
      // The pages before the failure are billed. Hand them over, then fail as usual.
      if (pagesFetched > 0) {
        if (!streaming) await emit(buffered, { partial: true });
        const nextPage = firstPage + pagesFetched;
        const pagesLeft = lastPage - nextPage + 1;
        const where = sink.path ? `written to ${sink.path}` : "printed";
        note(
          ctx,
          `${formatNumber(seen.size)} job${seen.size === 1 ? "" : "s"} from page${pagesFetched > 1 ? `s ${firstPage}–${nextPage - 1}` : ` ${firstPage}`} were fetched and billed before the error, and are ${where}. ` +
            `Resume with the same filters and --page ${nextPage} --page-size ${pageSize}${pagesLeft > 1 ? ` --max ${pagesLeft * pageSize}` : ""}${sink.path && streaming ? " --append" : ""}.`,
        );
      }
      throw error;
    }

    for (const warning of warnings.values()) note(ctx, `warning: ${warning.message}`);
    if (repeats > 0) note(ctx, `note: ${repeats} job${repeats === 1 ? "" : "s"} repeated across pages and left out.`);

    const response = first as JobSearchResponse;
    if (!streaming) await emit(buffered);

    const total = response.total ?? seen.size;
    const shown = `${formatNumber(seen.size)} of ${formatNumber(total)} matching job${total === 1 ? "" : "s"}`;
    const nextPage = firstPage + pagesFetched;
    const more = nextPage <= (response.total_pages ?? 0) ? ` Next: --page ${nextPage}` : "";
    note(ctx, `${shown} (page${pagesFetched > 1 ? `s ${firstPage}–${nextPage - 1}` : ` ${firstPage}`} of ${formatNumber(response.total_pages ?? 1)}, ${pageSize} per page).${more}`);
    if (max !== undefined && max % pageSize !== 0 && seen.size < max && more !== "") {
      note(
        ctx,
        `note: stopped at ${pagesFetched * pageSize} jobs: --max ${max} is not a multiple of the page size ${pageSize}, and the next page would pass the cap.`,
      );
    }
    if (total === 0) {
      const hint = unmatchedValueHint(filters);
      if (hint) note(ctx, `note: ${hint}`);
    }
  } finally {
    sink.close();
  }
  return 0;
}

export const searchCommand: CommandDef = {
  name: "search",
  summary: "Search live job listings (billed per job returned)",
  usage: ["[query] [filters] [--page N] [--page-size N] [--max N]"],
  description:
    "Runs POST /api/jobs/search. Every job a page returns is billed: included jobs first, then the wallet at $3.00 per 1,000 jobs (3 credits each); an empty page costs nothing. " +
    `One page of ${DEFAULT_PAGE_SIZE} is fetched unless you ask for more, and the walk is always bounded: --max N fetches whole pages up to N jobs and never more. ` +
    "The wallet must cover a full page before the request runs, so keep --page-size small on a low balance. " +
    "If a walk fails part-way, the pages already fetched are still written and the error says which --page to resume from.\n\n" +
    'Wrap a phrase in double quotes for an exact title match, and prefix a term with "-" to exclude it (put such a query after --). ' +
    "Filter values are matched literally, so an unknown value returns zero results rather than an error: list valid values with `jobo filters`. " +
    "A fixed value is accepted in any case (Remote, remote), and a filter flag in the singular or the plural (--work-model, --work-models). " +
    "Do not page through search to export jobs; `jobo feed` bills a job once per 30 days.",
  options: {
    ...searchFilterOptions(),
    page: { type: "string", value: "N", description: "Page to fetch, from 1 (default 1).", group: "Paging" },
    "page-size": {
      type: "string",
      value: "N",
      description: `Jobs per page, 1–${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}; with --max, up to ${MAX_PAGE_SIZE}). This is the most one request bills.`,
      group: "Paging",
    },
    max: {
      type: "string",
      aliases: ["limit"],
      value: "N",
      description:
        "Walk pages until N jobs are fetched, starting at --page (also --limit). A hard cap on jobs billed: only whole pages are fetched, so pick a multiple of --page-size.",
      group: "Paging",
    },
    "include-fields": {
      type: "string",
      multiple: true,
      split: true,
      value: "LIST",
      description: `Heavy job fields to return. Default: all of them. "${NO_FIELDS}" returns the core fields only, which keeps the output small. The price is the same.`,
      choices: [...INCLUDE_FIELDS, NO_FIELDS],
      hint: LIST_HINT,
      group: "Output",
    },
    facets: {
      type: "string",
      multiple: true,
      split: true,
      value: "LIST",
      description:
        'Facet counts to include in the JSON output, e.g. work_model,sources. "none" turns facets off; omitted, the API returns its default set.',
      group: "Output",
    },
  },
  output: true,
  sizeFlag: "--page-size",
  examples: [
    'jobo search "data engineer" --location "Berlin, Germany" --work-model remote,hybrid',
    "jobo search --skills Python --exclude-skills PHP --posted-after 7d --page-size 5 --include-fields none",
    "jobo search --companies stripe.com,shopify.com --experience-level senior,lead --json",
    'jobo search engineer --industries "Software Development" --company-categories saas --page-size 5',
    "jobo search nurse --sort discovered_asc --discovered-after 2026-11-01 --discovered-before 2026-11-02 --max 200 --csv -o nurses.csv",
  ],
  run,
};
