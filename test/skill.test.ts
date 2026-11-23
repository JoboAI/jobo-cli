import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/cli";
import { GLOBAL_OPTIONS, OUTPUT_OPTIONS, optionNames, optionsFor, parseCommandArgs, type CommandDef } from "../src/args";
import { SKILL_NAME, bundledSkillDir } from "../src/commands/skill";
import pkg from "../package.json";
import { LIVE_KEY, harness, json } from "./helpers";

const skillFile = join(bundledSkillDir(), "SKILL.md");
const skillText = readFileSync(skillFile, "utf8");

function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error("SKILL.md has no YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const index = line.indexOf(":");
    if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return fields;
}

/** Every flag any command accepts, aliases included. */
function knownFlags(): Set<string> {
  const flags = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(OUTPUT_OPTIONS)]);
  for (const command of [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])]) {
    for (const name of optionNames(command.options ?? {}).keys()) flags.add(name);
  }
  return flags;
}

/** The `jobo …` command lines in a document's fenced code blocks, with `\` continuations joined. */
function commandLines(text: string): string[] {
  const lines: string[] = [];
  for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").replace(/\s*\\\n\s*/g, " ").split("\n")) {
      if (line.trim().startsWith("jobo ")) lines.push(line.trim());
    }
  }
  return lines;
}

/** Split a command line the way a shell would: quotes group, and a comment, pipe or redirect ends it. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else word = (word ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (char === " " || char === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if ((char === "#" && word === null) || char === "|" || char === ">") {
      break;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** A body every command can read: each one picks the keys of its own endpoint. */
const anything = () =>
  json(200, {
    jobs: [],
    total: 0,
    page: 1,
    page_size: 10,
    total_pages: 0,
    facets: {},
    next_cursor: null,
    has_more: false,
    job_ids: [],
    suggestions: [],
    options: [],
    enums: {},
    sources: [],
    categories: [],
    version: "v1",
    succeeded: true,
  });

/**
 * Run a documented command line for real, against a backend that answers
 * anything: the flags have to exist, the values have to be valid and the
 * command must not be refused. `jobo login`, `jobo auth` and `jobo logout` are
 * only parsed, since they wait for a sign-in, prompt for a key, or save or
 * remove one.
 */
async function runDocumented(line: string): Promise<void> {
  const [program, name, ...rest] = shellWords(line);
  expect(program, line).toBe("jobo");
  const top = COMMANDS.find((entry) => entry.name === name);
  if (name === "--help" || name === "--version") return;
  expect(top, `${line}: no such command`).toBeDefined();
  const sub = top?.subcommands?.find((entry) => entry.name === rest[0]);
  expect(() => parseCommandArgs(sub ? rest.slice(1) : rest, optionsFor((sub ?? top) as CommandDef)), line).not.toThrow();
  if (name === "login" || name === "auth" || name === "logout") return;

  const h = harness({ env: { JOBO_API_KEY: LIVE_KEY }, responder: anything });
  writeFileSync(join(h.cwd, "feed.json"), '{"job_subcategories":{"include":["Nursing"]}}');
  const code = await h.run(name ?? "", ...rest);
  expect(code, `${line}\n${h.stderr()}`).toBe(0);
}

/**
 * `--flags` a document mentions, ignoring those of other tools (`claude mcp
 * add --transport`) and the mistyped one an "Unknown flag" error is quoted for.
 */
