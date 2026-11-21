import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/cli";
import { LIVE_KEY, TEST_KEY, harness, job, json } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };

describe("help and version", () => {
  it("prints the version", async () => {
    const h = harness();
    expect(await h.run("--version")).toBe(0);
    expect(h.stdout()).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("lists every command at the top level, with and without --help", async () => {
    for (const argv of [[], ["--help"], ["-h"], ["help"]]) {
      const h = harness();
      expect(await h.run(...argv)).toBe(0);
      for (const command of COMMANDS) expect(h.stdout()).toContain(`  ${command.name}`);
    }
  });

  it.each(COMMANDS.map((command) => command.name))("jobo %s --help needs no key and sends nothing", async (name) => {
    const h = harness();
    expect(await h.run(name, "--help")).toBe(0);
    expect(h.stdout()).toContain(`jobo ${name} — `);
    expect(h.stdout()).toContain("Usage:");
    expect(h.requests).toHaveLength(0);
  });

  it("has help for each skill subcommand", async () => {
    for (const sub of ["install", "path", "show"]) {
      const h = harness();
      expect(await h.run("skill", sub, "--help")).toBe(0);
      expect(h.stdout()).toContain(`jobo skill ${sub} — `);
    }
  });

  it("states the geocode price in its help", async () => {
    const h = harness();
    await h.run("geocode", "--help");
    expect(h.stdout()).toContain("$0.001");
  });

  it("documents every option it parses", () => {
    for (const command of [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])]) {
      for (const [name, spec] of Object.entries(command.options ?? {})) {
        expect(spec.description.length, `${command.name} --${name}`).toBeGreaterThan(10);
      }
    }
  });
});

