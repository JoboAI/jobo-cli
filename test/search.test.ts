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
