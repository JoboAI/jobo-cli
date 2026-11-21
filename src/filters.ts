/**
 * The search and feed flags, rendered from the shared connector contract.
 *
 * Search flags come one-to-one from `JOB_SEARCH_FILTERS`: the flag is the
 * filter key in kebab-case, its help is the contract's description, and its
 * parsing follows the contract's `kind`. A filter added to the contract shows
 * up here without a code change; `test/filters.test.ts` proves each one
 * reaches the request body.
 *
 * Feed flags come from `JOB_FEED_FILTER_KEYS`. That list carries no shapes, so
 * `FEED_FILTERS` supplies them — typed as a `Record` over the key union, which
 * makes a key the CLI does not know a compile error.
 */

import {
  COMPANY_REVENUES,
  COMPANY_SIZES,
  DESCRIPTION_FORMATS,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  JOB_FEED_FILTER_KEYS,
  JOB_SEARCH_FILTERS,
  WORK_MODELS,
  type FilterDescriptor,
  type FilterOptionsFacet,
  type JobFeedFilterKey,
  type JobFeedParams,
  type JobSearchFilters,
} from "@jobo-ai/connector-core";

import { list, str, type OptionSpecs, type ParsedValues } from "./args";
import { UsageError } from "./errors";

export const flagName = (key: string): string => key.replace(/_/g, "-");

/**
 * Filters whose values are names that can themselves contain a comma (a
 * company called "Acme, Inc.", the subcategory "Film, TV & Stage Production").
 * Their flags are never split on commas: repeat the flag for several values.
 */
export const NO_COMMA_SPLIT: ReadonlySet<string> = new Set([
  "companies",
  "exclude_companies",
  "industries",
  "exclude_industries",
  "job_categories",
  "exclude_job_categories",
  "job_subcategories",
  "exclude_job_subcategories",
  "company_primary_industries",
  "exclude_company_primary_industries",
]);

/**
 * Contract filters whose `options` are a picker list, not the whole
 * vocabulary: the API takes any ISO 639-1 language code.
 */
const OPEN_OPTION_LISTS: ReadonlySet<string> = new Set(["language"]);

/** Facets `jobo filters <facet>` serves: every open vocabulary the contract names, bar companies. */
export const FILTER_FACETS: readonly FilterOptionsFacet[] = [
  ...new Set(
    JOB_SEARCH_FILTERS.map((filter) => filter.dynamicOptions).filter(
      (source): source is FilterOptionsFacet => source !== undefined && source !== "companies",
    ),
  ),
];

// ── Value parsing ────────────────────────────────────────────────────────────

const RELATIVE = /^(\d+)([hdw])$/i;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * A timestamp flag: an ISO 8601 date or date-time, or an age such as `24h`,
 * `7d` or `2w`, which becomes that long before now.
 */
export function parseTime(raw: string, flagLabel: string, now: Date): string {
  const relative = RELATIVE.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[(relative[2] ?? "").toLowerCase()] ?? 0;
    return new Date(now.getTime() - amount * unit).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new UsageError(
      `${flagLabel} takes an ISO 8601 date (2026-11-01 or 2026-11-01T00:00:00Z) or an age such as 24h, 7d or 2w; got "${raw}".`,
    );
  }
  return raw;
}

export function parseBoolean(raw: string, flagLabel: string): boolean {
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`${flagLabel} takes true or false, got "${raw}".`);
}

