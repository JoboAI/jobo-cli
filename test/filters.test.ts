import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JOB_FEED_FILTER_KEYS, JOB_SEARCH_FILTERS } from "@jobo-ai/connector-core";
import { describe, expect, it } from "vitest";

import { feedCommand } from "../src/commands/feed";
import { searchCommand } from "../src/commands/search";
import { FEED_FILTERS, FILTER_FACETS, NO_COMMA_SPLIT, flagName, parseLocation, parseTime } from "../src/filters";
import { LIVE_KEY, harness, json, searchPage } from "./helpers";

const empty = () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 }));

/**
 * One proof per contract filter: these arguments must produce this part of the
 * `POST /api/jobs/search` body. The drift guard below fails when the contract
 * has a filter with no entry here, so a new filter cannot ship unproven.
 */
const SEARCH_SAMPLES: Record<string, { argv: string[]; body: Record<string, unknown> }> = {
  q: { argv: ["--q", "data engineer"], body: { queries: ["data engineer"] } },
  location: { argv: ["--location", "Berlin, Germany"], body: { locations: ["Berlin, Germany"] } },
  sources: { argv: ["--sources", "greenhouse,lever_co"], body: { sources: ["greenhouse", "lever_co"] } },
  companies: { argv: ["--companies", "stripe.com"], body: { companies: { include: ["stripe.com"] } } },
  exclude_companies: {
    argv: ["--exclude-companies", "Acme, Inc."],
    body: { companies: { exclude: ["Acme, Inc."] } },
  },
  work_model: { argv: ["--work-model", "remote,hybrid"], body: { work_models: ["remote", "hybrid"] } },
  employment_type: { argv: ["--employment-type", "full-time"], body: { employment_types: ["full-time"] } },
  experience_level: { argv: ["--experience-level", "senior,lead"], body: { experience_levels: ["senior", "lead"] } },
  language: { argv: ["--language", "en,de"], body: { languages: ["en", "de"] } },
  skills: { argv: ["--skills", "Python,Kubernetes"], body: { skills: { include: ["Python", "Kubernetes"] } } },
  exclude_skills: { argv: ["--exclude-skills", "PHP"], body: { skills: { exclude: ["PHP"] } } },
  industries: {
    argv: ["--industries", "Software Development"],
    body: { industries: { include: ["Software Development"] } },
  },
  exclude_industries: { argv: ["--exclude-industries", "Gambling"], body: { industries: { exclude: ["Gambling"] } } },
  company_categories: {
    argv: ["--company-categories", "b2b,saas"],
    body: { company_categories: { include: ["b2b", "saas"] } },
  },
  exclude_company_categories: {
    argv: ["--exclude-company-categories", "agency"],
    body: { company_categories: { exclude: ["agency"] } },
  },
  job_categories: { argv: ["--job-categories", "Healthcare"], body: { job_categories: { include: ["Healthcare"] } } },
  exclude_job_categories: {
    argv: ["--exclude-job-categories", "Healthcare"],
    body: { job_categories: { exclude: ["Healthcare"] } },
  },
  job_subcategories: {
    argv: ["--job-subcategories", "Film, TV & Stage Production"],
    body: { job_subcategories: { include: ["Film, TV & Stage Production"] } },
  },
  exclude_job_subcategories: {
    argv: ["--exclude-job-subcategories", "Nursing"],
    body: { job_subcategories: { exclude: ["Nursing"] } },
  },
  occupation_ids: {
    argv: ["--occupation-ids", "jobo:backend-developer"],
    body: { occupation_ids: { include: ["jobo:backend-developer"] } },
  },
  exclude_occupation_ids: {
    argv: ["--exclude-occupation-ids", "jobo:backend-developer"],
    body: { occupation_ids: { exclude: ["jobo:backend-developer"] } },
  },
  min_salary_usd: { argv: ["--min-salary-usd", "120000"], body: { salary_usd: { min: 120000 } } },
  max_salary_usd: { argv: ["--max-salary-usd", "200000"], body: { salary_usd: { max: 200000 } } },
  posted_after: { argv: ["--posted-after", "2026-11-01T00:00:00Z"], body: { posted_after: "2026-11-01T00:00:00Z" } },
  posted_before: { argv: ["--posted-before", "2026-11-15"], body: { posted_before: "2026-11-15" } },
  discovered_after: {
    argv: ["--discovered-after", "2026-11-01T00:00:00Z"],
    body: { discovered_after: "2026-11-01T00:00:00Z" },
  },
  discovered_before: {
    argv: ["--discovered-before", "2026-11-02T00:00:00Z"],
    body: { discovered_before: "2026-11-02T00:00:00Z" },
  },
  search_description: { argv: ["--search-description", "false"], body: { search_description: false } },
  sort: { argv: ["--sort", "discovered_asc"], body: { sort: "discovered_asc" } },
  description_format: { argv: ["--description-format", "html"], body: { description_format: "html" } },
};

