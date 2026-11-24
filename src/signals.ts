/**
 * Hiring Signals: the filter surface of `GET /api/signals`, a label for each
 * type, and one plain sentence per signal.
 *
 * These mirror `HIRING_SIGNAL_FILTERS` (connector-core `signals.ts`) and
 * `SIGNAL_TYPE_LABELS` / `describeSignal` (connector-core `signal-summary.ts`),
 * with the same wording, which is the wording Jobo's dashboard uses. The CLI
 * pins connector-core 0.5.0, which has no signals; once core 0.7.0 is on npm
 * all of this can become imports. `test/signals.test.ts` holds the filter and
 * type lists to `contracts/signals.json`, the file generated from core.
 *
 * Signals are billed per signal returned, at ten times a job, and a signal
 * read again is billed again.
 */

import { COMPANY_SIZES } from "@jobo-ai/connector-core";

/** `type` values, in the API's own order. More may be added: never fail on one this list lacks. */
export const SIGNAL_TYPES = [
  "hiring_surge",
  "new_function",
  "new_country",
  "leadership_hire",
  "new_skill",
  "hiring_slowdown",
  "first_role",
  "new_technology",
  "function_surge",
  "new_city",
  "hard_to_fill",
  "leadership_role_closed",
  "hiring_freeze",
  "hiring_resumed",
] as const;

/** `seniority` values, lowest first. */
export const SIGNAL_SENIORITY = ["junior", "mid", "senior", "director", "vp", "c_level", "executive"] as const;

/** Signals per page: `limit` runs from 1 to this, and defaults to 50. */
export const SIGNAL_MAX_LIMIT = 200;
export const SIGNAL_DEFAULT_LIMIT = 50;

/** The most values one comma-separated filter takes. */
export const SIGNAL_MAX_LIST_VALUES = 100;

/** `date` is a calendar day (`yyyy-MM-dd`); `dateTime` is an instant. */
export type SignalFilterKind = "stringList" | "enumList" | "number" | "boolean" | "date" | "dateTime";

export interface SignalFilterDescriptor {
  /** The query parameter name on `GET /api/signals`. */
  key: string;
  label: string;
  kind: SignalFilterKind;
  description: string;
  /** Present for `enumList`. */
  options?: readonly string[];
  /** True when the filter says which companies or which subjects are wanted. */
  narrowing?: boolean;
  /** True when `GET /api/companies/{id}/signals` takes it too. */
  company?: boolean;
  /** Lowest and highest value the API accepts, for `number`. */
  min?: number;
  max?: number;
}

