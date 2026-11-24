import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pkg from "../package.json";
import { LIVE_KEY, job } from "./helpers";

/**
 * The built artefact, run as a user runs it. `npm test` builds first, so this
 * is always the current source; nothing here leaves the machine: the one
 * end-to-end path talks to an HTTP server on 127.0.0.1.
 */
const BIN = join(__dirname, "..", "dist", "index.js");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];

function jobo(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const home = mkdtempSync(join(tmpdir(), "jobo-cli-bin-"));
  homes.push(home);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      // A clean environment: no real key, no real config directory.
      { env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, "config"), ...env }, cwd: home },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

describe("the built binary", () => {
  let server: Server;
  let apiUrl = "";
  const seen: Seen[] = [];

  beforeAll(async () => {
    expect(existsSync(BIN), "dist/index.js is missing: run `npm run build`").toBe(true);
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        if (request.headers["x-api-key"] !== LIVE_KEY) {
          response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid or expired API key" }));
          return;
        }
        if (request.method === "POST" && request.url === "/api/jobs/search") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { page_size: number };
          const jobs = Array.from({ length: body.page_size }, (_, index) => job(`e2e-${index + 1}`));
          response
            .writeHead(200, {
              "content-type": "application/json",
              "x-credits-deducted": String(jobs.length * 3),
              "x-credits-balance": "4991",
              "x-ratelimit-limit": "20",
              "x-ratelimit-remaining": "19",
            })
            .end(JSON.stringify({ jobs, total: 57, page: 1, page_size: body.page_size, total_pages: 19, facets: {} }));
          return;
        }
        if (request.method === "POST" && request.url === "/api/jobs/feed") {
          // One job, then a wallet that cannot cover the next batch: the run must end with exit 4.
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cursor?: string };
          if (body.cursor) {
            response.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: "Insufficient credits", detail: "Top up your wallet." }));
          } else {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ jobs: [job("feed-1")], next_cursor: "c1", has_more: true }));
          }
          return;
        }
        response.writeHead(404, { "content-type": "application/problem+json" }).end(JSON.stringify({ title: "Not Found", status: 404 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  it("starts with a node shebang", () => {
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("inlines the shared core: no runtime dependencies, no bare import of it", () => {
    expect(pkg.dependencies).toEqual({});
    expect(readFileSync(BIN, "utf8")).not.toMatch(/from ['"]@jobo-ai\/connector-core['"]/);
  });

  it("--version prints the package version", async () => {
    const result = await jobo(["--version"]);
    expect(result).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: "" });
  });

  it("--help lists the commands", async () => {
    const result = await jobo(["--help"]);
    expect(result.code).toBe(0);
    for (const name of ["auth", "search", "job", "feed", "expired", "company", "companies", "locations", "geocode", "filters", "occupations", "usage", "mcp", "skill", "completion"]) {
      expect(result.stdout).toContain(`  ${name}`);
    }
    expect(result.stderr).toBe("");
  });

  it("answers the shell's completion request, and stays silent with no key", async () => {
    expect(await jobo(["__complete", "--", "search", "--work-model", "remote,hy"])).toEqual({ code: 0, stdout: "remote,hybrid\n", stderr: "" });
    expect(await jobo(["__complete", "--", "search", "-o", ""])).toEqual({ code: 0, stdout: "__files__\n", stderr: "" });
    // A lookup that needs a key: none in this environment, so nothing is printed and nothing is sent.
    const before = seen.length;
    expect(await jobo(["__complete", "--", "search", "--sources", ""], { JOBO_API_URL: apiUrl })).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(seen.length).toBe(before);
  });

  it("prints a completion script per shell", async () => {
    for (const shell of ["bash", "zsh", "fish"]) {
      const result = await jobo(["completion", shell]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("jobo __complete -- ");
      expect(result.stderr).toBe("");
    }
  });

  it("explains an unknown flag itself, end to end", async () => {
    const result = await jobo(["search", "nurse", "--work-modle", "remote"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "error: Unknown flag --work-modle. Did you mean --work-model?\nRun `jobo search --help` for usage.\n",
    });
  });

  it("search --help lists the contract's flags", async () => {
    const result = await jobo(["search", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--exclude-skills");
    expect(result.stdout).toContain("--page-size");
  });

  it("skill show finds the skill next to dist/", async () => {
    const result = await jobo(["skill", "show"]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("---\nname: jobo-job-search\n")).toBe(true);
  });

  it("mcp prints a client's setup offline", async () => {
    // A coding agent gets the developer server, with the key read from the environment.
    const result = await jobo(["mcp", "claude-code"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'claude mcp add --transport http jobo-developer https://dev-mcp.jobo.world/mcp --header "Authorization: Bearer $JOBO_API_KEY"',
    );

    // An assistant gets job search.
    const assistant = await jobo(["mcp", "claude"]);
    expect(assistant.code).toBe(0);
    expect(assistant.stdout).toContain("jobo-job-search at https://jobs-mcp.jobo.world/mcp");
  });

  it("a command with no key exits 3 without sending anything", async () => {
    const before = seen.length;
    const result = await jobo(["search", "engineer"], { JOBO_API_URL: apiUrl });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No API key");
    expect(seen.length).toBe(before);
  });

  it("runs a search end to end against a local server", async () => {
    const before = seen.length;
    const result = await jobo(
      ["search", "data engineer", "--work-model", "remote", "--exclude-skills", "PHP", "--page-size", "3", "--fields", "id,title"],
      { JOBO_API_URL: apiUrl, JOBO_API_KEY: LIVE_KEY },
    );
    expect(result.code).toBe(0);

    const request = seen[before] as Seen;
    expect(seen.length).toBe(before + 1);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/jobs/search");
    expect(request.headers["x-api-key"]).toBe(LIVE_KEY);
    expect(request.headers["x-jobo-client"]).toBe("cli");
    expect(request.headers["user-agent"]).toBe(`jobo-cli/${pkg.version}`);
    expect(JSON.parse(request.body)).toEqual({
      queries: ["data engineer"],
      work_models: ["remote"],
      skills: { exclude: ["PHP"] },
      page: 1,
      page_size: 3,
    });

    // Piped stdout: JSON only. The cost is on stderr.
    const parsed = JSON.parse(result.stdout) as { jobs: unknown[]; total: number };
    expect(parsed.total).toBe(57);
    expect(parsed.jobs).toEqual([
      { id: "e2e-1", title: "Engineer e2e-1" },
      { id: "e2e-2", title: "Engineer e2e-2" },
      { id: "e2e-3", title: "Engineer e2e-3" },
    ]);
    expect(result.stderr).toContain("usage: 9 credits ($0.009) charged · wallet 4,991 credits ($4.991)");
    expect(result.stderr).toContain("3 of 57 matching jobs");
  });

  it("keeps running when the stderr reader goes away, and exits with the run's own code", async () => {
    const home = mkdtempSync(join(tmpdir(), "jobo-cli-bin-"));
    homes.push(home);
    const child = spawn(process.execPath, [BIN, "feed", "--max", "3", "--batch-size", "1"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, "config"), JOBO_API_URL: apiUrl, JOBO_API_KEY: LIVE_KEY },
      cwd: home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Close the reading end of stderr before the CLI writes its first progress line.
    child.stderr.destroy();
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
    // The first batch is written, the second is refused for credits: exit 4, not the 0 of a run cut short.
    expect(code).toBe(4);
    expect(stdout.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["feed-1"]);
  });

  it("maps an API 401 to exit 3 end to end", async () => {
    const wrong = `jbe_live_${"z".repeat(21)}_${"z".repeat(43)}`;
    const result = await jobo(["job", "abc"], { JOBO_API_URL: apiUrl, JOBO_API_KEY: wrong });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("https://enterprise.jobo.world/api-keys");
    expect(result.stdout).toBe("");
  });
});
