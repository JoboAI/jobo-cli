import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cellText, getPath, resolveFormat, shellWord, toCsv, toJsonl, toKeyValue, toTable } from "../src/output";
import { LIVE_KEY, harness, job, json, searchPage } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };
const twoJobs = () =>
  json(200, searchPage([job("a"), job("b", { title: 'Say "hi"', workplace_type: null })], { total: 2, page: 1, page_size: 10, total_pages: 1 }));

describe("format selection", () => {
  const tty = { stdout: { isTTY: true, write: async () => undefined } };
  const piped = { stdout: { isTTY: false, write: async () => undefined } };

  it("is a table in a terminal and JSON when piped", () => {
    expect(resolveFormat({}, tty)).toBe("table");
    expect(resolveFormat({}, piped)).toBe("json");
  });

  it("lets a flag override either", () => {
    expect(resolveFormat({ json: true }, tty)).toBe("json");
    expect(resolveFormat({ table: true }, piped)).toBe("table");
    expect(resolveFormat({ jsonl: true }, tty)).toBe("jsonl");
    expect(resolveFormat({ csv: true }, piped)).toBe("csv");
  });

  it("takes the format from the output file's extension", () => {
    expect(resolveFormat({ output: "jobs.csv" }, tty)).toBe("csv");
    expect(resolveFormat({ output: "jobs.ndjson" }, tty)).toBe("jsonl");
    expect(resolveFormat({ output: "jobs.txt" }, tty)).toBe("json");
    expect(resolveFormat({ output: "jobs.csv", json: true }, tty)).toBe("json");
  });

  it("refuses two formats at once", () => {
    expect(() => resolveFormat({ json: true, csv: true }, piped)).toThrow(/Pick one output format/);
  });
});

describe("renderers", () => {
  it("quotes CSV cells that need it and ends rows with CRLF", () => {
    const rows = [{ a: "plain", b: 'has "quotes", and a comma', c: ["x", "y"], d: null, e: { k: 1 } }];
    expect(toCsv(rows, [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }, { key: "e" }])).toBe(
      'a,b,c,d,e\r\nplain,"has ""quotes"", and a comma","x, y",,"{""k"":1}"\r\n',
    );
    expect(toCsv(rows, [{ key: "a" }], { header: false })).toBe("plain\r\n");
  });

  it("flattens newlines so one record stays one CSV row or table line", () => {
    expect(cellText("first\n  second\r\nthird")).toBe("first second third");
  });

  it("writes one JSON document per line", () => {
    expect(toJsonl([{ id: 1 }, { id: 2 }])).toBe('{"id":1}\n{"id":2}\n');
    expect(toJsonl([])).toBe("");
  });

  it("aligns a table, upper-cases headers and truncates to the width", () => {
    const table = toTable(
      [
        { id: "1", title: "A very long job title that will not fit in the terminal at all" },
        { id: "22", title: "Short" },
      ],
      [{ key: "id" }, { key: "title" }],
      30,
    );
    const lines = table.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+TITLE$/);
    expect(lines[1]).toMatch(/^1 {3}A very long job title/);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(30);
    expect(lines[2]).toBe("22  Short");
  });

  it("never cuts a column that is meant to be copied, and shrinks the others instead", () => {
    const ids = "b5e6f7a8-1234-5678-9abc-def012345678,0a1b2c3d-4e5f-6789-abcd-ef0123456789";
    const table = toTable([{ name: "A company with a rather long name", ids }], [{ key: "name" }, { key: "ids", whole: true }], 60);
    const row = table.trimEnd().split("\n")[1] ?? "";
    expect(row.endsWith(ids)).toBe(true);
    expect(row.startsWith("A compa…")).toBe(true);
  });

  it("aligns key/value pairs and leaves empty values out", () => {
    expect(toKeyValue([["Title", "Engineer"], ["Company", null], ["Id", "x1"]])).toBe("Title  Engineer\nId     x1\n");
  });

  it("reads dot paths", () => {
    expect(getPath({ company: { name: "Acme" } }, "company.name")).toBe("Acme");
    expect(getPath({ company: null }, "company.name")).toBeUndefined();
  });
});