function mentionedFlags(text: string): string[] {
  const own = text
    .split("\n")
    .filter((line) => !/\b(claude|codex|npm|npx|curl) /.test(line) || /\bjobo /.test(line))
    .map((line) => line.replace(/Unknown flag --[a-z-]+/, "Unknown flag"))
    .join("\n");
  return [...new Set([...own.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((match) => match[1] ?? ""))].filter(
    // "--exclude-" on its own is prose for the family of exclude flags.
    (name) => !name.endsWith("-"),
  );
}

describe("the bundled skill", () => {
  it("has the frontmatter an Agent Skill needs", () => {
    const fields = frontmatter(skillText);
    expect(fields.name).toBe(SKILL_NAME);
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(bundledSkillDir().endsWith(SKILL_NAME)).toBe(true);
    expect((fields.description ?? "").length).toBeGreaterThan(80);
    expect((fields.description ?? "").length).toBeLessThanOrEqual(1024);
    expect(fields.description).toMatch(/Use when/);
  });

  it("covers the cost rules an agent has to respect", () => {
    expect(skillText).toMatch(/bills every job it returns/);
    expect(skillText).toMatch(/--page-size/);
    expect(skillText).toMatch(/--max N/);
    expect(skillText).toMatch(/`jobo job`/);
    expect(skillText).toMatch(/refuses to run without `--max N` or `--all`/);
    expect(skillText).toMatch(/jobo filters/);
  });

  it("only mentions flags that exist", () => {
    const flags = knownFlags();
    const unknown = mentionedFlags(skillText).filter((name) => !flags.has(name));
    expect(unknown).toEqual([]);
  });

  it("only mentions commands that exist", () => {
    const names = new Set(COMMANDS.map((command) => command.name));
    const used = [...skillText.matchAll(/\bjobo ([a-z]+)\b/g)].map((match) => match[1] ?? "");
    // "jobo job search" in the title and prose names the product, not a command.
    const unknown = [...new Set(used)].filter((name) => !names.has(name) && !["cli", "jobs"].includes(name));
    expect(unknown).toEqual([]);
  });

  it("ships in the npm package", () => {
    expect(pkg.files).toContain("skills");
    expect(pkg.bin).toEqual({ jobo: "dist/index.js" });
  });
});

describe("the README", () => {
  const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");

  it("only mentions flags that exist", () => {
    const flags = knownFlags();
    const unknown = mentionedFlags(readme).filter((name) => !flags.has(name));
    expect(unknown).toEqual([]);
  });

  it("has a section for every command", () => {
    for (const command of COMMANDS) expect(readme, command.name).toContain(`jobo ${command.name}`);
  });

  it("does not suggest the feed has an --exclude-locations flag", () => {
    expect(readme).not.toMatch(/exclude-locations/);
    expect(optionNames(optionsFor(COMMANDS.find((command) => command.name === "feed") as CommandDef)).has("exclude-locations")).toBe(false);
    // The sentence that lists the flags with an exclude twin must not have --locations among them.
    for (const sentence of readme.replace(/\s+/g, " ").split(/(?<=[.;]) /)) {
      if (/`--exclude-` twin/.test(sentence)) expect(sentence, sentence).not.toMatch(/`--locations`/);
    }
  });
});

describe("every documented command line runs", () => {
  const documents: Array<[string, string]> = [
    ["README.md", join(__dirname, "..", "README.md")],
    ["SKILL.md", skillFile],
    // Lives outside the package; absent from the public mirror of cli/.
    ["docs/connectors/cli.mdx", join(__dirname, "..", "..", "..", "docs", "connectors", "cli.mdx")],
  ];

  for (const [label, path] of documents) {
    const lines = existsSync(path) ? commandLines(readFileSync(path, "utf8")) : [];
    it.skipIf(lines.length === 0).each(lines)(`${label}: %s`, async (line) => {
      await runDocumented(line);
    });
  }

  const examples = [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])].flatMap((command) => command.examples ?? []);
  it.each(examples.filter((example) => example.startsWith("jobo ")))("--help example: %s", async (line) => {
    await runDocumented(line);
  });

  it("finds the command lines it is meant to check", () => {
    expect(commandLines("```bash\njobo search x \\\n  --page-size 5   # five\njobo feed --max 1 > out.jsonl\n```")).toEqual([
      "jobo search x --page-size 5   # five",
      "jobo feed --max 1 > out.jsonl",
    ]);
    expect(shellWords('jobo search "data engineer" --location \'Berlin, Germany\' --q=""   # note')).toEqual([
      "jobo",
      "search",
      "data engineer",
      "--location",
      "Berlin, Germany",
      "--q=",
    ]);
    expect(shellWords("jobo occupations --jsonl | grep -i nurse")).toEqual(["jobo", "occupations", "--jsonl"]);
    expect(commandLines(readFileSync(join(__dirname, "..", "README.md"), "utf8")).length).toBeGreaterThan(30);
  });
});

describe("jobo skill", () => {
  it("path prints the bundled folder", async () => {
    const h = harness();
    expect(await h.run("skill", "path")).toBe(0);
    expect(h.stdout().trim()).toBe(bundledSkillDir());
    expect(existsSync(join(h.stdout().trim(), "SKILL.md"))).toBe(true);
  });

  it("show prints SKILL.md verbatim", async () => {
    const h = harness();
    expect(await h.run("skill", "show")).toBe(0);
    expect(h.stdout()).toBe(skillText);
  });

  it("installs into ~/.claude/skills by default", async () => {
    const h = harness();
    expect(await h.run("skill", "install")).toBe(0);
    const installed = join(h.home, ".claude", "skills", SKILL_NAME, "SKILL.md");
    expect(readFileSync(installed, "utf8")).toBe(skillText);
    expect(h.stdout()).toContain(join(h.home, ".claude", "skills", SKILL_NAME));
  });

  it("--project installs into ./.claude/skills", async () => {
    const h = harness();
    expect(await h.run("skill", "install", "--project")).toBe(0);
    expect(existsSync(join(h.cwd, ".claude", "skills", SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(existsSync(join(h.home, ".claude"))).toBe(false);
  });

  it("--dir installs anywhere, relative to the working directory or ~", async () => {
    const h = harness();
    expect(await h.run("skill", "install", "--dir", "agents/skills")).toBe(0);
    expect(existsSync(join(h.cwd, "agents", "skills", SKILL_NAME, "SKILL.md"))).toBe(true);
    expect(await h.run("skill", "install", "--dir", "~/.agents/skills")).toBe(0);
    expect(existsSync(join(h.home, ".agents", "skills", SKILL_NAME, "SKILL.md"))).toBe(true);
  });

  it("leaves an existing copy alone unless --overwrite", async () => {
    const h = harness();
    const target = join(h.home, ".claude", "skills", SKILL_NAME);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "my edits");
    expect(await h.run("skill", "install")).toBe(2);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("my edits");
    expect(h.stderr()).toContain("--overwrite");
    expect(await h.run("skill", "install", "--overwrite")).toBe(0);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(skillText);
  });

  it("refuses --dir with --project, and an unknown subcommand", async () => {
    const h = harness();
    expect(await h.run("skill", "install", "--dir", "x", "--project")).toBe(2);
    expect(await h.run("skill", "uninstall")).toBe(2);
    expect(h.stderr()).toContain("install, path, show");
  });

  it("with no subcommand prints its help", async () => {
    const h = harness();
    expect(await h.run("skill")).toBe(0);
    expect(h.stdout()).toContain("jobo skill install");
  });
});
