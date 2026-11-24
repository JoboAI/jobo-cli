import {
  InsufficientCreditsError,
  JoboApiError,
  JoboTransportError,
  RateLimitError,
} from "@jobo-ai/connector-core";

import { flag, int, list, str, type CommandDef, type Ctx, type OptionSpec, type OptionSpecs } from "../args";
import { CliError, EXIT, URLS, UsageError, describeError, sentence } from "../errors";
import { LIST_HINT, flagName } from "../filters";
import { emitRecords, openSink, resolveFormat, type Column } from "../output";
import { billedGet, formatCredits, formatNumber, note, openSession, type Session } from "../session";
import {
  COMPANY_SIGNAL_FILTER_KEYS,
  HIRING_SIGNAL_FILTERS,
  SIGNAL_MAX_LIMIT,
  SIGNAL_MAX_LIST_VALUES,
  describeSignal,
  signalTypeLabel,
  type HiringSignal,
  type SignalFilterDescriptor,
} from "../signals";

/** Small on purpose: every signal returned is billed at ten times a job. */
export const DEFAULT_MAX_SIGNALS = 10;

const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY = /^[a-z]{2}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** What `created_after` takes (HiringSignalsController.InstantFormats): a time with seconds, up to 7 decimals, and an optional zone. */
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$/;
const AGE = /^(\d+)([hdw])$/i;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const AGE_HINT = "or an age such as 24h, 7d or 2w";

// ── Flags, one per filter ────────────────────────────────────────────────────

/** Help for a filter flag: the contract's description, unless the command line needs other words. */
const FLAG_HELP: Readonly<Record<string, string>> = {
  detected_after: `Earliest detection day, inclusive: yyyy-MM-dd, ${AGE_HINT}.`,
  detected_before: `Latest detection day, inclusive: yyyy-MM-dd, ${AGE_HINT}.`,
  created_after:
    "Only signals first stored after this instant, exclusive: ISO 8601 with seconds (2026-11-12T09:30:00Z; a bare date means midnight UTC), " +
    `${AGE_HINT}. To read what is new, pass the newest created_at you hold, minus five minutes.`,
};

function filterOption(filter: SignalFilterDescriptor): OptionSpec {
  const description = FLAG_HELP[filter.key] ?? filter.description;
  const company = filter.company ? " Also taken with --company-id." : "";
  switch (filter.kind) {
    case "stringList":
    case "enumList":
      return {
        type: "string",
        multiple: true,
        split: true,
        value: "LIST",
        description: `${description}${company}`,
        ...(filter.options ? { choices: filter.options } : {}),
        hint: `${LIST_HINT} At most ${SIGNAL_MAX_LIST_VALUES} values.`,
        group: "Filters",
      };
    case "number":
      return {
        type: "string",
        value: "N",
        description: `${description} ${filter.min}–${filter.max}.${company}`,
        group: "Filters",
      };
    case "boolean":
      return { type: "boolean", description: `${description}${company}`, group: "Filters" };
    case "date":
    case "dateTime":
      return { type: "string", value: "WHEN", description: `${description}${company}`, group: "Filters" };
    default: {
      // A kind added to the contract has to be handled here before it can ship.
      const unhandled: never = filter.kind;
      throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
    }
  }
}

export function signalFilterOptions(): OptionSpecs {
  return Object.fromEntries(HIRING_SIGNAL_FILTERS.map((filter) => [flagName(filter.key), filterOption(filter)]));
}

// ── Flags to the query ───────────────────────────────────────────────────────

/** A calendar day that exists: 2026-02-31 is refused, not rolled into March. */
function realDay(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, date));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === date;
}

function age(raw: string, now: Date): Date | undefined {
  const match = AGE.exec(raw);
  if (!match) return undefined;
  return new Date(now.getTime() - Number(match[1]) * (UNIT_MS[(match[2] ?? "").toLowerCase()] ?? 0));
}

function parseDay(raw: string, label: string, now: Date): string {
  const ago = age(raw, now);
  if (ago) return ago.toISOString().slice(0, 10);
  if (!DAY.test(raw)) throw new UsageError(`${label} takes a day as yyyy-MM-dd, ${AGE_HINT}; got "${raw}".`);
  if (!realDay(raw)) throw new UsageError(`${label}: ${raw} is not a real date.`);
  return raw;
}

