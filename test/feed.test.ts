import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { TransportRequest } from "@jobo-ai/connector-core";
import { describe, expect, it } from "vitest";

import { LIVE_KEY, harness, job, json } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };

/**
 * A feed of `total` jobs. The cursor is `c<offset>`; the scan's batch size is
 * fixed by the first request and a continuation may only lower it, as on the
 * real endpoint.
 */
function feed(total: number, headers: (delivered: number) => Record<string, string> = () => ({})) {
  let scanBatch = 1000;
  return (request: TransportRequest) => {
    const body = JSON.parse(request.body ?? "{}") as { cursor?: string; batch_size?: number };
    const offset = body.cursor ? Number(body.cursor.slice(1)) : 0;
    if (!body.cursor) scanBatch = body.batch_size ?? 1000;
    const size = Math.min(scanBatch, body.batch_size ?? scanBatch);
    const count = Math.min(size, total - offset);
    const jobs = Array.from({ length: count }, (_, index) => job(`f${offset + index + 1}`));
    const next = offset + count;
    return json(
      200,
      { jobs, next_cursor: next < total ? `c${next}` : null, has_more: next < total, estimated_total: total },
      headers(count),
    );
  };
}

const lines = (text: string) => text.split("\n").filter(Boolean);

describe("jobo feed needs an explicit cap", () => {
  it("refuses to run without --max or --all, before any request", async () => {
    const h = harness({ responder: feed(10), env });
    expect(await h.run("feed", "--sources", "greenhouse")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("--max N");
    expect(h.stderr()).toContain("--all");
  });

  it("refuses --max together with --all", async () => {
    const h = harness({ responder: feed(10), env });
    expect(await h.run("feed", "--max", "5", "--all")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("never delivers more than --max: the last batch is shrunk to fit", async () => {
    const h = harness({ responder: feed(10_000), env });
    expect(await h.run("feed", "--max", "250", "--batch-size", "100", "--sources", "greenhouse")).toBe(0);
    expect(h.requests.map((_, index) => h.body(index))).toEqual([
      { sources: ["greenhouse"], batch_size: 100 },
      { cursor: "c100", batch_size: 100 },
      { cursor: "c200", batch_size: 50 },
    ]);
    expect(lines(h.stdout())).toHaveLength(250);
    expect(h.stderr()).toContain("stopped at --max 250");
    expect(h.stderr()).toContain("--cursor c250");
  });

  it("caps the first batch when --max is below the batch size", async () => {
    const h = harness({ responder: feed(10_000), env });
    await h.run("feed", "--max", "30");
    expect(h.requests).toHaveLength(1);
    expect(h.body()).toEqual({ batch_size: 30 });
    expect(lines(h.stdout())).toHaveLength(30);
  });

  it("--all walks to the end, sending only the cursor on continuations", async () => {
    const h = harness({ responder: feed(2500), env });
    expect(await h.run("feed", "--all", "--work-models", "remote")).toBe(0);
    expect(h.requests.map((_, index) => h.body(index))).toEqual([
      { work_models: ["remote"], batch_size: 1000 },
      { cursor: "c1000" },
      { cursor: "c2000" },
    ]);
    expect(lines(h.stdout())).toHaveLength(2500);
    expect(h.stderr()).toContain("feed complete: 2,500 jobs in 3 batches");
  });

  it("gives feed requests at least the 120 seconds the docs ask for", async () => {
    const h = harness({ responder: feed(1), env });
    await h.run("feed", "--max", "1");
    expect(h.requests[0]?.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });
});

describe("jobo feed output and cost", () => {
  it("streams one JSON job per line, even to a terminal", async () => {
    const h = harness({ responder: feed(3), env, tty: true });
    await h.run("feed", "--max", "3");
    const rows = lines(h.stdout()).map((line) => JSON.parse(line) as { id: string });
    expect(rows.map((row) => row.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("reports billed jobs, credits and the next cursor on stderr after every batch", async () => {
    const h = harness({
      responder: feed(300, (count) => ({
        "x-jobs-billed": String(count - 20),
        "x-credits-deducted": String((count - 20) * 3),
        "x-credits-balance": "9000",
      })),
      env,
    });
    await h.run("feed", "--max", "200", "--batch-size", "100");
    const err = h.stderr();
    expect(err).toContain("about 300 jobs match this feed");
    expect(err).toContain("batch 1: 100 jobs · 240 credits ($0.24) charged · 80 jobs billed · wallet 9,000 credits ($9.00) · 100 delivered of 200");
    expect(err).toContain("next cursor: c100");
    expect(err).toContain("next cursor: c200");
    expect(h.stdout()).not.toContain("cursor");
  });

  it("passes on the feed's warnings: the first page's messages, a continuation's header codes", async () => {
    const h = harness({
      env,
      responder: (_request, index) =>
        index === 0
          ? json(200, {
              jobs: [job("f1")],
              next_cursor: "c1",
              has_more: true,
              warnings: [{ code: "companies_unmatched", message: "No company matched: Acmee." }],
            })
          : json(200, { jobs: [job("f2")], next_cursor: null, has_more: false }, { "x-jobo-warnings": "batch_size_capped" }),
    });
    await h.run("feed", "--max", "2", "--batch-size", "1", "--companies", "Acmee");
    expect(h.stderr()).toContain("warning: No company matched: Acmee.");
    expect(h.stderr()).toContain("warning: batch_size_capped");
  });

  it("writes CSV with a single header across batches", async () => {
    const h = harness({ responder: feed(4), env });
    await h.run("feed", "--max", "4", "--batch-size", "2", "--csv", "--fields", "id,company.name");
    expect(h.stdout()).toBe('id,company.name\r\nf1,"Acme, Inc."\r\nf2,"Acme, Inc."\r\nf3,"Acme, Inc."\r\nf4,"Acme, Inc."\r\n');
  });
});

describe("jobo feed cursor persistence", () => {
  it("saves the next cursor after every batch and removes the file when the scan completes", async () => {
    // What the file holds when the next request goes out is what a crash at that moment would leave.
    const observed: Array<string | null> = [];
    const backend = feed(250);
    const h = harness({
      env,
      responder: (request) => {
        const path = join(h.cwd, "feed.cursor");
        observed.push(existsSync(path) ? readFileSync(path, "utf8").trim() : null);
        return backend(request);
      },
    });
    expect(await h.run("feed", "--all", "--yes", "--batch-size", "100", "--cursor-file", "feed.cursor")).toBe(0);
    expect(observed).toEqual([null, "c100", "c200"]);
    expect(existsSync(join(h.cwd, "feed.cursor"))).toBe(false);
    expect(h.stderr()).toContain("feed complete");
  });

  it("writes a batch's jobs before it saves that batch's cursor", async () => {
    const h = harness({ env, responder: feed(300) });
    const path = join(h.cwd, "feed.cursor");
    const write = h.io.stdout.write;
    const savedAtWrite: number[] = [];
    h.io.stdout.write = async (chunk) => {
      // The cursor on disk when a batch's jobs go out must still be the previous batch's:
      // a crash here then re-delivers this batch instead of skipping it.
      savedAtWrite.push(existsSync(path) ? Number(readFileSync(path, "utf8").trim().slice(1)) : 0);
      await write(chunk);
    };
    expect(await h.run("feed", "--all", "--yes", "--batch-size", "100", "--cursor-file", "feed.cursor")).toBe(0);
    expect(savedAtWrite).toEqual([0, 100, 200]);
  });

  it("a crash keeps the last good cursor, and the same command resumes from it", async () => {
    const backend = feed(300);
    const failing = harness({
      env,
      responder: (request, index) => (index === 0 ? backend(request) : json(503, { message: "An error occurred" })),
    });
    const code = await failing.run("feed", "--max", "300", "--batch-size", "100", "--sources", "greenhouse", "--cursor-file", "feed.cursor");
    expect(code).toBe(7);
    // One good batch, then the failing request with its two retries.
    expect(failing.requests).toHaveLength(4);
    expect(lines(failing.stdout())).toHaveLength(100);
    expect(readFileSync(join(failing.cwd, "feed.cursor"), "utf8").trim()).toBe("c100");
    expect(failing.stderr()).toContain("100 jobs were delivered before the error");

    const resumed = harness({ env, responder: feed(300) });
    writeFileSync(join(resumed.cwd, "feed.cursor"), "c100\n");
    expect(await resumed.run("feed", "--max", "300", "--sources", "greenhouse", "--cursor-file", "feed.cursor")).toBe(0);
    // The cursor keeps the scan's filters: only the cursor is sent.
    expect(resumed.body(0)).toEqual({ cursor: "c100", batch_size: 300 });
    expect(resumed.stderr()).toContain("resuming from the cursor in");
    expect(resumed.stderr()).toContain("filters on this command line are ignored");
    expect(lines(resumed.stdout()).map((line) => (JSON.parse(line) as { id: string }).id)[0]).toBe("f101");
  });

  it("--cursor resumes from an explicit cursor", async () => {
    const h = harness({ env, responder: feed(500) });
    await h.run("feed", "--max", "100", "--cursor", "c400");
    expect(h.body(0)).toEqual({ cursor: "c400", batch_size: 100 });
    expect(h.stderr()).toContain("feed complete");
  });

  describe("in a buffered format (--json, --table, -o x.json)", () => {
    const insufficient = () =>
      json(402, { error: "Insufficient credits", detail: "This request needs 300 credits ($0.30). Your wallet balance is 12 credits ($0.012)." });
    const unavailable = () => json(503, { title: "Feed unavailable", status: 503 });

    // Two good batches, then the failing one: a 402 is not retried, a 503 is tried three times.
    it.each([
      ["402", 4, insufficient, 3],
      ["503 after the retries", 7, unavailable, 5],
    ])("a later batch failing with %s writes the jobs it has, then saves the cursor that follows them", async (_name, exit, failure, requests) => {
      const backend = feed(500);
      const observed: Array<string | null> = [];
      const h = harness({
        env,
        responder: (request, index) => {
          const path = join(h.cwd, "feed.cursor");
          observed.push(existsSync(path) ? readFileSync(path, "utf8").trim() : null);
          return index < 2 ? backend(request) : failure();
        },
      });
      const code = await h.run("feed", "--all", "--sources", "greenhouse", "--batch-size", "100", "--cursor-file", "feed.cursor", "--json");
      expect(code).toBe(exit);
      expect(h.requests).toHaveLength(requests);
      // Nothing was written during the walk, so the file never moved ahead of the output.
      expect(observed.every((value) => value === null)).toBe(true);
      const document = JSON.parse(h.stdout()) as { jobs: Array<{ id: string }>; next_cursor: string; has_more: boolean; partial: boolean };
      expect(document.partial).toBe(true);
      expect(document.jobs.map((row) => row.id)).toEqual(Array.from({ length: 200 }, (_, index) => `f${index + 1}`));
      expect(document.next_cursor).toBe("c200");
      expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c200");
      expect(h.stderr()).toContain("200 jobs were delivered before the error. Resume with --cursor-file feed.cursor");

      // The resume starts at the first job that was not written.
      const resumed = harness({ env, responder: feed(500) });
      writeFileSync(join(resumed.cwd, "feed.cursor"), readFileSync(join(h.cwd, "feed.cursor")));
      expect(await resumed.run("feed", "--all", "--cursor-file", "feed.cursor", "--json")).toBe(0);
      expect(resumed.body(0)).toEqual({ cursor: "c200" });
      const rest = JSON.parse(resumed.stdout()) as { jobs: Array<{ id: string }> };
      expect(rest.jobs[0]?.id).toBe("f201");
      expect(rest.jobs).toHaveLength(300);
      expect(existsSync(join(resumed.cwd, "feed.cursor"))).toBe(false);
    });

    it("keeps the partial file that -o x.json wrote", async () => {
      const backend = feed(500);
      const h = harness({ env, responder: (request, index) => (index === 0 ? backend(request) : insufficient()) });
      const code = await h.run("feed", "--all", "--sources", "greenhouse", "--batch-size", "100", "--cursor-file", "feed.cursor", "-o", "jobs.json");
      expect(code).toBe(4);
      const document = JSON.parse(readFileSync(join(h.cwd, "jobs.json"), "utf8")) as { jobs: unknown[]; partial: boolean };
      expect(document.partial).toBe(true);
      expect(document.jobs).toHaveLength(100);
      expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c100");
      expect(h.stderr()).toContain(`written to ${join(h.cwd, "jobs.json")}`);
    });

    it("a --table run that fails part-way prints the rows it has", async () => {
      const backend = feed(500);
      const h = harness({ env, responder: (request, index) => (index === 0 ? backend(request) : insufficient()) });
      expect(await h.run("feed", "--all", "--sources", "greenhouse", "--batch-size", "100", "--cursor-file", "feed.cursor", "--table")).toBe(4);
      expect(h.stdout()).toContain("Engineer f100");
      expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c100");
    });

    it("saves the cursor only after the document is written, and removes it when the scan completes", async () => {
      const h = harness({ env, responder: feed(250) });
      const path = join(h.cwd, "feed.cursor");
      writeFileSync(path, "c0\n");
      const write = h.io.stdout.write;
      const atWrite: string[] = [];
      h.io.stdout.write = async (chunk) => {
        atWrite.push(readFileSync(path, "utf8").trim());
        await write(chunk);
      };
      expect(await h.run("feed", "--all", "--batch-size", "100", "--cursor-file", "feed.cursor", "--json")).toBe(0);
      expect(atWrite).toEqual(["c0"]);
      expect(existsSync(path)).toBe(false);
      expect((JSON.parse(h.stdout()) as { jobs: unknown[]; partial?: boolean }).partial).toBeUndefined();
    });

    it("leaves the cursor where it was when the output itself cannot be written", async () => {
      const backend = feed(500);
      const h = harness({ env, responder: (request, index) => (index === 0 ? backend(request) : insufficient()) });
      writeFileSync(join(h.cwd, "feed.cursor"), "c0\n");
      h.io.stdout.write = async () => {
        throw new Error("disk full");
      };
      expect(await h.run("feed", "--all", "--batch-size", "100", "--cursor-file", "feed.cursor", "--json")).toBe(4);
      expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c0");
      expect(h.stderr()).not.toContain("were delivered");
    });
  });

  it("keeps the cursor file when --max stops a scan that has more", async () => {
    const h = harness({ env, responder: feed(500) });
    await h.run("feed", "--max", "200", "--batch-size", "100", "--cursor-file", "feed.cursor");
    expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c200");
    expect(h.stderr()).toContain("Resume with the same --cursor-file feed.cursor");
  });
});

describe("jobo feed errors", () => {
  it("treats 409 feed_cursor_restart_required as terminal: no retry, exit 8", async () => {
    const h = harness({
      env,
      responder: () =>
        json(409, {
          title: "Feed cursor restart required",
          status: 409,
          code: "feed_cursor_restart_required",
          replacement_request: { stable_scan: true, batch_size: 1000 },
        }),
    });
    expect(await h.run("feed", "--max", "10", "--cursor", "legacy")).toBe(8);
    expect(h.requests).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.stderr()).toContain("start a new scan");
  });

  const restartRequired = () =>
    json(409, {
      title: "Feed cursor restart required",
      status: 409,
      code: "feed_cursor_restart_required",
      replacement_request: { stable_scan: true, batch_size: 1000 },
    });

  it("moves a --cursor-file whose cursor needs a restart to FILE.dead, so the next run starts a new scan", async () => {
    const h = harness({ env, responder: restartRequired });
    const path = join(h.cwd, "feed.cursor");
    writeFileSync(path, "legacy\n");
    writeFileSync(`${path}.dead`, "an older dead cursor\n");
    expect(await h.run("feed", "--all", "--sources", "greenhouse", "--cursor-file", "feed.cursor")).toBe(8);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.dead`, "utf8").trim()).toBe("legacy");
    expect(h.stderr()).toContain(`moved it to ${path}.dead`);
    expect(h.stderr()).toContain("The scan must start again");

    // The same command now starts a new scan with its filters.
    const next = harness({ env, responder: feed(5) });
    expect(await next.run("feed", "--all", "--sources", "greenhouse", "--cursor-file", join(h.cwd, "feed.cursor"))).toBe(0);
    expect(next.body(0)).toEqual({ sources: ["greenhouse"], batch_size: 1000 });
  });

  it("moves the cursor file aside when a later batch's cursor needs a restart", async () => {
    const backend = feed(500);
    const h = harness({ env, responder: (request, index) => (index === 0 ? backend(request) : restartRequired()) });
    expect(await h.run("feed", "--all", "--sources", "greenhouse", "--batch-size", "100", "--cursor-file", "feed.cursor")).toBe(8);
    expect(lines(h.stdout())).toHaveLength(100);
    expect(existsSync(join(h.cwd, "feed.cursor"))).toBe(false);
    expect(readFileSync(join(h.cwd, "feed.cursor.dead"), "utf8").trim()).toBe("c100");
  });

  it("leaves a cursor file alone when the dead cursor came from --cursor", async () => {
    const h = harness({ env, responder: restartRequired });
    writeFileSync(join(h.cwd, "feed.cursor"), "c5\n");
    expect(await h.run("feed", "--max", "10", "--cursor", "legacy", "--cursor-file", "feed.cursor")).toBe(8);
    expect(readFileSync(join(h.cwd, "feed.cursor"), "utf8").trim()).toBe("c5");
    expect(existsSync(join(h.cwd, "feed.cursor.dead"))).toBe(false);
  });

  it("treats 400 invalid_cursor as a cursor to discard (exit 8)", async () => {
    const h = harness({
      env,
      responder: () => json(400, { title: "Invalid cursor", detail: "The supplied cursor could not be decoded.", status: 400, code: "invalid_cursor" }),
    });
    expect(await h.run("feed", "--max", "10", "--cursor", "garbage")).toBe(8);
    expect(h.requests).toHaveLength(1);
  });

  it("does not retry 402 and names the smaller batch as the way down", async () => {
    const h = harness({
      env,
      responder: () =>
        json(402, {
          error: "Insufficient credits",
          detail: "This request needs 3000 credits ($3.00). Your wallet balance is 12 credits ($0.012). Top up your wallet to continue.",
          top_up_url: "https://enterprise.jobo.world/credits?topup=10&src=api_402",
        }),
    });
    expect(await h.run("feed", "--all", "--sources", "greenhouse")).toBe(4);
    expect(h.requests).toHaveLength(1);
    expect(h.stderr()).toContain("https://enterprise.jobo.world/credits?topup=10&src=api_402");
    expect(h.stderr()).toContain("--batch-size");
  });

  it("honours Retry-After on 503 and carries on with the same cursor", async () => {
    const backend = feed(100);
    const h = harness({
      env,
      responder: (request, index) =>
        index === 0 ? json(503, { title: "Feed unavailable", status: 503 }, { "retry-after": "5" }) : backend(request),
    });
    expect(await h.run("feed", "--max", "100")).toBe(0);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.body).toBe(h.requests[0]?.body);
    expect(h.sleeps).toEqual([5000]);
    expect(lines(h.stdout())).toHaveLength(100);
  });

  it("refuses paging keys smuggled in through --body", async () => {
    const h = harness({ env, responder: feed(10) });
    expect(await h.run("feed", "--max", "5", "--body", '{"batch_size":1000}')).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("merges filter flags over --body", async () => {
    const h = harness({ env, responder: feed(10) });
    await h.run("feed", "--max", "5", "--body", '{"sources":["lever"],"stable_scan":true}', "--sources", "greenhouse");
    expect(h.body()).toEqual({ sources: ["greenhouse"], stable_scan: true, batch_size: 5 });
  });

  it("reads --body from a file", async () => {
    const h = harness({ env, responder: feed(10) });
    writeFileSync(join(h.cwd, "feed.json"), '{"job_subcategories":{"include":["Nursing"]}}');
    expect(await h.run("feed", "--max", "5", "--body", "@feed.json")).toBe(0);
    expect(h.body()).toEqual({ job_subcategories: { include: ["Nursing"] }, batch_size: 5 });
  });

  it("says so when the --body file is not there, as a usage error and before any request", async () => {
    const h = harness({ env, responder: feed(10) });
    expect(await h.run("feed", "--max", "5", "--body", "@missing.json")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain(`--body @missing.json: cannot read ${join(h.cwd, "missing.json")}: there is no such file.`);
    expect(h.stderr()).not.toContain("ENOENT");
    expect(h.stderr()).toContain("Run `jobo feed --help` for usage.");

    mkdirSync(join(h.cwd, "a-directory"));
    expect(await h.run("feed", "--max", "5", "--body", "@a-directory")).toBe(2);
    expect(h.stderr()).toContain("it is a directory");
  });
});

describe("jobo feed --all on the whole index", () => {
  /** The free vocabulary call answers with the index's size; anything else is the feed. */
  function index(sources: Array<{ key: string; count: number }> | null, total = 10) {
    const backend = feed(total);
    return (request: TransportRequest) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/api/connectors/filters") {
        return sources ? json(200, { enums: {}, sources }) : json(500, { title: "Server error" });
      }
      return backend(request);
    };
  }
  const eightMillion = [
    { key: "workday", count: 5_000_000 },
    { key: "greenhouse", count: 2_500_000 },
    { key: "lever_co", count: 512_345 },
  ];

  it("refuses without --yes, quoting the job count and the most it could cost", async () => {
    const h = harness({ env, responder: index(eightMillion) });
    expect(await h.run("feed", "--all")).toBe(2);
    // One free lookup for the size; the feed itself is never called.
    expect(h.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(["GET /api/connectors/filters"]);
    expect(h.stdout()).toBe("");
    expect(h.stderr()).toContain(
      "jobo feed --all with no filter streams the whole index: about 8,012,345 jobs, up to 24,037,035 credits (about $24,037) if every one is new to you.",
    );
    expect(h.stderr()).toContain("pass --yes");
  });

  it("refuses all the same when the size cannot be fetched, without retrying", async () => {
    const failing = harness({ env, responder: index(null) });
    expect(await failing.run("feed", "--all", "--batch-size", "100", "--output", "all.jsonl")).toBe(2);
    expect(failing.requests).toHaveLength(1);
    expect(failing.sleeps).toEqual([]);
    expect(failing.stderr()).toContain("every live job, at $3.00 per 1,000 that are new to you");
    expect(existsSync(join(failing.cwd, "all.jsonl"))).toBe(false);

    // No key: still a usage error about the missing filter, and nothing is sent.
    const keyless = harness({ responder: index(eightMillion) });
    expect(await keyless.run("feed", "--all")).toBe(2);
    expect(keyless.requests).toHaveLength(0);
  });

  it("runs with --yes, without looking the size up", async () => {
    const h = harness({ env, responder: index(eightMillion, 3) });
    expect(await h.run("feed", "--all", "--yes")).toBe(0);
    expect(h.requests.map((request) => request.method)).toEqual(["POST"]);
    expect(lines(h.stdout())).toHaveLength(3);
  });

  it.each([
    ["a filter flag", ["--sources", "greenhouse"]],
    ["an exclude filter", ["--exclude-languages", "de"]],
    ["a filter in --body", ["--body", '{"work_models":["remote"]}']],
    ["an incremental watermark", ["--updated-after", "24h"]],
    ["a cursor", ["--cursor", "c5"]],
  ])("needs no --yes with %s", async (_name, argv) => {
    const h = harness({ env, responder: index(eightMillion) });
    expect(await h.run("feed", "--all", ...argv)).toBe(0);
    expect(h.requests.every((request) => request.method === "POST")).toBe(true);
  });

  it("needs no --yes to resume from a cursor file, and does for an empty one", async () => {
    const resuming = harness({ env, responder: index(eightMillion) });
    writeFileSync(join(resuming.cwd, "feed.cursor"), "c5\n");
    expect(await resuming.run("feed", "--all", "--cursor-file", "feed.cursor")).toBe(0);
    expect(resuming.body()).toEqual({ cursor: "c5" });

    const fresh = harness({ env, responder: index(eightMillion) });
    writeFileSync(join(fresh.cwd, "feed.cursor"), "\n");
    expect(await fresh.run("feed", "--all", "--cursor-file", "feed.cursor")).toBe(2);
  });

  it.each([
    ["a format", ["--description-format", "html"]],
    ["--include-reactivated", ["--include-reactivated", "true"]],
    ["an empty --body", ["--body", "{}"]],
    ["a --body that only sets the scan mode", ["--body", '{"stable_scan":true}']],
  ])("still counts %s as the whole index", async (_name, argv) => {
    const h = harness({ env, responder: index(eightMillion) });
    expect(await h.run("feed", "--all", ...argv)).toBe(2);
    expect(h.stderr()).toContain("the whole index");
  });

  it("never asks for --yes when --max bounds the run", async () => {
    const h = harness({ env, responder: index(eightMillion) });
    expect(await h.run("feed", "--max", "5")).toBe(0);
    expect(h.requests.map((request) => request.method)).toEqual(["POST"]);
  });
});

describe("jobo feed company filters", () => {
  const ID_A = "b5e6f7a8-1234-5678-9abc-def012345678";
  const ID_B = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

  it("splits a comma list of ids or domains, and keeps a name with a comma whole", async () => {
    const h = harness({ env, responder: feed(1) });
    await h.run("feed", "--max", "1", "--companies", `${ID_A},${ID_B}`, "--companies", "fedex.com, ups.com", "--exclude-companies", "Acme, Inc.");
    expect(h.body().companies).toEqual({ include: [ID_A, ID_B, "fedex.com", "ups.com"], exclude: ["Acme, Inc."] });
  });
});