describe("search flags cover the shared filter contract", () => {
  const contractKeys = JOB_SEARCH_FILTERS.map((filter) => filter.key);

  it("has a proven flag for every contract filter (drift guard)", () => {
    const unproven = contractKeys.filter((key) => !(key in SEARCH_SAMPLES));
    expect(unproven, `contract filters with no flag→body sample: ${unproven.join(", ")}`).toEqual([]);
    const stale = Object.keys(SEARCH_SAMPLES).filter((key) => !contractKeys.includes(key));
    expect(stale, `samples for filters the contract no longer has: ${stale.join(", ")}`).toEqual([]);
  });

  it("exposes each filter as the kebab-case flag of its key", () => {
    const flags = Object.keys(searchCommand.options ?? {});
    for (const key of contractKeys) expect(flags, `missing --${flagName(key)}`).toContain(flagName(key));
  });

  it("has no filter flag outside the contract", () => {
    const contractFlags = new Set(contractKeys.map(flagName));
    const extra = Object.entries(searchCommand.options ?? {})
      .filter(([, spec]) => spec.group === "Filters")
      .map(([name]) => name)
      .filter((name) => !contractFlags.has(name));
    expect(extra).toEqual([]);
  });

  it.each(Object.entries(SEARCH_SAMPLES))("--%s reaches the request body", async (_key, sample) => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("search", ...sample.argv)).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("POST");
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/jobs/search");
    expect(h.body()).toMatchObject(sample.body);
  });

  it("names only contract filters in NO_COMMA_SPLIT, or feed include/exclude keys", () => {
    const known = new Set([...contractKeys, ...JOB_FEED_FILTER_KEYS, ...JOB_FEED_FILTER_KEYS.map((key) => `exclude_${key}`)]);
    for (const key of NO_COMMA_SPLIT) expect(known.has(key), key).toBe(true);
  });

  it("serves a lookup facet for every open vocabulary", () => {
    for (const filter of JOB_SEARCH_FILTERS) {
      if (!filter.dynamicOptions || filter.dynamicOptions === "companies") continue;
      expect(FILTER_FACETS).toContain(filter.dynamicOptions);
    }
  });

  // Skipped where the generated contract is absent (the public mirror of cli/ has no ../contracts).
  it.skipIf(!existsSync(join(__dirname, "..", "..", "contracts", "filters.json")))(
    "the pinned connector-core matches the repo's contracts/filters.json",
    () => {
      const contract = JSON.parse(readFileSync(join(__dirname, "..", "..", "contracts", "filters.json"), "utf8")) as {
        search_filters: Array<{ key: string }>;
        feed_filter_keys: string[];
      };
      expect(contractKeys, "bump the pinned @jobo-ai/connector-core").toEqual(contract.search_filters.map((f) => f.key));
      expect([...JOB_FEED_FILTER_KEYS]).toEqual(contract.feed_filter_keys);
    },
  );
});

