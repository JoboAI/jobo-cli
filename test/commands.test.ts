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

  /** `total` expired ids, served `batch_size` at a time; the cursor is the offset. */
  function expiredIds(total: number) {
    return (request: { url: string }) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const size = Number(url.searchParams.get("batch_size"));
      const count = Math.min(size, total - offset);
      const ids = Array.from({ length: count }, (_, index) => `e${offset + index}`);
      const next = offset + count;
      return json(200, { job_ids: ids, next_cursor: next < total ? String(next) : null, has_more: next < total });
    };
  }

  it("walks every page by default: a list cut short would leave closed jobs live", async () => {
    const h = harness({ env, responder: expiredIds(23_456) });
    expect(await h.run("expired", "--jsonl")).toBe(0);
    expect(h.requests.map((request) => new URL(request.url).searchParams.get("batch_size"))).toEqual(["10000", "10000", "10000"]);
    expect(h.stdout().trimEnd().split("\n")).toHaveLength(23_456);
    expect(h.stderr()).toContain("23,456 expired job ids.");
    expect(h.stderr()).not.toContain("more remain");
  });

  it("still accepts --all, which is now the default, and refuses it with --limit", async () => {
    const all = harness({ env, responder: expiredIds(1500) });
    expect(await all.run("expired", "--all", "--json")).toBe(0);
    expect((JSON.parse(all.stdout()) as { job_ids: string[]; has_more: boolean }).job_ids).toHaveLength(1500);

    const both = harness({ env, responder: expiredIds(1500) });
    expect(await both.run("expired", "--all", "--limit", "10")).toBe(2);
    expect(both.requests).toHaveLength(0);
  });

  // The harness clock reads 2026-11-20T12:00:00Z.
  it.each([
    ["8d", "more than 7 days back"],
    ["2w", "more than 7 days back"],
    ["2026-11-13T11:59:59Z", "more than 7 days back"],
    ["2026-11-12", "more than 7 days back"],
    ["2026-11-20T12:00:01Z", "in the future"],
    ["2027-01-01", "in the future"],
  ])("refuses --since %s before sending anything: it is %s", async (since, reason) => {
    const h = harness({ env });
    expect(await h.run("expired", "--since", since)).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain(`--since ${since} is ${reason}`);
  });

  it("names the earliest start the API accepts", async () => {
    const h = harness({ env });
    await h.run("expired", "--since", "30d");
    expect(h.stderr()).toContain("the earliest start now is 2026-11-13T12:00:00.000Z");
  });

  it.each([
    ["6d", "2026-11-14T12:00:00.000Z"],
    ["2026-11-14", "2026-11-14"],
    ["2026-11-13T12:05:00Z", "2026-11-13T12:05:00Z"],
    // The edge itself would be a moment too old by the time the API reads it: it is pulled in by five minutes.
    ["7d", "2026-11-13T12:05:00.000Z"],
    ["168h", "2026-11-13T12:05:00.000Z"],
    ["1w", "2026-11-13T12:05:00.000Z"],
    ["2026-11-13T12:00:30Z", "2026-11-13T12:05:00.000Z"],
  ])("sends --since %s as %s", async (since, sent) => {
    const h = harness({ env, responder: () => json(200, { job_ids: [], next_cursor: null, has_more: false }) });
    expect(await h.run("expired", "--since", since)).toBe(0);
    expect(new URL(h.requests[0]?.url ?? "").searchParams.get("expired_since")).toBe(sent);
  });
});