describe("jobo job", () => {
  it("fetches one listing and prints it as JSON", async () => {
    const h = harness({ env, responder: () => json(200, job("abc")) });
    expect(await h.run("job", "abc")).toBe(0);
    expect(h.requests[0]?.method).toBe("GET");
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/jobs/abc");
    expect((JSON.parse(h.stdout()) as { id: string }).id).toBe("abc");
  });

  it("renders a readable page in a terminal", async () => {
    const h = harness({ env, tty: true, responder: () => json(200, job("abc")) });
    await h.run("job", "abc");
    expect(h.stdout()).toContain("Title         Engineer abc");
    expect(h.stdout()).toContain("Compensation  100000–140000 EUR yearly");
    expect(h.stdout()).toContain("Line one\nLine two");
  });

  it("explains a 404 (exit 6)", async () => {
    const h = harness({ env, responder: () => json(404, { title: "Not Found", status: 404 }) });
    expect(await h.run("job", "nope")).toBe(6);
    expect(h.stderr()).toContain("No job has that id");
  });

  it("needs an id", async () => {
    const h = harness({ env });
    expect(await h.run("job")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("jobo expired", () => {
  it("sends the API's batch_size and expired_since, and prints ids", async () => {
    const h = harness({
      env,
      responder: () => json(200, { job_ids: ["a", "b"], next_cursor: null, has_more: false }),
    });
    expect(await h.run("expired", "--since", "24h", "--limit", "500")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/jobs/expired");
    expect(url.searchParams.get("batch_size")).toBe("500");
    expect(url.searchParams.get("expired_since")).toBe("2026-11-19T12:00:00.000Z");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(JSON.parse(h.stdout())).toEqual({ job_ids: ["a", "b"], has_more: false, next_cursor: null });
  });

  it("walks the cursor up to --limit and prints the next cursor when more remain", async () => {
    const h = harness({
      env,
      responder: (request) => {
        const url = new URL(request.url);
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const size = Number(url.searchParams.get("batch_size"));
        const ids = Array.from({ length: size }, (_, index) => `e${offset + index}`);
        return json(200, { job_ids: ids, next_cursor: String(offset + size), has_more: true });
      },
    });
    expect(await h.run("expired", "--limit", "15000", "--jsonl")).toBe(0);
    expect(h.requests.map((request) => new URL(request.url).searchParams.get("batch_size"))).toEqual(["10000", "5000"]);
    expect(h.stdout().trimEnd().split("\n")).toHaveLength(15000);
    expect(h.stdout().split("\n")[0]).toBe('{"id":"e0"}');
    expect(h.stderr()).toContain("next cursor: 15000");
  });
});

describe("jobo company and companies", () => {
  it("fetches a company without a key, sending no X-Api-Key", async () => {
    const h = harness({ responder: () => json(200, { id: "c1", name: "Acme", industries: ["Software"] }) });
    expect(await h.run("company", "c1")).toBe(0);
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/companies/c1");
    expect(h.requests[0]?.headers).not.toHaveProperty("X-Api-Key");
    expect(h.requests[0]?.headers["X-Jobo-Client"]).toBe("cli");
    expect(JSON.parse(h.stdout())).toMatchObject({ name: "Acme" });
  });

  it("sends the key when one is configured, so a sandbox key gets sandbox companies", async () => {
    const h = harness({ env: { JOBO_API_KEY: TEST_KEY }, responder: () => json(200, { id: "c1", name: "Acme" }) });
    await h.run("company", "c1");
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(TEST_KEY);
  });

  it("explains an unknown company (exit 6)", async () => {
    const h = harness({ responder: () => json(404, { title: "Not Found", status: 404 }) });
    expect(await h.run("company", "nope")).toBe(6);
    expect(h.stderr()).toContain("jobo companies");
  });

  it("suggests companies with their ids", async () => {
    const suggestions = [{ id: "c1", ids: ["c1", "c2"], name: "Stripe", domain: "stripe.com", country: "US", job_count: 412 }];
    const h = harness({ env, tty: true, responder: () => json(200, { suggestions }) });
    expect(await h.run("companies", "stripe", "--limit", "5")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/connectors/companies/suggest");
    expect(url.searchParams.get("q")).toBe("stripe");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.stdout()).toMatch(/Stripe\s+stripe\.com\s+US\s+412\s+c1 c2/);
  });

  it("refuses a one-character query without a request", async () => {
    const h = harness({ env });
    expect(await h.run("companies", "s")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("jobo geocode", () => {
  it("prints the result and the charge", async () => {
    const h = harness({
      env,
      responder: () =>
        json(200, { input: "Berlin", succeeded: true, locations: [{ city: "Berlin", country: "Germany" }] }, { "x-credits-deducted": "1", "x-credits-balance": "4999" }),
    });
    expect(await h.run("geocode", "Berlin")).toBe(0);
    expect(new URL(h.requests[0]?.url ?? "").searchParams.get("location")).toBe("Berlin");
    expect(JSON.parse(h.stdout())).toMatchObject({ succeeded: true });
    expect(h.stderr()).toContain("usage: 1 credits ($0.001) charged");
  });

  it("exits 1 when the place did not resolve, after printing the answer", async () => {
    const h = harness({
      env,
      responder: () => json(200, { input: "2 Locations", succeeded: false, error: "Location string is a placeholder, not a real location." }),
    });
    expect(await h.run("geocode", "2", "Locations")).toBe(1);
    expect(JSON.parse(h.stdout())).toMatchObject({ succeeded: false });
    expect(h.stderr()).toContain("not resolved");
  });
});

describe("jobo filters and occupations", () => {
  const vocabulary = {
    enums: { work_models: ["remote", "hybrid", "onsite"], employment_types: ["full-time"], experience_levels: ["senior"] },
    sources: [{ key: "greenhouse", count: 120000 }, { key: "lever", count: 80000 }],
  };

  it("lists the fixed vocabularies and sources with counts", async () => {
    const h = harness({ env, tty: true, responder: () => json(200, vocabulary) });
    expect(await h.run("filters")).toBe(0);
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/connectors/filters");
    expect(h.stdout()).toContain("--work-model: remote, hybrid, onsite");
    expect(h.stdout()).toMatch(/greenhouse\s+120000/);
    expect(h.stdout()).toContain("jobo filters <facet> [query]");
  });

  it("returns the API response plus the contract vocabularies as JSON", async () => {
    const h = harness({ env, responder: () => json(200, vocabulary) });
    await h.run("filters");
    const parsed = JSON.parse(h.stdout()) as { enums: unknown; sources: unknown[]; contract: { sort: string[] }; facets: string[] };
    expect(parsed.enums).toEqual(vocabulary.enums);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.contract.sort).toEqual(["relevance", "discovered_asc", "discovered_desc"]);
    expect(parsed.facets).toContain("skills");
  });

  it("looks up one open vocabulary", async () => {
    const options = [{ key: "esco:123", count: 900, name: "Registered Nurse", parent: "Nursing" }];
    const h = harness({ env, tty: true, responder: () => json(200, { facet: "occupations", options }) });
    expect(await h.run("filters", "occupations", "registered", "nurse", "--limit", "5")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/connectors/filter-options/occupations");
    expect(url.searchParams.get("q")).toBe("registered nurse");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.stdout()).toMatch(/VALUE\s+NAME\s+PARENT\s+JOBS/);
    expect(h.stdout()).toMatch(/esco:123\s+Registered Nurse\s+Nursing\s+900/);
  });

  it("rejects an unknown facet without a request", async () => {
    const h = harness({ env });
    expect(await h.run("filters", "salaries")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("job_subcategories");
  });

  it("prints the taxonomy nested as JSON and flat as CSV", async () => {
    const taxonomy = {
      version: "v1",
      categories: [
        {
          name: "Healthcare",
          subcategories: [{ name: "Nursing", occupations: [{ id: "esco:123", name: "Registered Nurse", isco_code: "2221", onet_soc_codes: ["29-1141.00"] }] }],
        },
      ],
    };
    const asJson = harness({ env, responder: () => json(200, taxonomy) });
    expect(await asJson.run("occupations")).toBe(0);
    expect(asJson.requests[0]?.url).toBe("https://connect.jobo.world/api/occupations");
    expect(JSON.parse(asJson.stdout())).toEqual(taxonomy);

    const asCsv = harness({ env, responder: () => json(200, taxonomy) });
    await asCsv.run("occupations", "--csv");
    expect(asCsv.stdout()).toBe("category,subcategory,id,name,isco_code,onet_soc_codes\r\nHealthcare,Nursing,esco:123,Registered Nurse,2221,29-1141.00\r\n");
  });

  it("explains that a sandbox key cannot call these (exit 6)", async () => {
    const h = harness({
      env: { JOBO_API_KEY: TEST_KEY },
      responder: () => json(404, { title: "Not available in the sandbox", status: 404, code: "not_available_in_sandbox" }),
    });
    expect(await h.run("occupations")).toBe(6);
    expect(h.stderr()).toContain("sandbox key");
  });
});

describe("jobo usage", () => {
  it("reports the rate-limit position from a free call and never shows the key", async () => {
    const h = harness({
      env,
      tty: true,
      responder: () =>
        json(200, { enums: {}, sources: [] }, { "x-ratelimit-limit": "180", "x-ratelimit-remaining": "177", "x-ratelimit-group": "Default" }),
    });
    expect(await h.run("usage")).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/connectors/filters");
    expect(h.stdout()).toContain("177 of 180 requests left this minute (Default group)");
    expect(h.stdout()).toContain("jbe_live_…bbbb (live, from JOBO_API_KEY)");
    expect(h.stdout()).toContain("https://enterprise.jobo.world/credits");
    expect(h.stdout()).not.toContain(LIVE_KEY);
  });

  it("shows wallet and included-job figures when the response carries them", async () => {
    const h = harness({
      env,
      responder: () => json(200, { enums: {}, sources: [] }, { "x-credits-balance": "4970", "x-quota-limit": "100000", "x-quota-remaining": "99000" }),
    });
    await h.run("usage");
    expect(JSON.parse(h.stdout())).toMatchObject({
      wallet_balance_credits: 4970,
      wallet_balance_usd: 4.97,
      included_jobs: { limit: 100000, remaining: 99000 },
    });
  });

  it("works with a sandbox key, whose refusal still carries the headers", async () => {
    const h = harness({
      env: { JOBO_API_KEY: TEST_KEY },
      responder: () =>
        json(404, { title: "Not available in the sandbox", status: 404, code: "not_available_in_sandbox" }, { "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19", "x-ratelimit-group": "Default" }),
    });
    expect(await h.run("usage")).toBe(0);
    expect(JSON.parse(h.stdout())).toMatchObject({
      environment: "sandbox",
      rate_limit: { limit: 20, remaining: 19, group: "Default" },
      note: "Sandbox keys are never billed and use no included jobs.",
    });
  });
});