describe("search flag → request body", () => {
  it("nests an include/exclude pair into one object", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    await h.run("search", "--skills", "Python,Go", "--exclude-skills", "PHP", "--exclude-skills", "Perl");
    expect(h.body().skills).toEqual({ include: ["Python", "Go"], exclude: ["PHP", "Perl"] });
    // A flat key would bind nothing on the API.
    expect(h.body()).not.toHaveProperty("exclude_skills");
  });

  it("merges a repeated, comma-separated list flag and drops duplicates", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    await h.run("search", "--work-model", "remote,hybrid", "--work-model", "onsite", "--work-model", "remote");
    expect(h.body().work_models).toEqual(["remote", "hybrid", "onsite"]);
  });

  it("keeps commas inside names: one value per flag", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    await h.run("search", "--companies", "Acme, Inc.", "--companies", "stripe.com");
    expect(h.body().companies).toEqual({ include: ["Acme, Inc.", "stripe.com"] });
  });

  it("takes the query as an argument, sends paging, and leaves defaults out", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    await h.run("search", "nurse", "--sort", "relevance", "--search-description", "true");
    expect(h.body()).toEqual({ queries: ["nurse"], page: 1, page_size: 10 });
  });

  it("refuses the query given twice", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("search", "nurse", "--q", "doctor")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("turns an age into a timestamp before now", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY }, now: new Date("2026-11-20T12:00:00.000Z") });
    await h.run("search", "--posted-after", "7d", "--discovered-after", "24h");
    expect(h.body()).toMatchObject({
      posted_after: "2026-11-13T12:00:00.000Z",
      discovered_after: "2026-11-19T12:00:00.000Z",
    });
  });

  it("rejects an unknown value of a fixed vocabulary before sending anything", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("search", "--experience-level", "senior level")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("Valid values: intern, entry, mid, senior, lead, executive");
  });

  it.each([
    ["--sort", "newest"],
    ["--min-salary-usd", "lots"],
    ["--search-description", "maybe"],
    ["--posted-after", "last week"],
    ["--page-size", "500"],
    ["--include-fields", "everything"],
  ])("rejects %s %s as a usage error, unsent", async (name, value) => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("search", name, value)).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("accepts a language code outside the picker list", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("search", "--language", "is")).toBe(0);
    expect(h.body().languages).toEqual(["is"]);
  });

  it("maps --include-fields and --facets, with none as the empty list", async () => {
    const h = harness({ responder: empty, env: { JOBO_API_KEY: LIVE_KEY } });
    await h.run("search", "--include-fields", "none", "--facets", "work_model,sources");
    expect(h.body()).toMatchObject({ include_fields: [], include_facets: ["work_model", "sources"] });
  });
});

describe("feed flags cover the feed contract", () => {
  it("knows the shape of every feed body key (drift guard)", () => {
    expect(Object.keys(FEED_FILTERS).sort()).toEqual([...JOB_FEED_FILTER_KEYS].sort());
  });

  it("exposes every feed key as a flag, with an exclude twin for include/exclude filters", () => {
    const flags = Object.keys(feedCommand.options ?? {});
    for (const key of JOB_FEED_FILTER_KEYS) {
      expect(flags, `missing --${flagName(key)}`).toContain(flagName(key));
      if (FEED_FILTERS[key].shape === "includeExclude") expect(flags).toContain(`exclude-${flagName(key)}`);
    }
  });

  it("builds the feed body from flags", async () => {
    const h = harness({
      responder: () => json(200, { jobs: [], next_cursor: null, has_more: false }),
      env: { JOBO_API_KEY: LIVE_KEY },
    });
    const code = await h.run(
      "feed",
      "--max",
      "50",
      "--locations",
      "country=United States,region=California",
      "--locations",
      "Remote",
      "--sources",
      "greenhouse,lever",
      "--exclude-employment-types",
      "internship",
      "--companies",
      "fedex.com",
      "--exclude-companies",
      "Acme, Inc.",
      "--job-subcategories",
      "Nursing",
      "--company-sizes",
      "201-500,501-1000",
      "--company-is-agency",
      "false",
      "--updated-after",
      "24h",
      "--description-format",
      "html",
    );
    expect(code).toBe(0);
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/jobs/feed");
    expect(h.body()).toEqual({
      locations: [{ country: "United States", region: "California" }, { country: "Remote" }],
      sources: ["greenhouse", "lever"],
      exclude_employment_types: ["internship"],
      companies: { include: ["fedex.com"], exclude: ["Acme, Inc."] },
      job_subcategories: { include: ["Nursing"] },
      company_sizes: { include: ["201-500", "501-1000"] },
      company_is_agency: false,
      updated_after: "2026-11-19T12:00:00.000Z",
      description_format: "html",
      batch_size: 50,
    });
  });

  it("rejects an unknown company size band before sending", async () => {
    const h = harness({ env: { JOBO_API_KEY: LIVE_KEY } });
    expect(await h.run("feed", "--max", "10", "--company-sizes", "huge")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("value parsers", () => {
  it("parses structured locations and keeps commas inside a value", () => {
    expect(parseLocation("Germany")).toEqual({ country: "Germany" });
    expect(parseLocation("country=United States, city=Washington, D.C.")).toEqual({
      country: "United States",
      city: "Washington, D.C.",
    });
    expect(() => parseLocation("city=Berlin")).toThrow(/needs a country/);
    expect(() => parseLocation("state=Texas")).toThrow(/unknown level/);
  });

  it("passes ISO timestamps through untouched and rejects prose", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    expect(parseTime("2026-11-01", "--since", now)).toBe("2026-11-01");
    expect(parseTime("2w", "--since", now)).toBe("2026-11-06T00:00:00.000Z");
    expect(() => parseTime("yesterday", "--since", now)).toThrow(/ISO 8601/);
  });
});