describe("search output in each format", () => {
  it("prints the API response as JSON when piped", async () => {
    const h = harness({ responder: twoJobs, env });
    await h.run("search", "x");
    const parsed = JSON.parse(h.stdout()) as { jobs: Array<{ id: string }>; total: number; page_size: number };
    expect(parsed.jobs.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(parsed).toMatchObject({ total: 2, page: 1, page_size: 10, total_pages: 1 });
  });

  it("prints a table in a terminal", async () => {
    const h = harness({ responder: twoJobs, env, tty: true, columns: 140 });
    await h.run("search", "x");
    const lines = h.stdout().trimEnd().split("\n");
    expect(lines[0]).toMatch(/^ID\s+TITLE\s+COMPANY\s+LOCATION\s+WORK MODEL\s+POSTED$/);
    expect(lines[1]).toMatch(/^a\s+Engineer a\s+Acme, Inc\.\s+Berlin, Germany\s+Remote\s+2026-11-18$/);
    expect(lines).toHaveLength(3);
  });

  it("says so instead of printing an empty table", async () => {
    const h = harness({
      responder: () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 })),
      env,
      tty: true,
    });
    await h.run("search", "x");
    expect(h.stdout()).toBe("No jobs matched.\n");
  });

  it("prints JSONL, one job per line", async () => {
    const h = harness({ responder: twoJobs, env });
    await h.run("search", "x", "--jsonl");
    const lines = h.stdout().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1] ?? "{}") as { id: string }).id).toBe("b");
  });

  it("prints CSV with flat columns", async () => {
    const h = harness({ responder: twoJobs, env });
    await h.run("search", "x", "--csv");
    const lines = h.stdout().trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "id,title,company.name,company.id,locations,workplace_type,employment_type,experience_level,compensation.min,compensation.max,compensation.currency,compensation.period,date_posted,source,listing_url,apply_url",
    );
    expect(lines[1]).toBe(
      'a,Engineer a,"Acme, Inc.",company-a,"Berlin, Germany",Remote,Full-time,Senior,100000,140000,EUR,yearly,2026-11-18T00:00:00Z,greenhouse,https://jobs.example/a,https://jobs.example/a/apply',
    );
    expect(lines[2]?.startsWith('b,"Say ""hi""","Acme, Inc.",company-b,"Berlin, Germany",,Full-time')).toBe(true);
  });

  it("--fields picks the columns and reduces JSON records to those keys", async () => {
    const csv = harness({ responder: twoJobs, env });
    await csv.run("search", "x", "--csv", "--fields", "id, company.name, locations");
    expect(csv.stdout()).toBe('id,company.name,locations\r\na,"Acme, Inc.","Berlin, Germany"\r\nb,"Acme, Inc.","Berlin, Germany"\r\n');

    const asJson = harness({ responder: twoJobs, env });
    await asJson.run("search", "x", "--fields", "id,company.name,nope");
    expect((JSON.parse(asJson.stdout()) as { jobs: unknown[] }).jobs).toEqual([
      { id: "a", "company.name": "Acme, Inc.", nope: null },
      { id: "b", "company.name": "Acme, Inc.", nope: null },
    ]);

    const table = harness({ responder: twoJobs, env, tty: true });
    await table.run("search", "x", "--fields", "title,company.name");
    expect(table.stdout().split("\n")[0]).toMatch(/^TITLE\s+COMPANY\.NAME$/);
  });

  it("--fields with JSON only picks keys: every value stays as the API returned it", async () => {
    const locations = [{ location: "Berlin, Germany", city: "Berlin", region: "Berlin", country: "Germany" }];
    const picked = { id: "a", locations, date_posted: "2026-11-18T00:00:00Z", "company.name": "Acme, Inc.", compensation: { min: 100000, max: 140000, currency: "EUR", period: "yearly" } };

    const asJson = harness({ responder: twoJobs, env });
    await asJson.run("search", "x", "--json", "--fields", "id,locations,date_posted,company.name,compensation");
    expect((JSON.parse(asJson.stdout()) as { jobs: unknown[] }).jobs[0]).toEqual(picked);

    const asJsonl = harness({ responder: twoJobs, env });
    await asJsonl.run("search", "x", "--jsonl", "--fields", "id,locations,date_posted,company.name,compensation");
    expect(JSON.parse(asJsonl.stdout().split("\n")[0] ?? "{}")).toEqual(picked);

    // The feed streams JSONL by default, and a single record follows the same rule.
    const feed = harness({ responder: () => json(200, { jobs: [job("a")], next_cursor: null, has_more: false }), env });
    await feed.run("feed", "--max", "1", "--fields", "locations,date_posted");
    expect(JSON.parse(feed.stdout())).toEqual({ locations, date_posted: "2026-11-18T00:00:00Z" });

    const one = harness({ responder: () => json(200, job("a")), env });
    await one.run("job", "a", "--fields", "locations,date_posted");
    expect(JSON.parse(one.stdout())).toEqual({ locations, date_posted: "2026-11-18T00:00:00Z" });
  });

  it("--fields in a table or CSV keeps the formatted cell", async () => {
    const table = harness({ responder: twoJobs, env, tty: true });
    await table.run("search", "x", "--fields", "id,locations,date_posted");
    expect(table.stdout().split("\n")[1]).toMatch(/^a\s+Berlin, Germany\s+2026-11-18$/);

    const csv = harness({ responder: twoJobs, env });
    await csv.run("search", "x", "--csv", "--fields", "id,locations,date_posted");
    expect(csv.stdout().split("\r\n")[1]).toBe('a,"Berlin, Germany",2026-11-18T00:00:00Z');
  });
});

