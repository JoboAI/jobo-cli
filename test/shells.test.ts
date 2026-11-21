import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMPLETION_SCRIPTS } from "../src/commands/completion";
import { LIVE_KEY } from "./helpers";

/**
 * The completion scripts, run by the shells they are for, against the built
 * binary: a `jobo` on PATH that is `dist/index.js`, and the free lookup
 * endpoints served from 127.0.0.1. A shell that is not installed is skipped.
 */
const BIN = join(__dirname, "..", "dist", "index.js");
const POSIX = process.platform !== "win32";

function installed(shell: string): boolean {
  if (!POSIX) return false;
  try {
    execFileSync(shell, ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A value no shell may expand: spaces, a comma, an ampersand, a command substitution and backticks. */
const HOSTILE = "R&D $(touch pwned) `touch pwned`";
const INDUSTRIES = ["Software Development", "Film, TV & Stage Production", HOSTILE];

describe.skipIf(!POSIX)("completion scripts in a real shell", () => {
  let dir = "";
  let server: Server;
  let env: Record<string, string> = {};

  beforeAll(async () => {
    expect(existsSync(BIN), "dist/index.js is missing: run `npm run build`").toBe(true);
    dir = mkdtempSync(join(tmpdir(), "jobo-cli-shell-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "jobo"), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
    chmodSync(join(dir, "bin", "jobo"), 0o755);
    for (const [shell, script] of Object.entries(COMPLETION_SCRIPTS)) writeFileSync(join(dir, `jobo.${shell}`), script);
    writeFileSync(join(dir, "results-file.jsonl"), "");

    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const options = url.pathname.endsWith("/industries") ? INDUSTRIES.map((key) => ({ key, count: 1 })) : [];
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ options, suggestions: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    env = {
      PATH: `${join(dir, "bin")}:/usr/local/bin:/usr/bin:/bin`,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
      JOBO_API_KEY: LIVE_KEY,
      JOBO_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  function shell(program: string, script: string, args: string[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(program, [...(program === "zsh" ? ["-f"] : ["--norc", "--noprofile"]), "-c", script, program, ...args], { env, cwd: dir }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${program} failed: ${stderr || error.message}`));
        else resolve(stdout.split("\n").filter(Boolean));
      });
    });
  }

  describe.skipIf(!installed("bash"))("bash", () => {
    // What readline would do with the reply: the words typed after `jobo`, the last one under the cursor.
    const complete = (...words: string[]) =>
      shell(
        "bash",
        `source "$1"; shift
         COMP_WORDS=(jobo "$@"); COMP_CWORD=$#
         _jobo_complete
         printf '%s\\n' "\${COMPREPLY[@]}"`,
        [join(dir, "jobo.bash"), ...words],
      );
    // The reply as the shell reads it back off the command line.
    const inserted = (...words: string[]) =>
      shell(
        "bash",
        `source "$1"; shift
         COMP_WORDS=(jobo "$@"); COMP_CWORD=$#
         _jobo_complete
         for candidate in "\${COMPREPLY[@]}"; do eval "set -- $candidate"; printf '%s\\n' "$1"; done`,
        [join(dir, "jobo.bash"), ...words],
      );

    it("parses", async () => {
      await shell("bash", 'bash -n "$1"', [join(dir, "jobo.bash")]);
    });

    it("completes commands, flags and fixed values", async () => {
      expect(await complete("sea")).toEqual(["search"]);
      expect(await complete("search", "--work-mo")).toEqual(["--work-model"]);
      expect(await complete("search", "--work-model", "")).toEqual(["remote", "hybrid", "onsite"]);
      expect(await complete("search", "--work-model", "remote,hy")).toEqual(["remote,hybrid"]);
      expect(await complete("filters", "job_c")).toEqual(["job_categories"]);
      expect(await complete("nosuchcommand", "")).toEqual([]);
    });

    it("completes --flag=value whether bash split the word (4 and later) or not (3)", async () => {
      expect(await complete("search", "--sort", "=", "rel")).toEqual(["relevance"]);
      expect(await complete("search", "--sort", "=")).toEqual(["relevance", "discovered_asc", "discovered_desc"]);
      expect(await complete("search", "--sort=rel")).toEqual(["relevance"]);
    });

    it("escapes a looked-up value so the shell reads it back as one literal word", async () => {
      expect(await inserted("search", "--industries", "")).toEqual(INDUSTRIES);
      expect(await inserted("search", "--industries", "Fil")).toEqual(["Film, TV & Stage Production"]);
      expect(existsSync(join(dir, "pwned")), "a candidate was executed").toBe(false);
    });

    it("leaves a value unescaped inside quotes, where readline closes the quote", async () => {
      expect(await complete("search", "--industries", '"Fil')).toEqual(["Film, TV & Stage Production"]);
    });

    it("falls back to file names where a file goes", async () => {
      expect(await complete("search", "-o", "results-f")).toEqual(["results-file.jsonl"]);
    });
  });

  describe.skipIf(!installed("zsh"))("zsh", () => {
    // compadd, compdef and _files only exist inside the completion system: stand-ins record what the script hands them.
    const complete = (...words: string[]) =>
      shell(
        "zsh",
        `compdef() { print -r -- "compdef $*" }
         compadd() { while [[ $1 == -* ]]; do if [[ $1 == -- ]]; then shift; break; fi; shift; done; print -rl -- "$@" }
         _files() { print -r -- "_files" }
         source "$1"; shift
         words=(jobo "$@"); CURRENT=$#words
         _jobo`,
        [join(dir, "jobo.zsh"), ...words],
      );

    it("parses, and registers itself when sourced", async () => {
      await shell("zsh", 'zsh -n "$1"', [join(dir, "jobo.zsh")]);
      expect((await complete("sea"))[0]).toBe("compdef _jobo jobo");
    });

    it("completes commands, flags and fixed values", async () => {
      expect((await complete("sea")).slice(1)).toEqual(["search"]);
      expect((await complete("search", "--work-model", "")).slice(1)).toEqual(["remote", "hybrid", "onsite"]);
      expect((await complete("search", "--work-model", "remote,hy")).slice(1)).toEqual(["remote,hybrid"]);
      expect((await complete("search", "--sort=rel")).slice(1)).toEqual(["--sort=relevance"]);
      expect((await complete("nosuchcommand", "")).slice(1)).toEqual([]);
    });

    it("hands looked-up values over untouched, for zsh to quote", async () => {
      expect((await complete("search", "--industries", "")).slice(1)).toEqual(INDUSTRIES);
      // The word arrives as typed, quote and all; zsh's (Q) flag and jobo take the quote off.
      expect((await complete("search", "--industries", '"Fil')).slice(1)).toEqual(["Film, TV & Stage Production"]);
      expect(existsSync(join(dir, "pwned")), "a candidate was executed").toBe(false);
    });

    it("falls back to _files where a file goes", async () => {
      expect((await complete("search", "-o", "res")).slice(1)).toEqual(["_files"]);
    });
  });

  describe.skipIf(!installed("fish"))("fish", () => {
    it("parses", () => {
      execFileSync("fish", ["--no-execute", join(dir, "jobo.fish")], { env, cwd: dir });
    });
  });
});
