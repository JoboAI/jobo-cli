/**
 * The search and feed flags, rendered from the shared connector contract.
 *
 * Search flags come one-to-one from `JOB_SEARCH_FILTERS`: the flag is the
 * filter key in kebab-case, and its parsing, fixed values and completion
 * follow the contract's `kind`, `options` and `dynamicOptions`. A filter added
 * to the contract shows up here without a code change; `test/filters.test.ts`
 * proves each one reaches the request body. The help text is written for a
 * command line (`SEARCH_HELP`); a filter with none yet falls back to the
 * contract's description.
 *
 * Feed flags come from `JOB_FEED_FILTER_KEYS`. That list carries no shapes, so
 * `FEED_FILTERS` supplies them — typed as a `Record` over the key union, which
 * makes a key the CLI does not know a compile error.
 */

import {
  COMPANY_CATEGORIES,
  COMPANY_REVENUES,
  COMPANY_SIZES,
  DESCRIPTION_FORMATS,
  EMPLOYMENT_TYPES,
  EXPERIENCE_LEVELS,
  JOB_FEED_FILTER_KEYS,
  JOB_SEARCH_FILTERS,
  LANGUAGE_CODES,
  WORK_MODELS,
  type FilterDescriptor,
  type FilterOptionsFacet,
  type JobFeedFilterKey,
  type JobFeedParams,
  type JobSearchFilters,
  type LocationSuggestion,
} from "@jobo-ai/connector-core";

import { list, str, type Completer, type OptionSpec, type OptionSpecs, type ParsedValues } from "./args";
import { UsageError } from "./errors";

export const flagName = (key: string): string => key.replace(/_/g, "-");

/**
 * Filters whose values are names that can themselves contain a comma (a
 * company called "Acme, Inc.", the subcategory "Film, TV & Stage Production").
 * Their flags are not split on commas: repeat the flag for several values.
 * The company filters make one exception, see `splitCompanies`.
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

/** Filters that take a company id, a website domain or a company name. */
const COMPANY_FILTERS: ReadonlySet<string> = new Set(["companies", "exclude_companies"]);

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

/**
 * Facets small enough to complete from one cached list. Skills are too many
 * for that and are looked up by prefix; occupation ids are not completed.
 */
const LISTED_FACETS: ReadonlySet<string> = new Set(["sources", "industries", "job_categories", "job_subcategories"]);

const BOOLEANS = ["true", "false"] as const;
export const LIST_HINT = "Repeat the flag or separate values with commas.";
const NAMES_HINT = "Repeat the flag for several values (a value may contain a comma, so values are not split).";
const COMPANIES_HINT = "Separate ids and domains with commas; repeat the flag for names, which may contain a comma.";
const TIME_HINT = "ISO 8601, or an age such as 24h, 7d or 2w.";