describe("--output", () => {
  it("writes the file, keeps stdout empty, and takes the format from the extension", async () => {
    const h = harness({ responder: twoJobs, env });
    expect(await h.run("search", "x", "--output", "jobs.jsonl")).toBe(0);
    expect(h.stdout()).toBe("");
    expect(readFileSync(join(h.cwd, "jobs.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("refuses to overwrite, before any request is sent", async () => {
    const h = harness({ responder: twoJobs, env });
    writeFileSync(join(h.cwd, "jobs.json"), "keep me");
    expect(await h.run("search", "x", "-o", "jobs.json")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(readFileSync(join(h.cwd, "jobs.json"), "utf8")).toBe("keep me");
    expect(h.stderr()).toContain("--overwrite");
  });

  it("--overwrite replaces the file", async () => {
    const h = harness({ responder: twoJobs, env });
    writeFileSync(join(h.cwd, "jobs.json"), "old");
    expect(await h.run("search", "x", "-o", "jobs.json", "--overwrite")).toBe(0);
    expect((JSON.parse(readFileSync(join(h.cwd, "jobs.json"), "utf8")) as { jobs: unknown[] }).jobs).toHaveLength(2);
  });

  it("--append adds rows and does not repeat the CSV header", async () => {
    const h = harness({ responder: twoJobs, env });
    await h.run("search", "x", "-o", "jobs.csv", "--fields", "id");
    await h.run("search", "x", "-o", "jobs.csv", "--fields", "id", "--append");
    expect(readFileSync(join(h.cwd, "jobs.csv"), "utf8")).toBe("id\r\na\r\nb\r\na\r\nb\r\n");
  });

  it("--append is refused for a format that cannot be extended", async () => {
    const h = harness({ responder: twoJobs, env });
    expect(await h.run("search", "x", "-o", "jobs.json", "--append")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(existsSync(join(h.cwd, "jobs.json"))).toBe(false);
  });

  it("--overwrite without --output is a usage error", async () => {
    const h = harness({ responder: twoJobs, env });
    expect(await h.run("search", "x", "--overwrite")).toBe(2);
    expect(h.requests).toHaveLength(0);
  });

  it("a run that fails leaves no empty file behind, so the retry is not refused", async () => {
    let healthy = false;
    const h = harness({ responder: (request, index) => (healthy ? twoJobs() : json(500, { title: "Server error", index, url: request.url })), env });
    for (const file of ["jobs.json", "jobs.jsonl", "jobs.csv"]) {
      expect(await h.run("search", "x", "-o", file), file).toBe(7);
      expect(existsSync(join(h.cwd, file)), `${file} was left behind`).toBe(false);
    }
    healthy = true;
    expect(await h.run("search", "x", "-o", "jobs.json")).toBe(0);
    expect((JSON.parse(readFileSync(join(h.cwd, "jobs.json"), "utf8")) as { jobs: unknown[] }).jobs).toHaveLength(2);
  });

  it("does the same for every command that writes a file", async () => {
    const commands = [
      ["job", "abc"],
      ["company", "abc"],
      ["companies", "stripe"],
      ["locations", "berlin"],
      ["geocode", "Berlin"],
      ["filters"],
      ["filters", "skills"],
      ["occupations"],
      ["expired"],
      ["usage"],
      ["feed", "--max", "5"],
    ];
    for (const argv of commands) {
      const h = harness({ responder: () => json(401, { error: "Invalid or expired API key" }), env });
      expect(await h.run(...argv, "-o", "out.json"), argv.join(" ")).toBe(3);
      expect(existsSync(join(h.cwd, "out.json")), `jobo ${argv.join(" ")} left a file behind`).toBe(false);
    }
  });

  it("keeps an empty result's file: nothing matched is an answer, not a failure", async () => {
    const h = harness({ responder: () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 })), env });
    expect(await h.run("search", "x", "-o", "none.jsonl")).toBe(0);
    expect(readFileSync(join(h.cwd, "none.jsonl"), "utf8")).toBe("");
  });

  it("--overwrite keeps the old file when the run fails, and replaces it when it succeeds", async () => {
    let healthy = false;
    const h = harness({ responder: () => (healthy ? twoJobs() : json(500, { title: "Server error" })), env });
    writeFileSync(join(h.cwd, "jobs.jsonl"), "a long line of yesterday's results\n");
    expect(await h.run("search", "x", "-o", "jobs.jsonl", "--overwrite")).toBe(7);
    expect(readFileSync(join(h.cwd, "jobs.jsonl"), "utf8")).toBe("a long line of yesterday's results\n");

    healthy = true;
    expect(await h.run("search", "x", "-o", "jobs.jsonl", "--overwrite", "--fields", "id")).toBe(0);
    expect(readFileSync(join(h.cwd, "jobs.jsonl"), "utf8")).toBe('{"id":"a"}\n{"id":"b"}\n');
  });

  it("--append to a file that does not exist yet removes it again when the run fails", async () => {
    const h = harness({ responder: () => json(500, { title: "Server error" }), env });
    expect(await h.run("feed", "--max", "5", "-o", "feed.jsonl", "--append")).toBe(7);
    expect(existsSync(join(h.cwd, "feed.jsonl"))).toBe(false);
  });

  it("an unwritable path fails before anything is requested", async () => {
    const h = harness({ responder: twoJobs, env });
    expect(await h.run("search", "x", "-o", "no-such-dir/jobs.json")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain(`Cannot write to ${join(h.cwd, "no-such-dir", "jobs.json")}: its directory does not exist.`);
  });
});

describe("shellWord", () => {
  it("leaves a safe value bare and quotes the rest for pasting", () => {
    expect(shellWord("country=Germany,region=Berlin,city=Berlin")).toBe("country=Germany,region=Berlin,city=Berlin");
    expect(shellWord("b5e6f7a8-1234-5678-9abc-def012345678,stripe.com")).toBe("b5e6f7a8-1234-5678-9abc-def012345678,stripe.com");
    expect(shellWord("country=United States,city=New York")).toBe('"country=United States,city=New York"');
    expect(shellWord("Côte d'Ivoire")).toBe(`"Côte d'Ivoire"`);
    expect(shellWord('5" $HOME')).toBe(`'5" $HOME'`);
    expect(shellWord(`it's "$5"`)).toBe(`'it'\\''s "$5"'`);
  });
});
