import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { flag, str, type CommandDef, type Ctx } from "../args";
import { CliError, UsageError } from "../errors";

export const SKILL_NAME = "jobo-job-search";

/**
 * The skill folder shipped in the package. It sits next to `dist/` when
 * installed and next to `src/` in the repo, so walk up from this file until
 * it turns up.
 */
export function bundledSkillDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, "skills", SKILL_NAME);
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    dir = dirname(dir);
  }
  throw new CliError("The bundled skill is missing from this installation. Reinstall jobo-cli.");
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

async function install(ctx: Ctx): Promise<number> {
  if (ctx.positionals.length > 0) throw new UsageError("jobo skill install takes no arguments. Choose the destination with --dir or --project.");
  const dir = str(ctx.values, "dir");
  const project = flag(ctx.values, "project");
  if (dir && project) throw new UsageError("Use --dir or --project, not both.");

  const skillsDir = dir
    ? resolve(ctx.io.cwd, expandHome(dir, ctx.io.homedir))
    : project
      ? join(ctx.io.cwd, ".claude", "skills")
      : join(ctx.io.homedir, ".claude", "skills");
  const target = join(skillsDir, SKILL_NAME);

  if (existsSync(target) && !flag(ctx.values, "overwrite")) {
    throw new UsageError(`${target} already exists. Pass --overwrite to replace its files with this version's.`);
  }
  mkdirSync(skillsDir, { recursive: true });
  cpSync(bundledSkillDir(), target, { recursive: true, force: true });
  await ctx.io.stdout.write(`Installed the ${SKILL_NAME} skill to ${target}\n`);
  return 0;
}

async function path(ctx: Ctx): Promise<number> {
  await ctx.io.stdout.write(`${bundledSkillDir()}\n`);
  return 0;
}

async function show(ctx: Ctx): Promise<number> {
  await ctx.io.stdout.write(readFileSync(join(bundledSkillDir(), "SKILL.md"), "utf8"));
  return 0;
}

export const skillCommand: CommandDef = {
  name: "skill",
  summary: "Install or print the Agent Skill that teaches coding agents this CLI",
  usage: ["install [--dir PATH | --project] [--overwrite]", "path", "show"],
  description:
    `The package ships an Agent Skill, ${SKILL_NAME}: a SKILL.md that tells a coding agent when and how to use this CLI, including the cost rules. ` +
    "Install it where your agent loads skills from, or print it to paste into an AGENTS.md.",
  subcommands: [
    {
      name: "install",
      summary: "Copy the skill into a skills directory",
      usage: ["[--dir PATH | --project] [--overwrite]"],
      description: `Copies the skill folder to <skills directory>/${SKILL_NAME}. The skills directory is ~/.claude/skills by default, ./.claude/skills with --project, or whatever --dir names.`,
      options: {
        dir: { type: "string", value: "PATH", description: "Skills directory to install into." },
        project: { type: "boolean", description: "Install into ./.claude/skills of the current directory." },
        overwrite: { type: "boolean", description: "Replace an existing copy of the skill." },
      },
      examples: ["jobo skill install", "jobo skill install --project", "jobo skill install --dir ~/.agents/skills --overwrite"],
      run: install,
    },
    { name: "path", summary: "Print where the bundled skill folder lives", usage: [""], run: path },
    {
      name: "show",
      summary: "Print SKILL.md",
      usage: [""],
      examples: ["jobo skill show >> AGENTS.md"],
      run: show,
    },
  ],
};
