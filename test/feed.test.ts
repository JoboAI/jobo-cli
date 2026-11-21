import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(await h.run("feed", "--all", "--batch-size", "100", "--cursor-file", "feed.cursor")).toBe(0);
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
    expect(await h.run("feed", "--all", "--batch-size", "100", "--cursor-file", "feed.cursor")).toBe(0);
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
    expect(await h.run("feed", "--all")).toBe(4);
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
});