function parseInstant(raw: string, label: string, now: Date): string {
  const ago = age(raw, now);
  if (ago) return ago.toISOString();
  if (DAY.test(raw)) {
    if (!realDay(raw)) throw new UsageError(`${label}: ${raw} is not a real date.`);
    return `${raw}T00:00:00Z`;
  }
  const match = INSTANT.exec(raw);
  if (!match) {
    throw new UsageError(
      `${label} takes an ISO 8601 date and time with seconds (2026-11-12T09:30:00Z, up to seven decimal places, Z or an offset such as +02:00), a date, ${AGE_HINT}; got "${raw}".`,
    );
  }
  const [hour, minute, second] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
  if (!realDay(match[1] ?? "") || hour > 23 || minute > 59 || second > 59) {
    throw new UsageError(`${label}: ${raw} is not a real date and time.`);
  }
  return raw;
}

/** The values of a list flag: split on commas, trimmed, each once. */
function listValues(ctx: Ctx, key: string): string[] {
  const label = `--${flagName(key)}`;
  const values: string[] = [];
  for (const entry of list(ctx.values, flagName(key)) ?? []) {
    for (const piece of entry.split(",")) {
      const value = piece.trim();
      if (value !== "" && !values.includes(value)) values.push(value);
    }
  }
  if (values.length > SIGNAL_MAX_LIST_VALUES) {
    throw new UsageError(`${label} takes at most ${SIGNAL_MAX_LIST_VALUES} values; ${values.length} were given. Split them over several runs.`);
  }
  // Rules the API enforces with a 400; checked here so a mistake is caught before anything is sent.
  if (key === "company_ids") {
    const bad = values.find((value) => !COMPANY_ID.test(value));
    if (bad !== undefined) throw new UsageError(`${label}: "${bad}" is not a company id (a GUID). Use --domains for website domains.`);
  } else if (key === "job_countries") {
    const bad = values.find((value) => !COUNTRY.test(value));
    if (bad !== undefined) throw new UsageError(`${label}: "${bad}" is not a two-letter country code, e.g. US, DE.`);
    return values.map((value) => value.toUpperCase());
  } else if (key === "roles") {
    const bad = values.find((value) => value.length < 2);
    if (bad !== undefined) throw new UsageError(`${label}: "${bad}" is too short to look for in a job title; use at least 2 characters.`);
  }
  return values;
}

/** Whether the command line set a filter at all. */
function given(ctx: Ctx, filter: SignalFilterDescriptor): boolean {
  const value = ctx.values[flagName(filter.key)];
  return value !== undefined && value !== false;
}

/** The query of the first request, in the contract's order, every value checked. */
export function signalsQuery(ctx: Ctx): Record<string, string> {
  const now = ctx.io.now();
  const query: Record<string, string> = {};
  for (const filter of HIRING_SIGNAL_FILTERS) {
    const name = flagName(filter.key);
    const label = `--${name}`;
    switch (filter.kind) {
      case "stringList":
      case "enumList": {
        const values = listValues(ctx, filter.key);
        if (values.length > 0) query[filter.key] = values.join(",");
        break;
      }
      case "number": {
        const value = int(ctx.values, name, { min: filter.min ?? 1, max: filter.max });
        if (value !== undefined) query[filter.key] = String(value);
        break;
      }
      case "boolean":
        if (flag(ctx.values, name)) query[filter.key] = "true";
        break;
      case "date": {
        const raw = str(ctx.values, name);
        if (raw !== undefined) query[filter.key] = parseDay(raw, label, now);
        break;
      }
      case "dateTime": {
        const raw = str(ctx.values, name);
        if (raw !== undefined) query[filter.key] = parseInstant(raw, label, now);
        break;
      }
    }
  }
  if (query.detected_after && query.detected_before && query.detected_after > query.detected_before) {
    throw new UsageError("--detected-after is later than --detected-before, so no signal can match.");
  }
  return query;
}

