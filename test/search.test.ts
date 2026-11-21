import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TransportRequest, TransportResponse } from "@jobo-ai/connector-core";
import { describe, expect, it } from "vitest";

import { LIVE_KEY, harness, job, json, searchPage } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };

/** A search backend holding `total` jobs, answering whatever page is asked for. */
function backend(total: number, headers: Record<string, string> = {}) {
  return (request: { body?: string }) => {
    const body = JSON.parse(request.body ?? "{}") as { page: number; page_size: number };
    const start = (body.page - 1) * body.page_size;
    const count = Math.max(0, Math.min(body.page_size, total - start));
    const jobs = Array.from({ length: count }, (_, index) => job(`j${start + index + 1}`));
    return json(
      200,
      searchPage(jobs, {
        total,
        page: body.page,
        page_size: body.page_size,
        total_pages: Math.ceil(total / body.page_size),
      }),
      headers,
    );
  };
}

describe("jobo search", () => {
  it("identifies itself and authenticates with X-Api-Key", async () => {
    const h = harness({ responder: backend(3), env });
    expect(await h.run("search", "engineer")).toBe(0);
    const headers = h.requests[0]?.headers ?? {};
    expect(headers["X-Api-Key"]).toBe(LIVE_KEY);
    expect(headers["X-Jobo-Client"]).toBe("cli");
    expect(headers["User-Agent"]).toMatch(/^jobo-cli\/\d+\.\d+\.\d+$/);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("fetches one small page by default", async () => {
    const h = harness({ responder: backend(500), env });
    await h.run("search", "engineer");
    expect(h.requests).toHaveLength(1);
    expect(h.body()).toMatchObject({ page: 1, page_size: 10 });
  });

  it("honours --page and --page-size", async () => {
    const h = harness({ responder: backend(500), env });
    await h.run("search", "engineer", "--page", "3", "--page-size", "25");
    expect(h.requests).toHaveLength(1);
    expect(h.body()).toMatchObject({ page: 3, page_size: 25 });
  });

  it("--max walks whole pages and never asks for more than the cap", async () => {
    const h = harness({ responder: backend(1000), env });
    expect(await h.run("search", "engineer", "--max", "60", "--page-size", "20")).toBe(0);
    expect(h.requests.map((_, index) => h.body(index))).toMatchObject([
      { page: 1, page_size: 20 },
      { page: 2, page_size: 20 },
      { page: 3, page_size: 20 },
    ]);
    expect((JSON.parse(h.stdout()) as { jobs: unknown[]; pages_fetched: number }).jobs).toHaveLength(60);
  });

  it("--max below the page size shrinks the page instead of over-fetching", async () => {
    const h = harness({ responder: backend(1000), env });
    await h.run("search", "engineer", "--max", "7");
    expect(h.requests).toHaveLength(1);
    expect(h.body()).toMatchObject({ page: 1, page_size: 7 });
  });

  it("--max leaves a remainder unfetched rather than billing past the cap", async () => {
    const h = harness({ responder: backend(1000), env });
    await h.run("search", "engineer", "--max", "250");
    // 100 per page: two whole pages (200 jobs); a third would bill 300.
    expect(h.requests).toHaveLength(2);
    const billed = h.requests.reduce((sum, _, index) => sum + (h.body(index).page_size as number), 0);
    expect(billed).toBeLessThanOrEqual(250);
    expect(h.stderr()).toContain("not a multiple of the page size");
  });

  it("stops when the results run out", async () => {
    const h = harness({ responder: backend(25), env });
    await h.run("search", "engineer", "--max", "100", "--page-size", "10");
    expect(h.requests).toHaveLength(3);
    expect((JSON.parse(h.stdout()) as { jobs: unknown[] }).jobs).toHaveLength(25);
  });

  it("refuses a walk past the search depth limit and points to the feed", async () => {
    const h = harness({ responder: backend(10), env });
    expect(await h.run("search", "engineer", "--page", "1001", "--page-size", "100")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("jobo feed");
  });

  it("reports the cost on stderr and keeps stdout pure JSON", async () => {
    const h = harness({
      responder: backend(40, {
        "x-credits-deducted": "30",
        "x-credits-balance": "4970",
        "x-quota-limit": "100000",
        "x-quota-remaining": "0",
      }),
      env,
    });
    await h.run("search", "engineer");
    expect(h.stderr()).toContain("usage: 30 credits ($0.03) charged · wallet 4,970 credits ($4.97) · included jobs left 0 of 100,000");
    expect(h.stderr()).toContain("10 of 40 matching jobs");
    expect(h.stderr()).toContain("Next: --page 2");
    const parsed = JSON.parse(h.stdout()) as { jobs: unknown[]; total: number };
    expect(parsed.total).toBe(40);
    expect(parsed.jobs).toHaveLength(10);
  });

  it("--quiet silences the notes but not the data", async () => {
    const h = harness({ responder: backend(40, { "x-credits-deducted": "30" }), env });
    await h.run("search", "engineer", "--quiet");
    expect(h.stderr()).toBe("");
    expect(JSON.parse(h.stdout())).toHaveProperty("jobs");
  });

  it("surfaces API warnings on stderr", async () => {
    const h = harness({
      responder: () =>
        json(
          200,
          searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 }, {
            warnings: [{ code: "companies_unmatched", message: "No company matched: Acmee." }],
          }),
        ),
      env,
    });
    await h.run("search", "--companies", "Acmee");
    expect(h.stderr()).toContain("warning: No company matched: Acmee.");
  });

  it("warns that a multi-page walk in relevance order can repeat jobs, and drops repeats", async () => {
    const h = harness({
      responder: (request) => {
        const body = JSON.parse(request.body ?? "{}") as { page: number };
        const jobs = body.page === 1 ? [job("a"), job("b")] : [job("b"), job("c")];
        return json(200, searchPage(jobs, { total: 6, page: body.page, page_size: 2, total_pages: 3 }));
      },
      env,
    });
    await h.run("search", "engineer", "--max", "4", "--page-size", "2");
    expect(h.stderr()).toContain("--sort discovered_asc");
    expect(h.stderr()).toContain("1 job repeated across pages");
    expect((JSON.parse(h.stdout()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("says a sandbox key is not billed", async () => {
    const h = harness({ responder: backend(3, { "x-jobo-environment": "sandbox" }), env });
    await h.run("search", "engineer");
    expect(h.stderr()).toContain("sandbox key: not billed");
  });
});

describe("jobo search when a walk fails part-way", () => {
  /** Pages up to `good` are served; every later request fails the same way. */
  function failingAfter(good: number, failure: () => TransportResponse) {
    const ok = backend(1000, { "x-credits-deducted": "300" });
    return (request: TransportRequest) => ((JSON.parse(request.body ?? "{}") as { page: number }).page <= good ? ok(request) : failure());
  }
  const rateLimited = () => json(429, { title: "Too many requests", detail: "Rate limit exceeded." }, { "retry-after": "1" });
  const unavailable = () => json(503, { title: "Service unavailable" });

  it("keeps the billed pages in the output file, exits with the failure's own code and says how to resume", async () => {
    const h = harness({ responder: failingAfter(2, rateLimited), env });
    expect(await h.run("search", "nurse", "--max", "500", "-o", "out.jsonl")).toBe(5);

    const rows = readFileSync(join(h.cwd, "out.jsonl"), "utf8").trimEnd().split("\n");
    expect(rows).toHaveLength(200);
    expect((JSON.parse(rows[199] ?? "{}") as { id: string }).id).toBe("j200");
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain(`200 jobs from pages 1–2 were fetched and billed before the error, and are written to ${join(h.cwd, "out.jsonl")}.`);
    expect(h.stderr()).toContain("Resume with the same filters and --page 3 --page-size 100 --max 300 --append.");
    expect(h.stderr()).toContain("error: Rate limited");
    // The resume note comes before the error line, so the error stays the last thing on screen.
    expect(h.stderr().indexOf("Resume with")).toBeLessThan(h.stderr().indexOf("error: "));
  });

  it("the resume line it prints completes the walk into the same file", async () => {
    const failing = harness({ responder: failingAfter(2, rateLimited), env });
    await failing.run("search", "nurse", "--max", "500", "-o", "out.jsonl");

    const resumed = harness({ responder: backend(1000), env });
    writeFileSync(join(resumed.cwd, "out.jsonl"), readFileSync(join(failing.cwd, "out.jsonl")));
    expect(await resumed.run("search", "nurse", "--page", "3", "--page-size", "100", "--max", "300", "--append", "-o", "out.jsonl")).toBe(0);
    expect(resumed.requests.map((_, index) => resumed.body(index).page)).toEqual([3, 4, 5]);
    const ids = readFileSync(join(resumed.cwd, "out.jsonl"), "utf8").trimEnd().split("\n").map((row) => (JSON.parse(row) as { id: string }).id);
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
  });

  it("writes row formats page by page, so a page is on disk before the next is asked for", async () => {
    const sizes: number[] = [];
    const ok = backend(1000);
    const h = harness({
      env,
      responder: (request) => {
        const file = join(h.cwd, "out.csv");
        sizes.push(existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\r\n").length : 0);
        return ok(request);
      },
    });
    expect(await h.run("search", "nurse", "--max", "6", "--page-size", "2", "--fields", "id", "-o", "out.csv")).toBe(0);
    // Lines in the file as each request goes out: none yet (an empty file reads as one empty line), then the header and two rows, then two more.
    expect(sizes).toEqual([1, 3, 5]);
    expect(readFileSync(join(h.cwd, "out.csv"), "utf8")).toBe("id\r\nj1\r\nj2\r\nj3\r\nj4\r\nj5\r\nj6\r\n");
  });

  it("prints a JSON document of what it has, marked partial", async () => {
    const h = harness({ responder: failingAfter(1, unavailable), env });
    expect(await h.run("search", "nurse", "--max", "60", "--page-size", "20")).toBe(7);
    const parsed = JSON.parse(h.stdout()) as { jobs: unknown[]; total: number; partial: boolean };
    expect(parsed.jobs).toHaveLength(20);
    expect(parsed.partial).toBe(true);
    expect(parsed.total).toBe(1000);
    expect(h.stderr()).toContain("20 jobs from page 1 were fetched and billed before the error, and are printed.");
    expect(h.stderr()).toContain("--page 2 --page-size 20 --max 40.");
  });

  it("names the one page that is left without a --max", async () => {
    const h = harness({ responder: failingAfter(1, unavailable), env });
    expect(await h.run("search", "nurse", "--max", "40", "--page-size", "20", "--jsonl")).toBe(7);
    expect(h.stdout().trimEnd().split("\n")).toHaveLength(20);
    expect(h.stderr()).toContain("Resume with the same filters and --page 2 --page-size 20.");
  });

  it("does not mark a complete result partial", async () => {
    const h = harness({ responder: backend(1000), env });
    await h.run("search", "nurse", "--max", "40", "--page-size", "20");
    expect(JSON.parse(h.stdout())).not.toHaveProperty("partial");
  });

  it("has nothing to hand over when the first page fails: no output, no file, no resume line", async () => {
    const h = harness({ responder: failingAfter(0, unavailable), env });
    expect(await h.run("search", "nurse", "--max", "500", "-o", "out.jsonl")).toBe(7);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).not.toContain("Resume with");
    expect(existsSync(join(h.cwd, "out.jsonl"))).toBe(false);
  });
});

describe("jobo search with no results", () => {
  const none = () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 }));

  it("points at the open-vocabulary filters and the commands that list their values", async () => {
    const h = harness({ responder: none, env });
    expect(await h.run("search", "engineer", "--sources", "greenhous", "--industries", "Softwar", "--work-model", "remote")).toBe(0);
    expect(h.stderr()).toContain(
      "note: check the values of --sources, --industries: they are matched exactly, so one the index does not hold matches nothing. " +
        "List valid values with `jobo filters sources`, `jobo filters industries`.",
    );
    expect(h.stderr()).not.toContain("--work-model");
  });

  it("names the right lookup for companies, categories and occupations", async () => {
    const h = harness({ responder: none, env });
    await h.run("search", "--companies", "Acmee", "--job-categories", "Helthcare", "--occupation-ids", "jobo:nope", "--company-categories", "saas");
    expect(h.stderr()).toContain("of --companies, --company-categories, --job-categories, --occupation-ids:");
    expect(h.stderr()).toContain("`jobo companies <name>`, `jobo filters company_categories`, `jobo filters job_categories`, `jobo filters occupations <query>`.");
  });

  it("speaks of one filter in the singular", async () => {
    const h = harness({ responder: none, env });
    await h.run("search", "nurse", "--skills", "Nursng");
    expect(h.stderr()).toContain("note: check the value of --skills: it is matched exactly, so one the index does not hold matches nothing. List valid values with `jobo filters skills`.");
  });

  it("says nothing of the kind when no such filter was used, or when an exclude was", async () => {
    const h = harness({ responder: none, env });
    await h.run("search", "zzzz", "--work-model", "remote", "--exclude-skills", "PHP", "--location", "Atlantis");
    expect(h.stderr()).toContain("0 of 0 matching jobs");
    expect(h.stderr()).not.toContain("matched exactly");
  });

  it("says nothing of the kind when there are results", async () => {
    const h = harness({ responder: backend(3), env });
    await h.run("search", "--sources", "greenhouse");
    expect(h.stderr()).not.toContain("matched exactly");
  });
});