function parseListValues(raw: readonly string[], split: boolean): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    for (const piece of split ? entry.split(",") : [entry]) {
      const value = piece.trim();
      if (value !== "" && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

function assertChoices(values: readonly string[], choices: readonly string[], flagLabel: string): void {
  const unknown = values.filter((value) => !choices.includes(value));
  if (unknown.length > 0) {
    // The API matches these literally: an unknown value is not a 400, it is zero results.
    throw new UsageError(
      `${flagLabel}: unknown value${unknown.length > 1 ? "s" : ""} ${unknown.map((v) => `"${v}"`).join(", ")}. ` +
        `Valid values: ${choices.join(", ")}.`,
    );
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

function isList(filter: FilterDescriptor): boolean {
  return filter.kind === "stringList" || filter.kind === "enumList";
}

/** The fixed value set of a filter, when the contract's `options` is the whole vocabulary. */
function closedChoices(filter: FilterDescriptor): readonly string[] | undefined {
  if (!filter.options || filter.dynamicOptions || OPEN_OPTION_LISTS.has(filter.key)) return undefined;
  return filter.options;
}

function lookupHint(filter: FilterDescriptor): string {
  if (filter.dynamicOptions === "companies") return " Look up ids with `jobo companies <name>`.";
  if (filter.dynamicOptions) return ` List values with \`jobo filters ${filter.dynamicOptions} [query]\`.`;
  return "";
}

function searchFlagHelp(filter: FilterDescriptor): string {
  const choices = closedChoices(filter);
  let help = filter.description;
  if (choices) help += ` One of: ${choices.join(", ")}.`;
  help += lookupHint(filter);
  if (isList(filter)) {
    help += NO_COMMA_SPLIT.has(filter.key)
      ? " Repeat the flag for several values (values may contain commas, so they are not split)."
      : " Repeat the flag or separate values with commas.";
  }
  if (filter.kind === "dateTime") help += " ISO 8601, or an age such as 24h, 7d or 2w.";
  if (filter.kind === "boolean") help += " true or false.";
  return help;
}

const VALUE_NAMES: Record<FilterDescriptor["kind"], string> = {
  string: "text",
  number: "N",
  boolean: "true|false",
  dateTime: "when",
  stringList: "value",
  enumList: "value",
  enum: "value",
};

/** One flag per contract filter. */
export function searchFilterOptions(): OptionSpecs {
  const specs: OptionSpecs = {};
  for (const filter of JOB_SEARCH_FILTERS) {
    specs[flagName(filter.key)] = {
      type: "string",
      ...(isList(filter) ? { multiple: true } : {}),
      value: VALUE_NAMES[filter.kind],
      description: searchFlagHelp(filter),
      group: "Filters",
    };
  }
  return specs;
}

/** Read the contract's flags into filter values keyed by contract key, ready for `toJobSearchBody()`. */
export function parseSearchFilters(values: ParsedValues, now: Date): JobSearchFilters {
  const filters: Record<string, unknown> = {};

  for (const filter of JOB_SEARCH_FILTERS) {
    const name = flagName(filter.key);
    const label = `--${name}`;
    const choices = closedChoices(filter);

    switch (filter.kind) {
      case "stringList":
      case "enumList": {
        const raw = list(values, name);
        if (!raw) break;
        const parsed = parseListValues(raw, !NO_COMMA_SPLIT.has(filter.key));
        if (choices) assertChoices(parsed, choices, label);
        if (parsed.length > 0) filters[filter.key] = parsed;
        break;
      }
      case "string": {
        const raw = str(values, name);
        if (raw !== undefined) filters[filter.key] = raw;
        break;
      }
      case "enum": {
        const raw = str(values, name);
        if (raw === undefined) break;
        if (filter.options) assertChoices([raw], filter.options, label);
        filters[filter.key] = raw;
        break;
      }
      case "number": {
        const raw = str(values, name);
        if (raw === undefined) break;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new UsageError(`${label} takes a number above zero, got "${raw}".`);
        }
        filters[filter.key] = parsed;
        break;
      }
      case "boolean": {
        const raw = str(values, name);
        if (raw !== undefined) filters[filter.key] = parseBoolean(raw, label);
        break;
      }
      case "dateTime": {
        const raw = str(values, name);
        if (raw !== undefined) filters[filter.key] = parseTime(raw, label, now);
        break;
      }
      default: {
        // A kind added to the contract has to be handled here before it can ship.
        const unhandled: never = filter.kind;
        throw new Error(`Unhandled filter kind: ${String(unhandled)}`);
      }
    }
  }

  return filters as JobSearchFilters;
}

// ── Feed ─────────────────────────────────────────────────────────────────────

type FeedShape = "locations" | "list" | "includeExclude" | "boolean" | "dateTime" | "enum";

interface FeedFilter {
  shape: FeedShape;
  help: string;
  /** Fixed vocabulary, validated before the request is sent. */
  choices?: readonly string[];
}

/** Shape and help for every feed body key. A key missing here fails the type check. */
export const FEED_FILTERS: Record<JobFeedFilterKey, FeedFilter> = {
  locations: {
    shape: "locations",
    help: 'A structured location: country=…[,region=…][,city=…], or just a country name. Every entry needs a country; "country=Remote" matches remote jobs. Repeat the flag to match any of several places.',
  },
  sources: { shape: "list", help: "Only these ATS sources, e.g. greenhouse, lever. List them with `jobo filters sources`." },
  work_models: { shape: "list", help: "Only these work models.", choices: WORK_MODELS },
  employment_types: { shape: "list", help: "Only these employment types.", choices: EMPLOYMENT_TYPES },
  experience_levels: { shape: "list", help: "Only these experience levels.", choices: EXPERIENCE_LEVELS },
  languages: { shape: "list", help: "Only these description languages, as ISO 639-1 codes (en, de)." },
  exclude_sources: { shape: "list", help: "Leave out these ATS sources." },
  exclude_work_models: {
    shape: "list",
    help: "Leave out these work models. Jobs with no work model are kept.",
    choices: WORK_MODELS,
  },
  exclude_employment_types: {
    shape: "list",
    help: "Leave out these employment types. Jobs with no employment type are kept.",
    choices: EMPLOYMENT_TYPES,
  },
  exclude_experience_levels: {
    shape: "list",
    help: "Leave out these experience levels. Jobs with no experience level are kept.",
    choices: EXPERIENCE_LEVELS,
  },
  exclude_languages: { shape: "list", help: "Leave out these description languages. Jobs with no language are kept." },
  companies: {
    shape: "includeExclude",
    help: "these companies: a Jobo company id, a website domain (fedex.com) or a whole company name. Look up ids with `jobo companies <name>`.",
  },
  job_categories: {
    shape: "includeExclude",
    help: "these occupation categories, e.g. Healthcare. List them with `jobo filters job_categories`.",
  },
  job_subcategories: {
    shape: "includeExclude",
    help: "these occupation subcategories, e.g. Nursing. List them with `jobo filters job_subcategories`.",
  },
  occupation_ids: {
    shape: "includeExclude",
    help: "these occupation ids (ids, not names). Find them with `jobo filters occupations <query>`.",
  },
  industries: {
    shape: "includeExclude",
    help: "companies in these industries, matched on the whole name. List them with `jobo filters industries`.",
  },
  company_primary_industries: {
    shape: "includeExclude",
    help: "companies whose single primary industry is one of these.",
  },
  company_categories: {
    shape: "includeExclude",
    help: "companies with these business models, e.g. b2b, saas. List them with `jobo filters company_categories`.",
  },
  company_sizes: { shape: "includeExclude", help: "companies in these headcount bands.", choices: COMPANY_SIZES },
  company_revenues: {
    shape: "includeExclude",
    help: "companies in these annual revenue bands.",
    choices: COMPANY_REVENUES,
  },
  company_is_agency: {
    shape: "boolean",
    help: "false leaves out jobs posted by recruitment and staffing agencies; true returns only theirs.",
  },
  posted_after: {
    shape: "dateTime",
    help: "Only jobs posted or first indexed on or after this time.",
  },
  include_reactivated: {
    shape: "boolean",
    help: "With --posted-after, also return jobs that expired and were reactivated on or after it.",
  },
  description_format: {
    shape: "enum",
    help: "Format of each job's description (default markdown; enhanced and enhanced_html are beta).",
    choices: DESCRIPTION_FORMATS,
  },
  updated_after: {
    shape: "dateTime",
    help: "Only jobs created, updated or re-indexed on or after this time. The watermark for an incremental sync.",
  },
};

function listHelp(key: string, filter: FeedFilter): string {
  const choices = filter.choices ? ` One of: ${filter.choices.join(", ")}.` : "";
  const repeat = NO_COMMA_SPLIT.has(key)
    ? " Repeat the flag for several values (values may contain commas, so they are not split)."
    : " Repeat the flag or separate values with commas.";
  return `${choices}${repeat}`;
}

export function feedFilterOptions(): OptionSpecs {
  const specs: OptionSpecs = {};
  for (const key of JOB_FEED_FILTER_KEYS) {
    const filter = FEED_FILTERS[key];
    const name = flagName(key);
    switch (filter.shape) {
      case "locations":
        specs[name] = { type: "string", multiple: true, value: "place", description: filter.help, group: "Filters" };
        break;
      case "list":
        specs[name] = {
          type: "string",
          multiple: true,
          value: "value",
          description: filter.help + listHelp(key, filter),
          group: "Filters",
        };
        break;
      case "includeExclude":
        specs[name] = {
          type: "string",
          multiple: true,
          value: "value",
          description: `Only ${filter.help}${listHelp(key, filter)}`,
          group: "Filters",
        };
        specs[`exclude-${name}`] = {
          type: "string",
          multiple: true,
          value: "value",
          description: `Leave out ${filter.help}${listHelp(key, filter)}`,
          group: "Filters",
        };
        break;
      case "boolean":
        specs[name] = { type: "string", value: "true|false", description: filter.help, group: "Filters" };
        break;
      case "dateTime":
        specs[name] = {
          type: "string",
          value: "when",
          description: `${filter.help} ISO 8601, or an age such as 24h, 7d or 2w.`,
          group: "Filters",
        };
        break;
      case "enum":
        specs[name] = {
          type: "string",
          value: "value",
          description: `${filter.help}${filter.choices ? ` One of: ${filter.choices.join(", ")}.` : ""}`,
          group: "Filters",
        };
        break;
    }
  }
  return specs;
}

const LOCATION_LEVELS = ["country", "region", "city"] as const;

/** `country=Germany,city=Berlin` or a bare country name. Commas inside a value are kept. */
export function parseLocation(raw: string): { country?: string; region?: string; city?: string } {
  const text = raw.trim();
  if (!/^(country|region|city)\s*=/i.test(text)) {
    if (text.includes("=")) {
      throw new UsageError(`--locations: "${raw}" has an unknown level. Use country=, region= and city=.`);
    }
    return { country: text };
  }
  const location: { country?: string; region?: string; city?: string } = {};
  // Split only where a comma starts the next level, so "city=Washington, D.C." survives.
  for (const part of text.split(/,\s*(?=(?:country|region|city)\s*=)/i)) {
    const index = part.indexOf("=");
    const level = part.slice(0, index).trim().toLowerCase() as (typeof LOCATION_LEVELS)[number];
    const value = part.slice(index + 1).trim();
    if (value !== "") location[level] = value;
  }
  if (!location.country) {
    throw new UsageError(`--locations: "${raw}" needs a country (every location level does).`);
  }
  return location;
}

/** Read the feed flags into a `POST /api/jobs/feed` body, without paging fields. */
export function parseFeedFilters(values: ParsedValues, now: Date): JobFeedParams {
  const body: Record<string, unknown> = {};

  for (const key of JOB_FEED_FILTER_KEYS) {
    const filter = FEED_FILTERS[key];
    const name = flagName(key);
    const label = `--${name}`;
    const split = !NO_COMMA_SPLIT.has(key);

    switch (filter.shape) {
      case "locations": {
        const raw = list(values, name);
        if (raw?.length) body[key] = raw.map(parseLocation);
        break;
      }
      case "list": {
        const raw = list(values, name);
        if (!raw) break;
        const parsed = parseListValues(raw, split);
        if (filter.choices) assertChoices(parsed, filter.choices, label);
        if (parsed.length > 0) body[key] = parsed;
        break;
      }
      case "includeExclude": {
        const include = parseListValues(list(values, name) ?? [], split);
        const exclude = parseListValues(list(values, `exclude-${name}`) ?? [], split);
        if (filter.choices) {
          assertChoices(include, filter.choices, label);
          assertChoices(exclude, filter.choices, `--exclude-${name}`);
        }
        if (include.length > 0 || exclude.length > 0) {
          body[key] = {
            ...(include.length > 0 ? { include } : {}),
            ...(exclude.length > 0 ? { exclude } : {}),
          };
        }
        break;
      }
      case "boolean": {
        const raw = str(values, name);
        if (raw !== undefined) body[key] = parseBoolean(raw, label);
        break;
      }
      case "dateTime": {
        const raw = str(values, name);
        if (raw !== undefined) body[key] = parseTime(raw, label, now);
        break;
      }
      case "enum": {
        const raw = str(values, name);
        if (raw === undefined) break;
        if (filter.choices) assertChoices([raw], filter.choices, label);
        body[key] = raw;
        break;
      }
    }
  }

  return body as JobFeedParams;
}
