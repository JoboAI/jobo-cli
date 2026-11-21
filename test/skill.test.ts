import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/cli";
import { GLOBAL_OPTIONS, OUTPUT_OPTIONS } from "../src/args";
import { SKILL_NAME, bundledSkillDir } from "../src/commands/skill";
import pkg from "../package.json";
import { harness } from "./helpers";

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

/** Every flag any command accepts. */
function knownFlags(): Set<string> {
  const flags = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(OUTPUT_OPTIONS)]);
  for (const command of [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])]) {
    for (const name of Object.keys(command.options ?? {})) flags.add(name);
  }
  return flags;
}

/** `--flags` a document mentions, ignoring those of other tools (`claude mcp add --transport`). */
function mentionedFlags(text: string): string[] {
  const own = text
    .split("\n")
    .filter((line) => !/\b(claude|codex|npm|npx|curl) /.test(line) || /\bjobo /.test(line))
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
