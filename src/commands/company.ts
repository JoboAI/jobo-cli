import type { CompanySuggestion } from "@jobo-ai/connector-core";

import { int, str, type CommandDef, type Ctx } from "../args";
import { resolveApiKey } from "../config";
import { UsageError } from "../errors";
import { emitDocument, emitRecords, openSink, resolveFormat, toKeyValue } from "../output";
import { anonymousGet, note, openSession } from "../session";

function companyView(document: unknown): string {
  const company = (document ?? {}) as Record<string, unknown>;
  const pairs = Object.entries(company)
    .filter(([key]) => key !== "summary" && key !== "description")
    .map(([key, value]) => [key, value] as const);
  const summary = typeof company.summary === "string" ? `\n${company.summary.trim()}\n` : "";
  return toKeyValue(pairs) + summary;
}

async function runCompany(ctx: Ctx): Promise<number> {
  const id = ctx.positionals[0]?.trim();
  if (!id || ctx.positionals.length > 1) {
    throw new UsageError("Usage: jobo company <id>. The id is `company.id` on a job; find one with `jobo companies <name>`.");
  }
  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const path = `/api/companies/${encodeURIComponent(id)}`;
    // The endpoint takes no key. One is sent when there is one, because a
    // sandbox key selects the sandbox's companies.
    const data = resolveApiKey(ctx.io, str(ctx.values, "api-key"))
      ? (await openSession(ctx).client.getCompany(id)).data
      : (await anonymousGet(ctx, path)).data;
    await emitDocument(ctx, sink, format, data, companyView);
  } finally {
    sink.close();
  }
  return 0;
}

export const companyCommand: CommandDef = {
  name: "company",
  summary: "Fetch one company profile by id (free, no key needed)",
  usage: ["<id>"],
  description:
    "Runs GET /api/companies/{id}: industry, size and the career-site source Jobo reads the company from. Free, not rate limited, and it works without an API key.",
  output: true,
  notFound: "No company has that id (or it is disabled). Find ids with `jobo companies <name>`.",
  examples: ["jobo company b5e6f7a8-1234-5678-9abc-def012345678", "jobo company b5e6f7a8-1234-5678-9abc-def012345678 --json"],
  run: runCompany,
};

const MAX_SUGGESTIONS = 20;

async function runCompanies(ctx: Ctx): Promise<number> {
  const query = ctx.positionals.join(" ").trim();
  if (query.length < 2) throw new UsageError("Usage: jobo companies <query>. The query is the start of a company name or website domain, at least 2 characters.");
  const limit = int(ctx.values, "limit", { min: 1, max: MAX_SUGGESTIONS });

  const format = resolveFormat(ctx.values, ctx.io);
  const sink = openSink(ctx, format);
  try {
    const session = openSession(ctx);
    const { data } = await session.client.suggestCompanies(query, limit);
    const suggestions: CompanySuggestion[] = data.suggestions ?? [];
    await emitRecords(ctx, sink, format, {
      rows: suggestions,
      columns: [
        { key: "name", max: 34 },
        { key: "domain", max: 28 },
        { key: "country" },
        { key: "job_count", header: "jobs" },
        // Comma-joined and never cut, so the cell is the --companies value as it stands.
        { key: "ids", get: (row) => ((row as CompanySuggestion).ids ?? []).join(","), whole: true },
      ],
      empty: "No company name or domain starts with that.",
      envelope: (rows) => ({ ...data, suggestions: rows }),
    });
    const top = suggestions[0];
    if (top?.ids?.length) {
      note(
        ctx,
        `to filter on ${top.name}${suggestions.length > 1 ? " (the first match)" : ""}, in search or the feed: --companies ${top.ids.join(",")}`,
      );
    }
  } finally {
    sink.close();
  }
  return 0;
}

export const companiesCommand: CommandDef = {
  name: "companies",
  summary: "Find companies by name or domain prefix, with their ids (free)",
  usage: ["<query> [--limit N]"],
  description:
    "Companies whose name or website domain starts with the query, each with its ids and live job count. One company can have several ids, one per careers board: " +
    "pass them all to --companies, in search or the feed. The ids column is already written that way (id1,id2), and the line printed under the results is ready to paste. " +
    "A name would also match every other company called that. Free; never billed.",
  options: {
    limit: {
      type: "string",
      aliases: ["max"],
      value: "N",
      description: `Most companies to return, 1–${MAX_SUGGESTIONS} (default 8; also --max).`,
    },
  },
  output: true,
  examples: ["jobo companies stripe", "jobo companies fedex.com --json"],
  run: runCompanies,
};