/** The same flag in the other grammatical number: `work-model` ↔ `work-models`, `industry` ↔ `industries`. */
export function otherNumber(name: string): string {
  if (name.endsWith("ies")) return `${name.slice(0, -3)}y`;
  if (name.endsWith("s")) return name.slice(0, -1);
  if (name.endsWith("y")) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

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

const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * A company id or a domain never contains a comma, so `id1,id2` and
 * `stripe.com,shopify.com` are lists. A value with any other piece in it is a
 * name and stays whole: "Acme, Inc." is one company.
 */
function splitCompanies(entry: string): string[] {
  const pieces = entry
    .split(",")
    .map((piece) => piece.trim())
    .filter(Boolean);
  return pieces.length > 1 && pieces.every((piece) => COMPANY_ID.test(piece) || DOMAIN.test(piece)) ? pieces : [entry];
}

function parseListValues(raw: readonly string[], key: string): string[] {
  const split = COMPANY_FILTERS.has(key)
    ? splitCompanies
    : NO_COMMA_SPLIT.has(key)
      ? (entry: string) => [entry]
      : (entry: string) => entry.split(",");
  const out: string[] = [];
  for (const entry of raw) {
    for (const piece of split(entry)) {
      const value = piece.trim();
      if (value !== "" && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

function listHint(key: string): string {
  if (COMPANY_FILTERS.has(key)) return COMPANIES_HINT;
  return NO_COMMA_SPLIT.has(key) ? NAMES_HINT : LIST_HINT;
}

/** Completion offers a comma list's last item where commas separate values: everywhere but in names. */
function splits(key: string): boolean {
  return COMPANY_FILTERS.has(key) || !NO_COMMA_SPLIT.has(key);
}

// ── Search ───────────────────────────────────────────────────────────────────

function isList(filter: FilterDescriptor): boolean {
  return filter.kind === "stringList" || filter.kind === "enumList";
}

/** The fixed value set of a filter, when the contract's `options` is the whole vocabulary. */
function closedChoices(filter: FilterDescriptor): readonly string[] | undefined {
  if (filter.kind === "boolean") return BOOLEANS;
  if (!filter.options || filter.dynamicOptions || OPEN_OPTION_LISTS.has(filter.key)) return undefined;
  return filter.options;
}

/** The command that lists a filter's valid values, when it has an open vocabulary. */
function lookupCommand(filter: FilterDescriptor): string | undefined {
  if (filter.dynamicOptions === "companies") return "jobo companies <name>";
  if (filter.dynamicOptions === "occupations") return "jobo filters occupations <query>";
  if (filter.dynamicOptions) return `jobo filters ${filter.dynamicOptions}`;
  if (filter.key === "location") return "jobo locations <query>";
  return undefined;
}

function searchCompleter(filter: FilterDescriptor): Completer | undefined {
  if (filter.key === "location") return { kind: "locations", format: "text" };
  if (filter.dynamicOptions === "companies") return { kind: "companies" };
  // A picker list that is not the whole vocabulary: offered, never enforced.
  if (filter.options) return { kind: "values", values: filter.options };
  if (filter.dynamicOptions === "skills") return { kind: "facet", facet: "skills", mode: "prefix" };
  if (filter.dynamicOptions && LISTED_FACETS.has(filter.dynamicOptions)) {
    return { kind: "facet", facet: filter.dynamicOptions, mode: "list" };
  }
  return undefined;
}

/**
 * What each search flag does, in command-line terms. The fixed values, the
 * lookup command and the list syntax are added from the contract, so they are
 * not repeated here.
 */
const SEARCH_HELP: Record<string, string> = {
  q: "The search text, same as the [query] argument (also --query).",
  location: 'Only jobs in this place, as free text: "Berlin, Germany", "Texas", "Remote".',
  sources: "Only jobs from these ATS sources, e.g. greenhouse, lever_co, ashby.",
  companies:
    'Only jobs at these companies: a Jobo company id, a website domain (stripe.com) or a whole company name ("Stripe"). An id is exact; a name also matches every other company called that.',
  exclude_companies: "Leave out jobs at these companies (ids, domains or whole names, as for --companies).",
  work_model: "Only jobs with these work models.",
  employment_type: "Only jobs with these employment types.",
  experience_level: "Only jobs at these experience levels.",
  language: "Only jobs whose description is in these languages, as ISO 639-1 codes: en, de.",
  skills: "Only jobs that ask for these skills, e.g. Python, Kubernetes.",
  exclude_skills: "Leave out jobs that ask for any of these skills.",
  industries: 'Only jobs at companies in these industries, e.g. "Software Development".',
  exclude_industries: "Leave out jobs at companies in any of these industries.",
  company_categories: "Only jobs at companies with these business models, e.g. b2b, saas, marketplace.",
  exclude_company_categories: "Leave out jobs at companies with any of these business models, e.g. agency.",
  job_categories: "Only jobs in these occupation categories, e.g. Healthcare. Case does not matter.",
  exclude_job_categories: "Leave out jobs in these occupation categories.",
  job_subcategories: "Only jobs in these occupation subcategories, e.g. Nursing. Case does not matter.",
  exclude_job_subcategories: "Leave out jobs in these occupation subcategories.",
  occupation_ids: "Only jobs with these occupation ids, e.g. jobo:backend-developer. Ids, not names: names can change.",
  exclude_occupation_ids: "Leave out jobs with these occupation ids.",
  min_salary_usd: "Only jobs whose published salary reaches this many US dollars a year. Jobs with no published salary never match.",
  max_salary_usd: "Only jobs whose published salary is at or below this many US dollars a year.",
  posted_after: "Only jobs the employer posted on or after this time.",
  posted_before: "Only jobs the employer posted on or before this time.",
  discovered_after:
    "Only jobs Jobo first indexed on or after this time. That time never changes, so use it, not --posted-after, to fetch what is new since your last run.",
  discovered_before: "Only jobs Jobo first indexed on or before this time.",
  search_description: "false matches the query against job titles only. Default true: a wider match that also reads the rest of the listing.",
  sort: "Result order (default relevance). The discovered orders follow the first-indexed time and keep pages stable.",
  description_format: "Format of each job's description (default markdown; enhanced and enhanced_html are beta).",
};

const VALUE_NAMES: Record<FilterDescriptor["kind"], string> = {
  string: "text",
  number: "N",
  boolean: "true|false",
  dateTime: "when",
  stringList: "value",
  enumList: "value",
  enum: "value",
};

function searchSpec(filter: FilterDescriptor): OptionSpec {
  const name = flagName(filter.key);
  const many = isList(filter);
  const choices = closedChoices(filter);
  const complete = choices ? undefined : searchCompleter(filter);
  const lookup = lookupCommand(filter);
  const hint = many ? listHint(filter.key) : filter.kind === "dateTime" ? TIME_HINT : undefined;
  // Every list filter is plural on the feed and often singular here; both spellings mean the one flag.
  const aliases = [...(many || filter.key === "location" ? [otherNumber(name)] : []), ...(filter.key === "q" ? ["query"] : [])];
  return {
    type: "string",
    ...(many ? { multiple: true } : {}),
    ...(many && splits(filter.key) ? { split: true } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    value: VALUE_NAMES[filter.kind],
    description: `${SEARCH_HELP[filter.key] ?? filter.description}${lookup ? ` Look values up with \`${lookup}\`.` : ""}`,
    ...(hint ? { hint } : {}),
    ...(choices ? { choices } : {}),
    ...(complete ? { complete } : {}),
    group: "Filters",
  };
}

/** One flag per contract filter. */
export function searchFilterOptions(): OptionSpecs {
  const specs: OptionSpecs = {};
  for (const filter of JOB_SEARCH_FILTERS) specs[flagName(filter.key)] = searchSpec(filter);
  return specs;
}

/**
 * Read the contract's flags into filter values keyed by contract key, ready
 * for `toJobSearchBody()`. Values of a fixed set were checked, and put in
 * their canonical spelling, when the arguments were parsed.
 */
export function parseSearchFilters(values: ParsedValues, now: Date): JobSearchFilters {
  const filters: Record<string, unknown> = {};

  for (const filter of JOB_SEARCH_FILTERS) {
    const name = flagName(filter.key);
    const label = `--${name}`;

    switch (filter.kind) {
      case "stringList":
      case "enumList": {
        const raw = list(values, name);
        if (!raw) break;
        const parsed = parseListValues(raw, filter.key);
        if (parsed.length > 0) filters[filter.key] = parsed;
        break;
      }
      case "string":
      case "enum": {
        const raw = str(values, name);
        if (raw !== undefined) filters[filter.key] = raw;
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

/**
 * For a search that matched nothing: the filters whose values the API matches
 * exactly but cannot validate, and where to list what it would accept. Null
 * when no such filter was used. A typo in an exclude filter cannot empty a
 * result, so those are left out.
 */
export function unmatchedValueHint(filters: JobSearchFilters): string | null {
  const used = JOB_SEARCH_FILTERS.filter(
    (filter) =>
      filter.dynamicOptions !== undefined &&
      !filter.key.startsWith("exclude_") &&
      (filters as Record<string, unknown>)[filter.key] !== undefined,
  );
  if (used.length === 0) return null;
  const lookups = [...new Set(used.map(lookupCommand).filter((command): command is string => command !== undefined))];
  const flags = used.map((filter) => `--${flagName(filter.key)}`).join(", ");
  return (
    `check ${used.length > 1 ? "the values" : "the value"} of ${flags}: ${used.length > 1 ? "they are" : "it is"} matched exactly, so one the index does not hold matches nothing. ` +
    `List valid values with ${lookups.map((command) => `\`${command}\``).join(", ")}.`
  );
}

// ── Feed ─────────────────────────────────────────────────────────────────────

type FeedShape = "locations" | "list" | "includeExclude" | "boolean" | "dateTime" | "enum";

interface FeedFilter {
  shape: FeedShape;
  help: string;
  /** Fixed vocabulary, validated before the request is sent. */
  choices?: readonly string[];
  /** Where completion finds values of an open vocabulary. */
  complete?: Completer;
}

const facetList = (facet: FilterOptionsFacet): Completer => ({ kind: "facet", facet, mode: "list" });

/** Shape and help for every feed body key. A key missing here fails the type check. */
export const FEED_FILTERS: Record<JobFeedFilterKey, FeedFilter> = {
  locations: {
    shape: "locations",
    help: 'A structured place: country=…[,region=…][,city=…], or just a country name. Every place needs a country; "country=Remote" matches remote jobs. Find the exact names, ready to paste, with `jobo locations <query>`.',
    complete: { kind: "locations", format: "feed" },
  },
  sources: {
    shape: "list",
    help: "Only these ATS sources, e.g. greenhouse, lever. List them with `jobo filters sources`.",
    complete: facetList("sources"),
  },
  work_models: { shape: "list", help: "Only these work models.", choices: WORK_MODELS },
  employment_types: { shape: "list", help: "Only these employment types.", choices: EMPLOYMENT_TYPES },
  experience_levels: { shape: "list", help: "Only these experience levels.", choices: EXPERIENCE_LEVELS },
  languages: {
    shape: "list",
    help: "Only these description languages, as ISO 639-1 codes (en, de).",
    complete: { kind: "values", values: LANGUAGE_CODES },
  },
  exclude_sources: { shape: "list", help: "Leave out these ATS sources.", complete: facetList("sources") },
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
  exclude_languages: {
    shape: "list",
    help: "Leave out these description languages. Jobs with no language are kept.",
    complete: { kind: "values", values: LANGUAGE_CODES },
  },
  companies: {
    shape: "includeExclude",
    help: "these companies: a Jobo company id, a website domain (fedex.com) or a whole company name. Look up ids with `jobo companies <name>`.",
    complete: { kind: "companies" },
  },
  job_categories: {
    shape: "includeExclude",
    help: "these occupation categories, e.g. Healthcare. List them with `jobo filters job_categories`.",
    complete: facetList("job_categories"),
  },
  job_subcategories: {
    shape: "includeExclude",
    help: "these occupation subcategories, e.g. Nursing. List them with `jobo filters job_subcategories`.",
    complete: facetList("job_subcategories"),
  },
  occupation_ids: {
    shape: "includeExclude",
    help: "these occupation ids (ids, not names). Find them with `jobo filters occupations <query>`.",
  },
  industries: {
    shape: "includeExclude",
    help: 'companies in these industries, matched on the whole name, e.g. "Software Development". List them with `jobo filters industries`.',
    complete: facetList("industries"),
  },
  company_primary_industries: {
    shape: "includeExclude",
    // A vocabulary of its own (broader labels than `industries`), with no lookup endpoint: nothing to complete from.
    help: "companies whose one primary industry is among these, e.g. Finance. It is the `primary_industry` that `jobo company <id>` shows: a broader label than --industries takes.",
  },
  company_categories: {
    shape: "includeExclude",
    help: "companies with these business models, e.g. b2b, saas. List them with `jobo filters company_categories`.",
    complete: { kind: "values", values: COMPANY_CATEGORIES },
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

function feedListSpec(key: string, filter: FeedFilter, description: string): OptionSpec {
  const name = flagName(key);
  return {
    type: "string",
    multiple: true,
    ...(splits(key) ? { split: true } : {}),
    // Search spells most of these in the singular; both spellings mean the one flag.
    aliases: [otherNumber(name)],
    value: "value",
    description,
    hint: listHint(key),
    ...(filter.choices ? { choices: filter.choices } : {}),
    ...(filter.complete ? { complete: filter.complete } : {}),
    group: "Filters",
  };
}

export function feedFilterOptions(): OptionSpecs {
  const specs: OptionSpecs = {};
  for (const key of JOB_FEED_FILTER_KEYS) {
    const filter = FEED_FILTERS[key];
    const name = flagName(key);
    switch (filter.shape) {
      case "locations":
        specs[name] = {
          type: "string",
          multiple: true,
          aliases: [otherNumber(name)],
          value: "place",
          description: filter.help,
          hint: "Repeat the flag to match any of several places.",
          ...(filter.complete ? { complete: filter.complete } : {}),
          group: "Filters",
        };
        break;
      case "list":
        specs[name] = feedListSpec(key, filter, filter.help);
        break;
      case "includeExclude":
        specs[name] = feedListSpec(key, filter, `Only ${filter.help}`);
        specs[`exclude-${name}`] = feedListSpec(`exclude_${key}`, filter, `Leave out ${filter.help}`);
        break;
      case "boolean":
        specs[name] = { type: "string", value: "true|false", description: filter.help, choices: BOOLEANS, group: "Filters" };
        break;
      case "dateTime":
        specs[name] = { type: "string", value: "when", description: filter.help, hint: TIME_HINT, group: "Filters" };
        break;
      case "enum":
        specs[name] = {
          type: "string",
          value: "value",
          description: filter.help,
          ...(filter.choices ? { choices: filter.choices } : {}),
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
    // The search flag takes "Berlin, Germany"; here that would be sent as a country and match nothing.
    if (text.includes(",")) {
      throw new UsageError(
        `--locations: "${raw}" is not a country name. The feed takes structured places such as country=Germany,city=Berlin; ` +
          "`jobo locations <query>` prints the exact value to paste.",
      );
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

/** A suggested place as the feed's `--locations` value, or null when it has no country to anchor it. */
export function feedLocation(place: Pick<LocationSuggestion, "city" | "region" | "country">): string | null {
  if (!place.country) return null;
  return LOCATION_LEVELS.flatMap((level) => (place[level] ? [`${level}=${place[level]}`] : [])).join(",");
}

/** A suggested place as free text, for the search `--location` flag. */
export function placeName(place: Pick<LocationSuggestion, "city" | "region" | "country" | "display_name">): string {
  return place.display_name?.trim() || [place.city, place.region, place.country].filter(Boolean).join(", ");
}

/**
 * Read the feed flags into a `POST /api/jobs/feed` body, without paging
 * fields. Values of a fixed set were checked when the arguments were parsed.
 */
export function parseFeedFilters(values: ParsedValues, now: Date): JobFeedParams {
  const body: Record<string, unknown> = {};

  for (const key of JOB_FEED_FILTER_KEYS) {
    const filter = FEED_FILTERS[key];
    const name = flagName(key);
    const label = `--${name}`;

    switch (filter.shape) {
      case "locations": {
        const raw = list(values, name);
        if (raw?.length) body[key] = raw.map(parseLocation);
        break;
      }
      case "list": {
        const raw = list(values, name);
        if (!raw) break;
        const parsed = parseListValues(raw, key);
        if (parsed.length > 0) body[key] = parsed;
        break;
      }
      case "includeExclude": {
        const include = parseListValues(list(values, name) ?? [], key);
        const exclude = parseListValues(list(values, `exclude-${name}`) ?? [], `exclude_${key}`);
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
        if (raw !== undefined) body[key] = raw;
        break;
      }
    }
  }

  return body as JobFeedParams;
}
