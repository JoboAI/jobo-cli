import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { JoboTransportError, type TransportRequest } from "@jobo-ai/connector-core";
import { describe, expect, it } from "vitest";

import { COMPLETE_COMMAND } from "../src/complete";
import {
  COMPANY_SIGNAL_FILTER_KEYS,
  HIRING_SIGNAL_FILTERS,
  SIGNAL_DEFAULT_LIMIT,
  SIGNAL_MAX_LIMIT,
  SIGNAL_MAX_LIST_VALUES,
  SIGNAL_SENIORITY,
  SIGNAL_TYPES,
  SIGNAL_TYPE_LABELS,
  describeSignal,
  signalTypeLabel,
} from "../src/signals";
import { LIVE_KEY, harness, json, type Harness } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };
const COMPANY = "6c1f0a9e-3b7d-4c55-8e21-5a4d9f0b7c33";

function signal(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "hiring_surge",
    detected_on: "2026-11-19",
    created_at: "2026-11-20T02:14:09.1234567Z",
    window_start: "2026-11-13",
    window_end: "2026-11-19",
    strength: 88,
    company: { id: COMPANY, name: "Northwind, Inc.", domain: "northwind.example", country_code: "US", is_agency: false },
    details: { new_jobs: 17, baseline_weekly_avg: 3.1 },
    focus: { functions: ["technology"], topics: [], job_countries: ["US"], job_regions: [], job_cities: [] },
    evidence_job_ids: ["a41c7e02-58b1-4d0f-b6c9-0e2f7d5a1c88"],
    ...overrides,
  };
}

const BILLING = { "x-credits-deducted": "0", "x-quota-limit": "1000", "x-quota-remaining": "990" };

/** A signals endpoint holding `total` signals. The cursor is `c<offset>`; each page holds what `limit` asks for. */
function signals(total: number, headers: Record<string, string> = BILLING) {
  return (request: TransportRequest) => {
    const url = new URL(request.url);
    const offset = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
    const limit = Number(url.searchParams.get("limit") ?? SIGNAL_DEFAULT_LIMIT);
    const count = Math.max(0, Math.min(limit, total - offset));
    const page = Array.from({ length: count }, (_, index) => signal(`s${offset + index + 1}`));
    const next = offset + count;
    return json(200, { signals: page, next_cursor: next < total ? `c${next}` : null, has_more: next < total }, headers);
  };
}

const url = (h: Harness, index = 0) => new URL(h.requests[index]?.url ?? "http://none");
const params = (h: Harness, index = 0) => Object.fromEntries(url(h, index).searchParams);

describe("the local signals contract", () => {
  // Skipped when the generated contract is absent: the public mirror of cli/ carries no contracts/.
  const contractPath = join(__dirname, "..", "..", "contracts", "signals.json");
  it.skipIf(!existsSync(contractPath))("matches contracts/signals.json, filter by filter", () => {
    const repo = JSON.parse(readFileSync(contractPath, "utf8")) as {
      enums: Record<string, string[]>;
      type_labels: Record<string, string>;
      limits: { default_limit: number; max_limit: number; max_list_values: number };
      filters: Array<Record<string, unknown>>;
      company_filter_keys: string[];
    };
    expect([...SIGNAL_TYPES]).toEqual(repo.enums.signal_types);
    expect([...SIGNAL_SENIORITY]).toEqual(repo.enums.seniority);
    expect({ ...SIGNAL_TYPE_LABELS }).toEqual(repo.type_labels);
    expect({ default_limit: SIGNAL_DEFAULT_LIMIT, max_limit: SIGNAL_MAX_LIMIT, max_list_values: SIGNAL_MAX_LIST_VALUES }).toEqual(repo.limits);
    expect([...COMPANY_SIGNAL_FILTER_KEYS]).toEqual(repo.company_filter_keys);
    expect(
      HIRING_SIGNAL_FILTERS.map((filter) => ({
        key: filter.key,
        kind: filter.kind,
        ...(filter.options ? { options: [...filter.options] } : {}),
        ...(filter.narrowing ? { narrowing: true } : {}),
        ...(filter.company ? { company: true } : {}),
        ...(filter.min !== undefined ? { min: filter.min } : {}),
        ...(filter.max !== undefined ? { max: filter.max } : {}),
      })),
    ).toEqual(repo.filters);
  });
});