export const HIRING_SIGNAL_FILTERS: readonly SignalFilterDescriptor[] = [
  {
    key: "types",
    label: "Signal Types",
    kind: "enumList",
    description: "Only these kinds of signal, e.g. hiring_surge, new_country, leadership_hire. Leave empty for every kind.",
    options: SIGNAL_TYPES,
    narrowing: true,
    company: true,
  },
  {
    key: "domains",
    label: "Company Domains",
    kind: "stringList",
    description: 'Only signals at these companies, by website domain, e.g. "stripe.com". At most 100.',
    narrowing: true,
  },
  {
    key: "company_ids",
    label: "Company IDs",
    kind: "stringList",
    description: "Only signals at these companies, by Jobo company id (a GUID). At most 100.",
    narrowing: true,
  },
  {
    key: "exclude_domains",
    label: "Exclude Company Domains",
    kind: "stringList",
    description: "Leave out these companies, by website domain, e.g. your existing customers. At most 100.",
  },
  {
    key: "countries",
    label: "Company Countries",
    kind: "stringList",
    description: 'Countries the companies are headquartered in, as two-letter codes, e.g. "US", "DE".',
    narrowing: true,
  },
  {
    key: "company_sizes",
    label: "Company Sizes",
    kind: "enumList",
    description: "Headcount bands of the companies.",
    options: COMPANY_SIZES,
    narrowing: true,
  },
  {
    key: "industries",
    label: "Industries",
    kind: "stringList",
    description:
      "Industries of the companies, matched against the primary industry and the industry list. A value cannot contain a comma.",
    narrowing: true,
  },
  {
    key: "categories",
    label: "Company Categories",
    kind: "stringList",
    description: "Company categories, as returned in company.categories, e.g. SaaS.",
    narrowing: true,
  },
  {
    key: "funding_stages",
    label: "Funding Stages",
    kind: "stringList",
    description: 'Latest funding round of the companies, as returned in company.funding_stage, e.g. "Seed", "Series A".',
    narrowing: true,
  },
  {
    key: "founded_after",
    label: "Founded In or After",
    kind: "number",
    description: "Only companies founded in this year or later.",
    min: 1800,
    max: 2100,
  },
  {
    key: "exclude_agencies",
    label: "Exclude Staffing Agencies",
    kind: "boolean",
    description: "Leave out staffing agencies, whose postings are their clients' hiring.",
  },
  {
    key: "functions",
    label: "Functions",
    kind: "stringList",
    description: 'Job categories the signal must be about, e.g. "Technology", "Sales". A focus filter.',
    narrowing: true,
  },
  {
    key: "roles",
    label: "Roles",
    kind: "stringList",
    description:
      'Words or phrases to look for in the job title or occupation behind the signal, e.g. "data engineer". At least 2 characters each. A focus filter.',
    narrowing: true,
  },
  {
    key: "seniority",
    label: "Seniority",
    kind: "enumList",
    description: "Seniority of the role behind the signal. A focus filter.",
    options: SIGNAL_SENIORITY,
    narrowing: true,
  },
  {
    key: "technologies",
    label: "Technologies",
    kind: "stringList",
    description: 'Named tools the signal must be about, e.g. "Snowflake". A focus filter, combined with skills and technology categories.',
    narrowing: true,
  },
  {
    key: "skills",
    label: "Skills",
    kind: "stringList",
    description: "Named skills the signal must be about. A focus filter, combined with technologies.",
    narrowing: true,
  },
  {
    key: "technology_categories",
    label: "Technology Categories",
    kind: "stringList",
    description: 'Every tool in a category, as returned in details.technology_category, e.g. "CRM". A focus filter.',
    narrowing: true,
  },
  {
    key: "job_countries",
    label: "Job Countries",
    kind: "stringList",
    description: "Countries the jobs are in (not the company's headquarters), as two-letter codes. A focus filter.",
    narrowing: true,
  },
  {
    key: "job_regions",
    label: "Job Regions",
    kind: "stringList",
    description: 'States, provinces or regions the jobs are in, e.g. "Texas". A focus filter.',
    narrowing: true,
  },
  {
    key: "job_cities",
    label: "Job Cities",
    kind: "stringList",
    description: 'Cities the jobs are in, e.g. "Austin". A focus filter; only new_city and hard_to_fill record a city.',
    narrowing: true,
  },
  {
    key: "min_strength",
    label: "Minimum Strength",
    kind: "number",
    description: "Only signals at least this strong. Strength runs from 1 to 100 and compares signals of the same type.",
    min: 1,
    max: 100,
    company: true,
  },
  {
    key: "min_new_jobs",
    label: "Minimum New Jobs",
    kind: "number",
    description: "Only hiring_surge and function_surge signals of at least this many new jobs. Other types are not affected.",
    min: 1,
    max: 10_000,
  },
  {
    key: "min_days_open",
    label: "Minimum Days Open",
    kind: "number",
    description: "Only hard_to_fill signals for jobs open at least this many days. Other types are not affected.",
    min: 1,
    max: 365,
  },
  {
    key: "reposted_only",
    label: "Reposted Jobs Only",
    kind: "boolean",
    description: "Only hard_to_fill signals for jobs posted again after closing. Other types are not affected.",
  },
  {
    key: "detected_after",
    label: "Detected On or After",
    kind: "date",
    description: "Earliest detection day, inclusive, as yyyy-MM-dd.",
    company: true,
  },
  {
    key: "detected_before",
    label: "Detected On or Before",
    kind: "date",
    description: "Latest detection day, inclusive, as yyyy-MM-dd.",
    company: true,
  },
  {
    key: "created_after",
    label: "Created After",
    kind: "dateTime",
    description:
      "Only signals first stored after this instant, exclusive. To read what is new, pass the newest created_at already received.",
    company: true,
  },
];

/** Keys `GET /api/companies/{id}/signals` takes; the company is in the path. */
export const COMPANY_SIGNAL_FILTER_KEYS: readonly string[] = HIRING_SIGNAL_FILTERS.filter((filter) => filter.company).map(
  (filter) => filter.key,
);

// ── Signals in words (connector-core `signal-summary.ts`) ────────────────────

/** One signal as the API returns it. Only what the CLI reads is typed; the rest passes through. */
export interface HiringSignal {
  id: string;
  type: string;
  detected_on?: string;
  created_at?: string;
  strength?: number;
  company?: { id?: string; name?: string; domain?: string | null; country_code?: string | null } | null;
  details?: unknown;
  [key: string]: unknown;
}

/** A short name for each signal type, as the dashboard shows it. */
export const SIGNAL_TYPE_LABELS: Readonly<Record<string, string>> = {
  hiring_surge: "Hiring surge",
  new_function: "New function",
  new_country: "New country",
  leadership_hire: "Leadership hire",
  new_skill: "New skill",
  hiring_slowdown: "Hiring slowdown",
  first_role: "First role",
  new_technology: "New technology",
  function_surge: "Function surge",
  new_city: "New city",
  hard_to_fill: "Hard to fill",
  leadership_role_closed: "Leadership role closed",
  hiring_freeze: "Hiring freeze",
  hiring_resumed: "Hiring resumed",
};

/** The label of a type, or the type in words for one added after this was written. */
export function signalTypeLabel(type: string): string {
  const known = SIGNAL_TYPE_LABELS[type];
  if (known) return known;
  const words = String(type ?? "").replace(/_/g, " ").trim();
  return words.length === 0 ? "Signal" : words.charAt(0).toUpperCase() + words.slice(1);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  // Half away from zero, as the API rounds.
  return (Math.sign(value) * Math.round(Math.abs(value) * factor + 1e-9)) / factor;
}