function queryString(query: Record<string, string>): string {
  const parts = Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

// ── Output ───────────────────────────────────────────────────────────────────

/** A signal as the CLI writes it: the API's record, plus its type's label and one sentence. */
export type SignalRecord = HiringSignal & { type_label: string; summary: string };

export function toRecord(signal: HiringSignal): SignalRecord {
  return { ...signal, type_label: signalTypeLabel(String(signal.type ?? "")), summary: describeSignal(signal) };
}

const SIGNAL_TABLE_COLUMNS: readonly Column[] = [
  { key: "detected_on", header: "detected" },
  { key: "company.name", header: "company", max: 26 },
  { key: "type_label", header: "type", max: 22 },
  { key: "strength" },
  { key: "summary", max: 70 },
];

const SIGNAL_CSV_COLUMNS: readonly Column[] = [
  { key: "id" },
  { key: "type" },
  { key: "type_label" },
  { key: "detected_on" },
  { key: "created_at" },
  { key: "strength" },
  { key: "company.id" },
  { key: "company.name" },
  { key: "company.domain" },
  { key: "company.country_code" },
  { key: "summary" },
  { key: "evidence_job_ids" },
];

/** The usage line for one page: what it cost and what is left. Signals have their own included count. */
function signalsUsage(headers: Record<string, string>, count: number): string {
  const parts = [`${formatNumber(count)} signal${count === 1 ? "" : "s"}`];
  const number = (name: string): number | null => {
    const value = headers[name];
    return value !== undefined && /^-?\d+$/.test(value.trim()) ? Number(value) : null;
  };
  if (headers["x-jobo-environment"] === "sandbox") parts.push("sandbox key: not billed");
  const deducted = number("x-credits-deducted");
  if (deducted !== null) parts.push(`${formatCredits(deducted)} charged`);
  const balance = number("x-credits-balance");
  if (balance !== null) parts.push(`wallet ${formatCredits(balance)}`);
  const remaining = number("x-quota-remaining");
  if (remaining !== null) {
    const limit = number("x-quota-limit");
    parts.push(`included signals left ${formatNumber(remaining)}${limit !== null ? ` of ${formatNumber(limit)}` : ""}`);
  }
  return parts.join(" · ");
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A signals failure in words. The shared wording is for job search; here a
 * 402 is about included signals, a lost answer is not retried (it may have
 * been billed), and the 403 and the sandbox 404 have their own causes.
 */
export function signalsError(error: unknown, context: { companyId?: string; pageSize: number; correlationId?: string }): CliError {
  const support = context.correlationId ? ` (correlation id ${context.correlationId})` : "";
  if (error instanceof InsufficientCreditsError) {
    const topUp =
      error.body && typeof error.body === "object" && typeof (error.body as Record<string, unknown>).top_up_url === "string"
        ? ((error.body as Record<string, unknown>).top_up_url as string)
        : URLS.billing;
    return new CliError(
      `Your included signals and wallet cannot cover a page of ${formatNumber(context.pageSize)} signals: nothing was charged or returned. ` +
        `Top up: ${topUp}. A smaller --max asks for a smaller page.`,
      EXIT.CREDITS,
    );
  }
  if (error instanceof RateLimitError) {
    const wait = error.retryAfterSeconds != null ? ` Retry in ${error.retryAfterSeconds}s.` : "";
    return new CliError(
      `Rate limited: ${sentence(error.detail ?? "too many requests")}${wait} Without a subscription the signals API takes 20 requests a minute, 200 an hour and 1,000 a day. Limits: ${URLS.rateLimits}`,
      EXIT.RATE_LIMIT,
    );
  }
  if (error instanceof JoboApiError) {
    if (error.status === 403 && error.code === "account_key_required") {
      return new CliError(
        `Hiring Signals is charged to an account's wallet, and this key belongs to no account. Use an account API key from ${URLS.apiKeys}.`,
        EXIT.AUTH,
      );
    }
    if (error.status === 404 && error.code === "not_available_in_sandbox") {
      return new CliError("Hiring Signals is not available with a sandbox key (jbe_test_…): use a live key.", EXIT.NOT_FOUND);
    }
    if (error.status === 404 && context.companyId) {
      return new CliError(`No company has the id ${context.companyId}.`, EXIT.NOT_FOUND);
    }
    if (error.status >= 500 || error.status < 300) {
      return new CliError(
        `The Jobo API failed to answer this page (HTTP ${error.status}): ${sentence(error.detail ?? error.message)} ` +
          `It was not sent again, because the page may have been billed with its answer lost. Check \`jobo usage\` before reading again. Status: ${URLS.status}${support}`,
        EXIT.UNAVAILABLE,
      );
    }
  }
  if (error instanceof JoboTransportError) {
    return new CliError(
      `No answer from the Jobo API: ${sentence(error.message)} The request was not sent again, because the page may have been billed with its answer lost. ` +
        "Check `jobo usage` before reading again.",
      EXIT.UNAVAILABLE,
    );
  }
  const described = describeError(error, { correlationId: context.correlationId });
  return new CliError(described.message, described.exitCode);
}

// ── The command ──────────────────────────────────────────────────────────────

async function run(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) {
    throw new UsageError(`jobo signals takes no arguments (got "${ctx.positionals[0]}"). Use the filter flags.`);
  }

  // Everything is checked before a request: a mistake must not cost a signal.
  const companyId = str(ctx.values, "company-id");
  if (companyId !== undefined && !COMPANY_ID.test(companyId)) {
    throw new UsageError(`--company-id takes a Jobo company id (a GUID), got "${companyId}". For a website domain, use --domains.`);
  }
  if (companyId !== undefined) {
    const refused = HIRING_SIGNAL_FILTERS.filter((filter) => !filter.company && given(ctx, filter)).map(
      (filter) => `--${flagName(filter.key)}`,
    );
    if (refused.length > 0) {
      throw new UsageError(
        `--company-id reads GET /api/companies/{id}/signals, which does not take ${refused.join(", ")}. ` +
          `It takes only ${COMPANY_SIGNAL_FILTER_KEYS.map((key) => `--${flagName(key)}`).join(", ")}. ` +
          "To combine one company with other filters, pass it as --company-ids instead.",
      );
    }
  }
  const filters = signalsQuery(ctx);
  const requestedMax = int(ctx.values, "max", { min: 1 });
  const max = requestedMax ?? DEFAULT_MAX_SIGNALS;
  const startCursor = str(ctx.values, "cursor");
  const path = companyId !== undefined ? `/api/companies/${companyId.toLowerCase()}/signals` : "/api/signals";

  const format = resolveFormat(ctx.values, ctx.io);
  // Row formats go out page by page; a JSON document or a table is written once.
  const streaming = format === "jsonl" || format === "csv";
  const sink = openSink(ctx, format);
  const session: Session = openSession(ctx);

  note(
    ctx,
    `cost: reads at most ${formatNumber(max)} signal${max === 1 ? "" : "s"}${requestedMax === undefined ? ` (the default; --max N for more)` : ` (--max ${formatNumber(max)})`}. ` +
      "Each signal returned is billed at ten times the price of a job, and a signal read again is billed again.",
  );

  const buffered: SignalRecord[] = [];
  const seen = new Set<string>();
  let cursor = startCursor;
  let nextCursor: string | null = null;
  let hasMore = true;
  let pages = 0;
  let pageSize = Math.min(SIGNAL_MAX_LIMIT, max);
  let headerWritten = sink.continuing;
  let flushed = false;

  const emit = (rows: readonly SignalRecord[], partial: boolean) =>
    emitRecords(ctx, { ...sink, continuing: headerWritten }, format, {
      rows,
      columns: SIGNAL_TABLE_COLUMNS,
      csvColumns: SIGNAL_CSV_COLUMNS,
      empty: "No signals matched.",
      envelope: (projected) => ({
        signals: projected,
        next_cursor: nextCursor,
        has_more: hasMore,
        ...(partial ? { partial: true } : {}),
      }),
    });

  try {
    while (seen.size < max) {
      // A page never asks for more than is still wanted: every signal on it is billed.
      pageSize = Math.min(SIGNAL_MAX_LIMIT, max - seen.size);
      const query = { ...filters, limit: String(pageSize), ...(cursor !== undefined ? { cursor } : {}) };
      const { data, headers } = await billedGet(ctx, session, `${path}${queryString(query)}`);
      pages++;
      const page = (data ?? {}) as { signals?: HiringSignal[] | null; next_cursor?: string | null; has_more?: boolean };
      const received = Array.isArray(page.signals) ? page.signals : [];

      const fresh: SignalRecord[] = [];
      for (const signal of received) {
        if (seen.has(signal.id)) continue;
        seen.add(signal.id);
        fresh.push(toRecord(signal));
      }
      if (streaming) {
        await emit(fresh, false);
        headerWritten = true;
      } else {
        buffered.push(...fresh);
      }

      hasMore = Boolean(page.has_more) && Boolean(page.next_cursor);
      nextCursor = hasMore ? (page.next_cursor ?? null) : null;
      note(ctx, `page ${pages}: ${signalsUsage(headers, received.length)}`);
      if (headers["x-billing-status"]?.toLowerCase() === "unconfirmed") {
        note(ctx, "warning: these signals were delivered but wallet settlement could not be confirmed; do not replay this page automatically.");
      }
      if (!hasMore) break;
      if (nextCursor === cursor) {
        note(ctx, "warning: the API returned the same cursor again; stopping instead of looping on it.");
        break;
      }
      cursor = nextCursor ?? undefined;
    }

    if (!streaming) {
      flushed = true;
      await emit(buffered, false);
    }
    note(ctx, `${formatNumber(seen.size)} signal${seen.size === 1 ? "" : "s"} read in ${pages} request${pages === 1 ? "" : "s"}.`);
    if (hasMore && nextCursor) {
      note(ctx, `more remain. next cursor: ${nextCursor}  (the same flags with --cursor ${nextCursor} reads on; each is billed)`);
    }
  } catch (error) {
    // The pages before the failure are billed. Hand them over, then fail.
    if (pages > 0) {
      if (!streaming && !flushed) {
        try {
          await emit(buffered, true);
        } catch {
          // The original error is the one to report.
        }
      }
      const where = sink.path ? `written to ${sink.path}` : "printed";
      note(
        ctx,
        `${formatNumber(seen.size)} signal${seen.size === 1 ? "" : "s"} from ${pages} page${pages === 1 ? "" : "s"} were read and billed before the error, and are ${where}.` +
          (cursor !== undefined ? ` To read on, run the same flags with --cursor ${cursor}${sink.path && streaming ? " --append" : ""}.` : ""),
      );
    }
    throw signalsError(error, { companyId, pageSize, correlationId: ctx.lastHeaders["x-correlation-id"] });
  } finally {
    sink.close();
  }
  return 0;
}

export const signalsCommand: CommandDef = {
  name: "signals",
  summary: "Read hiring signals (billed per signal, at ten times a job; --max defaults to 10)",
  usage: ["[filters] [--max N] [--cursor CURSOR]", "--company-id ID [--types LIST] [--min-strength N] [--detected-after WHEN] [--created-after WHEN]"],
  description:
    "Runs GET /api/signals, or GET /api/companies/{id}/signals with --company-id. A hiring signal is one event at one company, detected from its job postings: " +
    "a hiring surge, a first job in a country, a leadership search, a new technology, a slowdown. Each comes with a type label and a one-sentence summary.\n\n" +
    `Cost: each signal returned is billed at ten times the price of a job (30 credits, $0.03, at the pay-as-you-go rate): the plan's included signals first, then the wallet; the Unlimited plan has no per-signal charge. ` +
    `A signal read again is billed again. A request that returns nothing is free. --max N is how many signals to read, ${DEFAULT_MAX_SIGNALS} unless you say otherwise; ` +
    `pages are walked until it is reached, and no page asks for more than is still wanted (at most ${SIGNAL_MAX_LIMIT}). There is no --all. ` +
    "When more remain, the next cursor is printed; --cursor CURSOR reads on with the same flags. A request whose answer is lost (a timeout, a dropped connection, a 5xx) is not sent again, since it may have been billed.\n\n" +
    "To read only what is new: keep the newest created_at you have received, and on the next run pass it, minus five minutes, as --created-after; skip any id you already hold. " +
    "The five-minute overlap covers signals stored while the last run read, and the signals inside it are billed again.\n\n" +
    "Every filter is optional, and they combine with AND; a list matches any of its values, and no value may contain a comma. " +
    "The focus filters (--functions, --roles, --seniority, --technologies, --skills, --technology-categories, --job-countries, --job-regions, --job-cities) say what a signal must be about: " +
    "a signal is returned when it agrees with each focus filter its type carries and its type carries at least one of those set, so a hiring_slowdown never matches one. " +
    "Pages run newest detection day first. More signal types may be added; an unknown type is shown with its name. Not available with a sandbox key.",
  options: {
    ...signalFilterOptions(),
    "company-id": {
      type: "string",
      value: "ID",
      description: `One company's signals, by Jobo company id (a GUID). That endpoint takes only ${COMPANY_SIGNAL_FILTER_KEYS.map((key) => `--${flagName(key)}`).join(", ")}.`,
      group: "Filters",
    },
    max: {
      type: "string",
      aliases: ["limit"],
      value: "N",
      description: `How many signals to read (default ${DEFAULT_MAX_SIGNALS}; also --limit). Every one is billed, so this is the most a run costs.`,
      group: "Paging",
    },
    cursor: { type: "string", value: "CURSOR", description: "Read on from the `next cursor` of an earlier run, with the same flags.", group: "Paging" },
  },
  output: true,
  examples: [
    "jobo signals --types hiring_surge,new_country --countries US --min-strength 70",
    "jobo signals --domains stripe.com,shopify.com --detected-after 30d --max 25 --csv -o signals.csv",
    'jobo signals --types hard_to_fill --functions Technology --seniority senior,director --job-countries US --jsonl',
    "jobo signals --company-id 6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33 --types leadership_hire",
    "jobo signals --domains stripe.com --created-after 2026-11-20T09:25:00Z --max 50 --jsonl -o new.jsonl --append",
  ],
  run,
};