describe("describeSignal and type labels", () => {
  it("writes the dashboard's sentence, and falls back to the label", () => {
    expect(describeSignal({ type: "hiring_surge", details: { new_jobs: 17, baseline_weekly_avg: 3.1 } })).toBe(
      "17 new jobs this week vs 3.1 a week normally",
    );
    expect(describeSignal({ type: "hard_to_fill", details: { title: "Nurse", days_open: 91, city: "Austin" } })).toBe("Nurse (Austin) open 91 days");
    expect(describeSignal({ type: "leadership_hire", details: {} })).toBe("Leadership hire");
  });

  it("never fails on a type it does not know", () => {
    expect(signalTypeLabel("office_opened")).toBe("Office opened");
    expect(describeSignal({ type: "office_opened", details: { city: "Lisbon" } })).toBe("Office opened");
  });
});

describe("jobo signals: flags to the request", () => {
  it("sends every kind of filter, in the API's spelling, with the default --max of 10 as the page size", async () => {
    const h = harness({ responder: signals(3), env });
    const code = await h.run(
      "signals",
      "--types", "Hiring_Surge,new country",
      "--domains", "stripe.com",
      "--domains", "shopify.com,stripe.com",
      "--company-sizes", "51-200",
      "--funding-stages", "Series A",
      "--founded-after", "2018",
      "--exclude-agencies",
      "--seniority", "Senior",
      "--job-countries", "us",
      "--min-strength", "70",
      "--detected-after", "2026-11-01",
      "--detected-before", "7d",
      "--created-after", "2026-11-12T09:30:00.1234567Z",
      "--json",
    );
    expect(code, h.stderr()).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("GET");
    expect(url(h).pathname).toBe("/api/signals");
    expect(params(h)).toEqual({
      types: "hiring_surge,new_country",
      domains: "stripe.com,shopify.com",
      company_sizes: "51-200",
      funding_stages: "Series A",
      founded_after: "2018",
      exclude_agencies: "true",
      seniority: "senior",
      job_countries: "US",
      min_strength: "70",
      detected_after: "2026-11-01",
      detected_before: "2026-11-13",
      created_after: "2026-11-12T09:30:00.1234567Z",
      limit: "10",
    });
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(LIVE_KEY);
    expect(h.requests[0]?.headers["X-Jobo-Client"]).toBe("cli");
  });

  it("turns an age into an instant for --created-after, and a date into midnight UTC", async () => {
    const h = harness({ responder: signals(0), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--created-after", "24h")).toBe(0);
    expect(params(h).created_after).toBe("2026-11-19T12:00:00.000Z");
    expect(await h.run("signals", "--domains", "stripe.com", "--created-after", "2026-11-12")).toBe(0);
    expect(params(h, 1).created_after).toBe("2026-11-12T00:00:00Z");
  });

  it("reads one company from its own endpoint", async () => {
    const h = harness({ responder: signals(2), env });
    expect(await h.run("signals", "--company-id", COMPANY.toUpperCase(), "--types", "leadership_hire", "--min-strength", "40")).toBe(0);
    expect(url(h).pathname).toBe(`/api/companies/${COMPANY}/signals`);
    expect(params(h)).toEqual({ types: "leadership_hire", min_strength: "40", limit: "10" });
  });

  it("refuses the filters the per-company endpoint does not take, naming each, before any request", async () => {
    const h = harness({ responder: signals(2), env });
    expect(await h.run("signals", "--company-id", COMPANY, "--domains", "stripe.com", "--exclude-agencies", "--types", "hiring_surge")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("does not take --domains, --exclude-agencies.");
    expect(h.stderr()).toContain("It takes only --types, --min-strength, --detected-after, --detected-before, --created-after.");
    expect(h.stderr()).toContain("--company-ids");
  });

  it("refuses a company id that is not a GUID, before any request", async () => {
    const h = harness({ responder: signals(2), env });
    expect(await h.run("signals", "--company-id", "stripe.com")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--company-id takes a Jobo company id (a GUID)");
  });
});

describe("jobo signals: --max", () => {
  it("walks pages until --max, and no page asks for more than is still wanted", async () => {
    const h = harness({ responder: signals(1000), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--max", "250", "--jsonl")).toBe(0);
    expect(h.requests.map((_, index) => [params(h, index).limit, params(h, index).cursor])).toEqual([
      ["200", undefined],
      ["50", "c200"],
    ]);
    expect(h.requests.every((_, index) => params(h, index).domains === "stripe.com")).toBe(true);
    expect(h.stdout().split("\n").filter(Boolean)).toHaveLength(250);
    expect(h.stderr()).toContain("cost: reads at most 250 signals (--max 250).");
    expect(h.stderr()).toContain("more remain. next cursor: c250");
  });

  it("says the default plainly, and stops when the API has no more", async () => {
    const h = harness({ responder: signals(4), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--jsonl")).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.stderr()).toContain("cost: reads at most 10 signals (the default; --max N for more).");
    expect(h.stderr()).toContain("ten times the price of a job");
    expect(h.stderr()).toContain("a signal read again is billed again");
    expect(h.stderr()).toContain("4 signals read in 1 request.");
    expect(h.stderr()).not.toContain("next cursor");
  });

  it("reads on from --cursor", async () => {
    const h = harness({ responder: signals(30), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--cursor", "c20", "--jsonl")).toBe(0);
    expect(params(h).cursor).toBe("c20");
    expect(h.stdout().split("\n").filter(Boolean)).toHaveLength(10);
  });

  it("has no --all", async () => {
    const h = harness({ responder: signals(4), env });
    expect(await h.run("signals", "--all")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("jobo signals: refused before any request", () => {
  const cases: Array<[string[], string]> = [
    [["--types", "hiring_surg"], '--types: unknown value "hiring_surg". Did you mean "hiring_surge"?'],
    [["--seniority", "boss"], "--seniority: unknown value"],
    [["--company-sizes", "50-200"], "--company-sizes: unknown value"],
    [["--min-strength", "0"], "--min-strength must be 1–100, got 0."],
    [["--founded-after", "1700"], "--founded-after must be 1800–2100"],
    [["--min-days-open", "x"], "--min-days-open takes a whole number"],
    [["--detected-after", "2026-11-01T00:00:00Z"], "--detected-after takes a day as yyyy-MM-dd"],
    [["--detected-before", "2026-02-31"], "--detected-before: 2026-02-31 is not a real date."],
    [["--created-after", "2026-11-12T09:30Z"], "--created-after takes an ISO 8601 date and time with seconds"],
    [["--created-after", "2026-11-12T25:00:00Z"], "is not a real date and time"],
    [["--detected-after", "2026-11-10", "--detected-before", "2026-11-01"], "--detected-after is later than --detected-before"],
    [["--company-ids", "stripe.com"], '--company-ids: "stripe.com" is not a company id'],
    [["--job-countries", "Germany"], "is not a two-letter country code"],
    [["--roles", "x"], "at least 2 characters"],
    [["--domains", Array.from({ length: 101 }, (_, index) => `c${index}.com`).join(",")], "--domains takes at most 100 values; 101 were given."],
    [["--max", "0"], "--max must be 1 or more"],
    [["stripe"], "jobo signals takes no arguments"],
  ];

  it.each(cases)("%j", async (argv, message) => {
    const h = harness({ responder: signals(4), env });
    expect(await h.run("signals", ...argv)).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain(message);
  });
});

describe("jobo signals: output", () => {
  it("adds type_label and summary to every record in JSON, with the cursor", async () => {
    const h = harness({ responder: signals(30), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--max", "2", "--json")).toBe(0);
    const document = JSON.parse(h.stdout()) as { signals: Array<Record<string, unknown>>; next_cursor: string; has_more: boolean };
    expect(document.signals).toHaveLength(2);
    expect(document.signals[0]).toMatchObject({
      id: "s1",
      type: "hiring_surge",
      type_label: "Hiring surge",
      summary: "17 new jobs this week vs 3.1 a week normally",
      created_at: "2026-11-20T02:14:09.1234567Z",
    });
    expect(document.next_cursor).toBe("c2");
    expect(document.has_more).toBe(true);
  });

  it("writes JSONL and CSV with the added fields", async () => {
    const jsonl = harness({ responder: signals(2), env });
    expect(await jsonl.run("signals", "--domains", "stripe.com", "--jsonl")).toBe(0);
    const first = JSON.parse(jsonl.stdout().split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(first.type_label).toBe("Hiring surge");
    expect(first.summary).toBe("17 new jobs this week vs 3.1 a week normally");

    const csv = harness({ responder: signals(1), env });
    expect(await csv.run("signals", "--domains", "stripe.com", "--csv")).toBe(0);
    const [header, row] = csv.stdout().split("\r\n");
    expect(header).toBe(
      "id,type,type_label,detected_on,created_at,strength,company.id,company.name,company.domain,company.country_code,summary,evidence_job_ids",
    );
    expect(row).toContain('s1,hiring_surge,Hiring surge,2026-11-19,2026-11-20T02:14:09.1234567Z,88,');
    expect(row).toContain('"Northwind, Inc."');
    expect(row).toContain("17 new jobs this week vs 3.1 a week normally");
  });

  it("shows a table in a terminal: day, company, type, strength and the sentence", async () => {
    const h = harness({ responder: signals(1), env, tty: true, columns: 160 });
    expect(await h.run("signals", "--domains", "stripe.com")).toBe(0);
    const [head, row] = h.stdout().split("\n");
    expect(head).toMatch(/^DETECTED\s+COMPANY\s+TYPE\s+STRENGTH\s+SUMMARY$/);
    expect(row).toMatch(/^2026-11-19\s+Northwind, Inc\.\s+Hiring surge\s+88\s+17 new jobs this week vs 3\.1 a week normally$/);
  });

  it("shows an unknown type by its name instead of failing", async () => {
    const h = harness({ responder: () => json(200, { signals: [signal("x1", { type: "office_opened", details: {} })], has_more: false }), env });
    expect(await h.run("signals", "--domains", "stripe.com", "--jsonl")).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({ type: "office_opened", type_label: "Office opened", summary: "Office opened" });
  });

  it("writes to a file with -o", async () => {
    const h = harness({ responder: signals(3), env });
    expect(await h.run("signals", "--domains", "stripe.com", "-o", "signals.jsonl")).toBe(0);
    expect(readFileSync(join(h.cwd, "signals.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("prints the usage line: credits and included signals left", async () => {
    const h = harness({
      responder: signals(2, { "x-credits-deducted": "60", "x-credits-balance": "9940", "x-quota-limit": "1000", "x-quota-remaining": "0" }),
      env,
    });
    expect(await h.run("signals", "--domains", "stripe.com", "--jsonl")).toBe(0);
    expect(h.stderr()).toContain("page 1: 2 signals · 60 credits ($0.06) charged · wallet 9,940 credits ($9.94) · included signals left 0 of 1,000");
  });

  it("writes the signals fetched before a failure, marked partial, and says where to read on", async () => {
    const h = harness({
      responder: (request, index) => (index === 0 ? signals(500)(request) : json(500, { detail: "boom" })),
      env,
    });
    expect(await h.run("signals", "--domains", "stripe.com", "--max", "300", "--json")).toBe(7);
    const document = JSON.parse(h.stdout()) as { signals: unknown[]; partial?: boolean };
    expect(document.signals).toHaveLength(200);
    expect(document.partial).toBe(true);
    expect(h.stderr()).toContain("200 signals from 1 page were read and billed before the error");
    expect(h.stderr()).toContain("--cursor c200");
  });
});

describe("jobo signals: errors", () => {
  const run = async (status: number, body: unknown, headers: Record<string, string> = {}, ...argv: string[]) => {
    const h = harness({ responder: () => json(status, body, headers), env });
    const code = await h.run("signals", "--domains", "stripe.com", ...argv);
    return { h, code };
  };

  it("402: nothing charged, and a smaller --max asks for less", async () => {
    const { h, code } = await run(402, { detail: "Insufficient credits", top_up_url: "https://pay.example/top-up" }, {}, "--max", "40");
    expect(code).toBe(4);
    expect(h.stderr()).toContain("cannot cover a page of 40 signals: nothing was charged or returned. Top up: https://pay.example/top-up.");
  });

  it("403 account_key_required: a key that belongs to no account", async () => {
    const { h, code } = await run(403, { code: "account_key_required", detail: "Hiring Signals is charged per signal…" });
    expect(code).toBe(3);
    expect(h.stderr()).toContain("this key belongs to no account");
  });

  it("404 not_available_in_sandbox", async () => {
    const { h, code } = await run(404, { code: "not_available_in_sandbox" });
    expect(code).toBe(6);
    expect(h.stderr()).toContain("not available with a sandbox key");
  });

  it("429: retried after the wait the API asks for, then reported with the limits", async () => {
    const { h, code } = await run(429, { detail: "Too many requests" }, { "retry-after": "7" });
    expect(code).toBe(5);
    expect(h.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([7000, 7000]);
    expect(h.stderr()).toContain("Retry in 7s.");
    expect(h.stderr()).toContain("20 requests a minute, 200 an hour and 1,000 a day");
  });

  it("400: the API's own words", async () => {
    const { h, code } = await run(400, { detail: "cursor is not valid." });
    expect(code).toBe(1);
    expect(h.stderr()).toContain("The API rejected the request: cursor is not valid.");
  });
});

describe("jobo signals: a lost answer is never sent again", () => {
  it("a 500 is not retried", async () => {
    const h = harness({ responder: () => json(500, { detail: "boom" }), env });
    expect(await h.run("signals", "--domains", "stripe.com")).toBe(7);
    expect(h.requests).toHaveLength(1);
    expect(h.stderr()).toContain("was not sent again, because the page may have been billed");
  });

  it("a 502 or 503 is not retried either", async () => {
    for (const status of [502, 503, 504]) {
      const h = harness({ responder: () => json(status, { detail: "gateway" }, { "retry-after": "1" }), env });
      expect(await h.run("signals", "--domains", "stripe.com")).toBe(7);
      expect(h.requests, String(status)).toHaveLength(1);
    }
  });

  it("a timeout or a dropped connection is not retried", async () => {
    for (const message of ["the request timed out after 30s", "socket hang up"]) {
      const h = harness({
        responder: () => {
          throw new JoboTransportError(message);
        },
        env,
      });
      expect(await h.run("signals", "--domains", "stripe.com")).toBe(7);
      expect(h.requests).toHaveLength(1);
      expect(h.stderr()).toContain("The request was not sent again");
      expect(h.stderr()).toContain("jobo usage");
    }
  });

  it("a 200 that is not JSON is reported, not resent", async () => {
    const h = harness({ responder: () => ({ status: 200, headers: {}, body: "<html>" }), env });
    expect(await h.run("signals", "--domains", "stripe.com")).toBe(7);
    expect(h.requests).toHaveLength(1);
  });
});

describe("jobo signals: completion", () => {
  async function candidates(h: Harness, ...words: string[]): Promise<string[]> {
    const before = h.stdout().length;
    expect(await h.run(COMPLETE_COMMAND, "--", ...words)).toBe(0);
    return h.stdout().slice(before).split("\n").filter(Boolean);
  }

  it("completes the command, its flags and the fixed values", async () => {
    const h = harness();
    expect(await candidates(h, "sig")).toEqual(["signals"]);
    expect(await candidates(h, "signals", "--min-")).toEqual(["--min-strength", "--min-new-jobs", "--min-days-open"]);
    expect(await candidates(h, "signals", "--types", "hiring")).toEqual(["hiring_surge", "hiring_slowdown", "hiring_freeze", "hiring_resumed"]);
    expect(await candidates(h, "signals", "--seniority", "")).toEqual([...SIGNAL_SENIORITY]);
    expect(await candidates(h, "signals", "--company-sizes", "5")).toEqual(["51-200", "501-1000", "5001-10000"]);
    expect(h.requests).toHaveLength(0);
  });
});

describe("jobo signals --help", () => {
  it("says what a signal is, what it costs, and how to read only what is new", async () => {
    const h = harness();
    expect(await h.run("signals", "--help")).toBe(0);
    const help = h.stdout().replace(/\s+/g, " ");
    expect(help).toContain("A hiring signal is one event at one company, detected from its job postings");
    expect(help).toContain("each signal returned is billed at ten times the price of a job");
    expect(help).toContain("A signal read again is billed again.");
    expect(help).toContain("minus five minutes, as --created-after");
    expect(help).toContain("--types <LIST>");
  });
});