function grouped(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function whole(value: number): string {
  return grouped(String(round(value, 0)));
}

/** At most one decimal, and none when it would be ".0". */
function decimal(value: number): string {
  const [integer = "0", fraction] = String(round(value, 1)).split(".");
  return fraction ? `${grouped(integer)}.${fraction}` : grouped(integer);
}

function counted(count: number, noun: string): string {
  return Math.abs(count - 1) < 0.0001 ? `1 ${noun}` : `${whole(count)} ${noun}s`;
}

function lookback(days: number | null): string {
  if (days == null || days <= 0) return "six months";
  if (days < 60) return `${whole(days)} days`;
  const months = round(days / 30, 0);
  return months === 6 ? "six months" : `${months} months`;
}

/**
 * One plain sentence for a signal, e.g. "17 new jobs this week vs 3.1 a week
 * normally". Falls back to the type's label when `details` lacks the facts
 * the sentence needs, or the type is one this version does not know.
 */
export function describeSignal(signal: Pick<HiringSignal, "type" | "details">): string {
  const type = signal.type;
  const details = signal.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return signalTypeLabel(type);

  const number = (name: string): number | null => {
    const value = (details as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const text = (name: string): string | null => {
    const value = (details as Record<string, unknown>)[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };

  const newJobs = number("new_jobs");
  const period = lookback(number("lookback_days"));

  switch (type) {
    case "hiring_surge": {
      const baseline = number("baseline_weekly_avg");
      if (newJobs == null || baseline == null) break;
      return `${counted(newJobs, "new job")} this week vs ${decimal(baseline)} a week normally`;
    }
    case "hiring_slowdown": {
      const now = number("open_roles");
      const before = number("open_roles_before");
      if (now == null || before == null) break;
      const drop = Math.abs(number("change_pct") ?? 0);
      const day = text("compared_to");
      return `Open roles down ${decimal(drop)}%${day ? ` since ${day}` : ""}: ${whole(now)} now, ${whole(before)} then`;
    }
    case "new_function": {
      const category = text("category");
      if (!category) break;
      return newJobs != null && newJobs > 1
        ? `${counted(newJobs, "new job")} in ${category}, a first in ${period}`
        : `First ${category} job in ${period}`;
    }
    case "new_country": {
      const country = text("country");
      if (!country) break;
      return newJobs != null && newJobs > 1
        ? `${counted(newJobs, "new job")} in ${country}, a first in ${period}`
        : `First job in ${country} in ${period}`;
    }
    case "new_skill": {
      const skill = text("skill");
      if (!skill) break;
      return newJobs != null && newJobs > 1
        ? `${whole(newJobs)} new jobs ask for ${skill}, a first in ${period}`
        : `First job asking for ${skill} in ${period}`;
    }
    case "leadership_hire": {
      const title = text("title");
      if (!title) break;
      return `Hiring a leader: ${title}`;
    }
    case "first_role": {
      const occupation = text("occupation");
      if (!occupation) break;
      return `First ${occupation} role`;
    }
    case "new_technology": {
      const technology = text("technology");
      if (!technology) break;
      const role = text("title");
      return role ? `First mention of ${technology}, in a ${role} role` : `First mention of ${technology}`;
    }
    case "function_surge": {
      const category = text("category");
      const usual = number("baseline_avg");
      if (!category || newJobs == null || usual == null) break;
      const days = number("window_days");
      return `${counted(newJobs, `new ${category} job`)} in ${days != null ? `${whole(days)} days` : "two weeks"} vs ${decimal(usual)} normally`;
    }
    case "new_city": {
      const city = text("city");
      if (!city) break;
      const region = text("region");
      const place = region ? `${city}, ${region}` : city;
      return newJobs != null && newJobs > 1 ? `${counted(newJobs, "new job")} in ${place}, a first there` : `First job in ${place}`;
    }
    case "hard_to_fill": {
      const title = text("title");
      const open = number("days_open");
      if (!title || open == null) break;
      const city = text("city");
      const at = city ? ` (${city})` : "";
      if (text("reason") !== "reposted") return `${title}${at} open ${counted(open, "day")}`;
      const closed = number("closed_days");
      return closed != null && closed > 0 ? `${title}${at} re-posted after ${counted(closed, "day")} closed` : `${title}${at} re-posted`;
    }
    // Says the posting ended, never that anyone was hired.
    case "leadership_role_closed": {
      const title = text("title");
      const open = number("days_open");
      if (!title || open == null) break;
      return `${title} search closed after ${counted(open, "day")}`;
    }
    case "hiring_freeze": {
      const removed = number("closed_jobs");
      const had = number("open_roles_before");
      if (removed == null || had == null) break;
      const last = text("closed_to");
      return `${whole(removed)} of ${counted(had, "open role")} removed${last ? ` in the week to ${last}` : ""}`;
    }
    case "hiring_resumed": {
      const gap = number("gap_days");
      if (gap == null) break;
      return `First new job in ${counted(gap, "day")}`;
    }
    default:
      break;
  }

  return signalTypeLabel(type);
}