describe("jobo company and companies", () => {
  const COMPANY_ID = "b5e6f7a8-1234-5678-9abc-def012345678";

  it("fetches a company without a key, sending no X-Api-Key", async () => {
    const h = harness({ responder: () => json(200, { id: COMPANY_ID, name: "Acme", industries: ["Software"] }) });
    expect(await h.run("company", COMPANY_ID)).toBe(0);
    expect(h.requests[0]?.url).toBe(`https://connect.jobo.world/api/companies/${COMPANY_ID}`);
    expect(h.requests[0]?.headers).not.toHaveProperty("X-Api-Key");
    expect(h.requests[0]?.headers["X-Jobo-Client"]).toBe("cli");
    expect(JSON.parse(h.stdout())).toMatchObject({ name: "Acme" });
  });

  it("sends the key when one is configured, so a sandbox key gets sandbox companies", async () => {
    const h = harness({ env: { JOBO_API_KEY: TEST_KEY }, responder: () => json(200, { id: COMPANY_ID, name: "Acme" }) });
    await h.run("company", COMPANY_ID);
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(TEST_KEY);
  });

  it("explains an unknown company (exit 6)", async () => {
    const h = harness({ responder: () => json(404, { title: "Not Found", status: 404 }) });
    expect(await h.run("company", "0a1b2c3d-4e5f-6789-abcd-ef0123456789")).toBe(6);
    expect(h.stderr()).toContain("jobo companies");
  });

  it.each(["stripe.com", "Stripe", "c1"])("refuses %s as a company id before any request, and names `jobo companies`", async (given) => {
    const h = harness({ env, responder: () => json(404, { title: "Not Found", status: 404 }) });
    expect(await h.run("company", given)).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain(`jobo company takes a company id`);
    expect(h.stderr()).toContain(`\`jobo companies ${given}\``);
    expect(h.stderr()).not.toContain("No company has that id");
  });

  it.each([COMPANY_ID, COMPANY_ID.toUpperCase(), COMPANY_ID.replace(/-/g, ""), `{${COMPANY_ID}}`])(
    "accepts %s as a company id",
    async (given) => {
      const h = harness({ responder: () => json(200, { id: COMPANY_ID, name: "Acme" }) });
      expect(await h.run("company", given)).toBe(0);
      expect(h.requests).toHaveLength(1);
    },
  );

  it("suggests companies with their ids", async () => {
    const suggestions = [{ id: "c1", ids: ["c1", "c2"], name: "Stripe", domain: "stripe.com", country: "US", job_count: 412 }];
    const h = harness({ env, tty: true, responder: () => json(200, { suggestions }) });
    expect(await h.run("companies", "stripe", "--limit", "5")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/connectors/companies/suggest");
    expect(url.searchParams.get("q")).toBe("stripe");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.stdout()).toMatch(/Stripe\s+stripe\.com\s+US\s+412\s+c1,c2/);
  });

  it("prints a --companies line that pastes straight into search and the feed", async () => {
    const ids = ["b5e6f7a8-1234-5678-9abc-def012345678", "0a1b2c3d-4e5f-6789-abcd-ef0123456789"];
    const suggestions = [
      { id: ids[0], ids, name: "Stripe", domain: "stripe.com", country: "US", job_count: 412 },
      { id: "c9", ids: ["c9"], name: "Stripe Press", domain: null, country: "US", job_count: 0 },
    ];
    const h = harness({ env, responder: () => json(200, { suggestions }) });
    expect(await h.run("companies", "stripe")).toBe(0);
    // Piped: stdout is the API's JSON, untouched; the line to paste is a note on stderr.
    expect(JSON.parse(h.stdout())).toEqual({ suggestions });
    const pasted = /--companies (\S+)$/m.exec(h.stderr())?.[1];
    expect(h.stderr()).toContain(`to filter on Stripe (the first match), in search or the feed: --companies ${ids.join(",")}`);

    const search = harness({ env, responder: () => json(200, { jobs: [], total: 0, page: 1, page_size: 10, total_pages: 0, facets: {} }) });
    await search.run("search", "--companies", pasted ?? "");
    expect(search.body().companies).toEqual({ include: ids });

    const feed = harness({ env, responder: () => json(200, { jobs: [], next_cursor: null, has_more: false }) });
    await feed.run("feed", "--max", "1", "--companies", pasted ?? "");
    expect(feed.body().companies).toEqual({ include: ids });
  });

  it("shows every id whole in a narrow terminal, so the cell can be copied", async () => {
    const ids = ["b5e6f7a8-1234-5678-9abc-def012345678", "0a1b2c3d-4e5f-6789-abcd-ef0123456789"];
    const suggestions = [{ id: ids[0], ids, name: "Stripe Payments Europe Limited", domain: "stripe.com", country: "IE", job_count: 412 }];
    const h = harness({ env, tty: true, columns: 80, responder: () => json(200, { suggestions }) });
    await h.run("companies", "stripe");
    expect(h.stdout().trimEnd().split("\n")[1]?.endsWith(ids.join(","))).toBe(true);
  });

  it("prints no --companies line when nothing matched, or with --quiet", async () => {
    const none = harness({ env, responder: () => json(200, { suggestions: [] }) });
    await none.run("companies", "zzzz");
    expect(none.stderr()).toBe("");

    const quiet = harness({ env, responder: () => json(200, { suggestions: [{ id: "c1", ids: ["c1"], name: "Stripe", domain: "stripe.com" }] }) });
    await quiet.run("companies", "stripe", "--quiet");
    expect(quiet.stderr()).toBe("");
  });

  it("refuses a one-character query without a request", async () => {
    const h = harness({ env });
    expect(await h.run("companies", "s")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("jobo locations", () => {
  const suggestions = [
    { city: "Berlin", region: "Berlin", country: "Germany", latitude: 52.52, longitude: 13.4, display_name: "Berlin, Berlin, Germany", country_code: "DE" },
    { city: "New Berlin", region: "Wisconsin", country: "United States", latitude: 42.97, longitude: -88.1, display_name: "New Berlin, Wisconsin, United States", country_code: "US" },
    { city: null, region: null, country: null, latitude: null, longitude: null, display_name: "Berlin Seamount", country_code: null },
  ];

  it("looks places up for free and prints the feed's --locations value beside each", async () => {
    const h = harness({ env, tty: true, columns: 160, responder: () => json(200, { suggestions }) });
    expect(await h.run("locations", "berlin", "--limit", "3")).toBe(0);
    expect(h.requests).toHaveLength(1);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(h.requests[0]?.method).toBe("GET");
    expect(url.pathname).toBe("/api/connectors/locations/suggest");
    expect(url.searchParams.get("q")).toBe("berlin");
    expect(url.searchParams.get("limit")).toBe("3");

    const rows = h.stdout().trimEnd().split("\n");
    expect(rows[0]).toMatch(/^PLACE\s+CC\s+FEED --LOCATIONS VALUE$/);
    expect(rows[1]).toMatch(/^Berlin, Berlin, Germany\s+DE\s+country=Germany,region=Berlin,city=Berlin$/);
    expect(rows[2]).toMatch(/^New Berlin, Wisconsin, United States\s+US\s+country=United States,region=Wisconsin,city=New Berlin$/);
    // No country, so nothing the feed could anchor on.
    expect(rows[3]).toBe("Berlin Seamount");
  });

  it("prints paste-ready flags for the first match on stderr, quoted where the shell needs it", async () => {
    const h = harness({ env, responder: () => json(200, { suggestions: suggestions.slice(1) }) });
    expect(await h.run("locations", "new", "berlin")).toBe(0);
    expect(new URL(h.requests[0]?.url ?? "").searchParams.get("q")).toBe("new berlin");
    expect(h.stderr()).toBe(
      'search (the first match): --location "New Berlin, Wisconsin, United States"\n' +
        'feed (the first match): --locations "country=United States,region=Wisconsin,city=New Berlin"\n',
    );
  });

  it("the printed --locations value is what the feed sends", async () => {
    const h = harness({ env, responder: () => json(200, { suggestions: suggestions.slice(0, 1) }) });
    await h.run("locations", "berlin");
    expect(h.stderr()).toContain("feed: --locations country=Germany,region=Berlin,city=Berlin\n");
    const value = /--locations (.+)$/m.exec(h.stderr())?.[1] ?? "";

    const feed = harness({ env, responder: () => json(200, { jobs: [], next_cursor: null, has_more: false }) });
    await feed.run("feed", "--max", "1", "--locations", value);
    expect(feed.body().locations).toEqual([{ country: "Germany", region: "Berlin", city: "Berlin" }]);
  });

  it("adds the feed value to each JSON record and CSV row, and leaves the rest as the API sent it", async () => {
    const asJson = harness({ env, responder: () => json(200, { suggestions }) });
    await asJson.run("locations", "berlin");
    expect(JSON.parse(asJson.stdout())).toEqual({
      suggestions: [
        { ...suggestions[0], feed_location: "country=Germany,region=Berlin,city=Berlin" },
        { ...suggestions[1], feed_location: "country=United States,region=Wisconsin,city=New Berlin" },
        { ...suggestions[2], feed_location: null },
      ],
    });

    const asCsv = harness({ env, responder: () => json(200, { suggestions: suggestions.slice(0, 1) }) });
    await asCsv.run("locations", "berlin", "--csv");
    expect(asCsv.stdout()).toBe(
      'display_name,city,region,country,country_code,latitude,longitude,feed_location\r\n"Berlin, Berlin, Germany",Berlin,Berlin,Germany,DE,52.52,13.4,"country=Germany,region=Berlin,city=Berlin"\r\n',
    );
  });

  it("says so when nothing matches, and refuses a query the API would not answer", async () => {
    const none = harness({ env, tty: true, responder: () => json(200, { suggestions: [] }) });
    expect(await none.run("locations", "zzzz")).toBe(0);
    expect(none.stdout()).toBe("No place starts with that.\n");
    expect(none.stderr()).toBe("");

    const h = harness({ env });
    expect(await h.run("locations", "b")).toBe(2);
    expect(await h.run("locations")).toBe(2);
    expect(await h.run("locations", "berlin", "--limit", "11")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("is listed as free, next to the billed geocode", async () => {
    const h = harness();
    await h.run("--help");
    expect(h.stdout()).toMatch(/locations\s+Find places by name.*\(free\)/);
    await h.run("locations", "--help");
    expect(h.stdout()).toContain("unlike `jobo geocode`");
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
    const options = [{ key: "python", count: 900 }];
    const h = harness({ env, tty: true, responder: () => json(200, { facet: "skills", options }) });
    expect(await h.run("filters", "skills", "pyth", "--limit", "5")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/connectors/filter-options/skills");
    expect(url.searchParams.get("q")).toBe("pyth");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(h.stdout()).toMatch(/VALUE\s+JOBS/);
    expect(h.stdout()).toMatch(/python\s+900/);
  });

  it("lists the occupations with the most jobs when no name is given", async () => {
    const options = [{ key: "esco:123", count: 900, name: "Registered Nurse", parent: "nursing" }];
    const h = harness({ env, tty: true, responder: () => json(200, { facet: "occupations", options }) });
    expect(await h.run("filters", "occupations", "--limit", "5")).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(new URL(h.requests[0]?.url ?? "").pathname).toBe("/api/connectors/filter-options/occupations");
    expect(h.stdout()).toMatch(/esco:123\s+Registered Nurse\s+nursing\s+900/);
  });

  describe("occupations by name", () => {
    // The live facet endpoint matches `q` against occupation ids, so a name
    // search returned nothing. Names are matched in the taxonomy instead.
    const taxonomy = {
      version: "v1",
      categories: [
        {
          name: "Healthcare",
          subcategories: [
            {
              name: "Nursing",
              occupations: [
                { id: "esco:1", name: "Registered Nurse" },
                { id: "esco:2", name: "Nurse Assistant" },
                { id: "esco:3", name: "Midwife" },
              ],
            },
          ],
        },
        { name: "Education", subcategories: [{ name: "Early Education", occupations: [{ id: "esco:4", name: "Nursery School Teacher" }] }] },
      ],
    };
    const counted = { facet: "occupations", options: [{ key: "esco:2", count: 40 }, { key: "esco:1", count: 900 }] };
    const responder = (request: { url: string }) =>
      new URL(request.url).pathname === "/api/occupations" ? json(200, taxonomy) : json(200, counted);

    it("matches every word against the name and puts the most jobs first", async () => {
      const h = harness({ env, tty: true, responder });
      expect(await h.run("filters", "occupations", "nurse")).toBe(0);
      const paths = h.requests.map((request) => new URL(request.url).pathname).sort();
      expect(paths).toEqual(["/api/connectors/filter-options/occupations", "/api/occupations"]);
      // The id-only `q` is never sent for a name.
      expect(h.requests.every((request) => new URL(request.url).searchParams.get("q") === null)).toBe(true);
      const lines = h.stdout().trimEnd().split("\n");
      expect(lines[0]).toMatch(/VALUE\s+NAME\s+PARENT\s+JOBS/);
      expect(lines[1]).toMatch(/esco:1\s+Registered Nurse\s+Nursing\s+900/);
      expect(lines[2]).toMatch(/esco:2\s+Nurse Assistant\s+Nursing\s+40/);
      // A name that merely contains the word still matches, after the counted ones.
      expect(lines[3]).toMatch(/esco:4\s+Nursery School Teacher\s+Early Education/);
      expect(lines).toHaveLength(4);
      expect(h.stdout()).not.toContain("Midwife");
    });

    it("narrows with a second word and keeps the facet's JSON shape", async () => {
      const h = harness({ env, responder });
      expect(await h.run("filters", "occupations", "nurse", "assistant")).toBe(0);
      expect(JSON.parse(h.stdout())).toEqual({
        facet: "occupations",
        options: [{ key: "esco:2", count: 40, name: "Nurse Assistant", parent: "Nursing" }],
      });
    });

    it("says so when an occupation has no job count, and when the list was cut", async () => {
      const h = harness({ env, tty: true, responder });
      expect(await h.run("filters", "occupations", "nurs", "--limit", "2")).toBe(0);
      expect(h.stderr()).toContain("showing 2 of 3 matches");
      const blank = harness({ env, tty: true, responder });
      expect(await blank.run("filters", "occupations", "nursery")).toBe(0);
      expect(blank.stdout()).toMatch(/esco:4\s+Nursery School Teacher\s+Early Education/);
      expect(blank.stderr()).toContain("jobs is blank outside the 250 occupations");
    });

    it("finds an occupation by the start of its id", async () => {
      const h = harness({ env, responder });
      expect(await h.run("filters", "occupations", "esco:3")).toBe(0);
      expect((JSON.parse(h.stdout()) as { options: Array<{ name: string }> }).options.map((option) => option.name)).toEqual(["Midwife"]);
    });

    it("reports no match without failing", async () => {
      const h = harness({ env, tty: true, responder });
      expect(await h.run("filters", "occupations", "astronaut")).toBe(0);
      expect(h.stdout() + h.stderr()).toContain('No occupation name matches "astronaut".');
    });

    it("jobo occupations <query> filters the taxonomy with one request", async () => {
      const h = harness({ env, responder });
      expect(await h.run("occupations", "registered", "nurse")).toBe(0);
      expect(h.requests).toHaveLength(1);
      expect(JSON.parse(h.stdout())).toEqual({
        version: "v1",
        occupations: [
          { category: "Healthcare", subcategory: "Nursing", id: "esco:1", name: "Registered Nurse", isco_code: null, onet_soc_codes: [] },
        ],
      });
      expect(h.stderr()).toContain('1 of 4 occupations match "registered nurse"');
    });
  });

  it("rejects an unknown facet without a request", async () => {
    const h = harness({ env });
    expect(await h.run("filters", "salaries")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("job_subcategories");
  });

  it.each(["job_categories", "job-categories", "Job-Categories", "JOB_CATEGORIES", "jobcategories"])("takes the facet spelled %s", async (spelling) => {
    const h = harness({ env, responder: () => json(200, { facet: "job_categories", options: [{ key: "healthcare", count: 9, name: "Healthcare" }] }) });
    expect(await h.run("filters", spelling, "health")).toBe(0);
    const url = new URL(h.requests[0]?.url ?? "");
    expect(url.pathname).toBe("/api/connectors/filter-options/job_categories");
    expect(url.searchParams.get("q")).toBe("health");
  });

  it("suggests the facet that was meant, or the command that holds what was asked for", async () => {
    const h = harness({ env });
    expect(await h.run("filters", "job-categoris")).toBe(2);
    expect(h.stderr()).toContain('Unknown facet "job-categoris". Did you mean "job_categories"?');
    expect(await h.run("filters", "skill")).toBe(2);
    expect(h.stderr()).toContain('Did you mean "skills"?');
    expect(await h.run("filters", "companies")).toBe(2);
    expect(h.stderr()).toContain("Companies are looked up with `jobo companies <query>`.");
    expect(await h.run("filters", "locations")).toBe(2);
    expect(h.stderr()).toContain("Places are looked up with `jobo locations <query>`.");
    expect(h.requests).toHaveLength(0);
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
