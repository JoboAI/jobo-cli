import { describe, expect, it } from "vitest";

import {
  optionHelp,
  optionNames,
  optionsFor,
  parseCommandArgs,
  renderHelp,
  type CommandDef,
  type OptionSpec,
  type OptionSpecs,
} from "../src/args";
import { COMMANDS } from "../src/cli";
import { feedCommand } from "../src/commands/feed";
import { searchCommand } from "../src/commands/search";
import { UsageError } from "../src/errors";
import { otherNumber } from "../src/filters";
import { LIVE_KEY, harness, json, searchPage } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };
const empty = () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 }));
const emptyFeed = () => json(200, { jobs: [], next_cursor: null, has_more: false });

const SPECS: OptionSpecs = {
  model: { type: "string", multiple: true, split: true, aliases: ["models"], description: "A model.", choices: ["remote", "on-site"] },
  sort: { type: "string", description: "An order.", choices: ["relevance", "newest"] },
  name: { type: "string", value: "TEXT", description: "A name." },
  output: { type: "string", short: "o", description: "A file." },
  json: { type: "boolean", description: "JSON." },
};

const parse = (...argv: string[]) => parseCommandArgs(argv, SPECS);
const message = (...argv: string[]): string => {
  try {
    parse(...argv);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`expected ${argv.join(" ")} to be refused`);
};

describe("parseCommandArgs", () => {
  it("reads flags, values and arguments", () => {
    expect(parse("first", "--name", "x y", "--json", "-o", "out.csv", "--sort=newest", "--", "--literal")).toEqual({
      values: { name: "x y", json: true, output: "out.csv", sort: "newest" },
      positionals: ["first", "--literal"],
    });
  });

  it("explains an unknown flag in our words and names the nearest one", () => {
    expect(message("--sotr", "newest")).toBe("Unknown flag --sotr. Did you mean --sort?");
    expect(message("--outptu=x")).toBe("Unknown flag --outptu. Did you mean --output?");
    // One dash too few arrives as a group of short flags; the word is reported as typed.
    expect(message("-json")).toBe("Unknown flag -json. Did you mean --json?");
    expect(message("--name_x")).not.toContain("positional");
  });

  it("makes no guess when nothing is close, and says how to pass a value that starts with a dash", () => {
    expect(message("--zzzzzz")).toBe("Unknown flag --zzzzzz.");
    expect(message("-q")).toBe('Unknown flag -q. To pass a value that starts with "-", put it after "--".');
  });

  it("suggests the real flag when the typo is nearest to an alias", () => {
    expect(message("--modelss")).toBe("Unknown flag --modelss. Did you mean --model?");
  });

  it("says when a flag is missing its value, or was given one it does not take", () => {
    expect(message("--name")).toBe("--name needs a value: --name <TEXT>.");
    expect(message("--json=yes")).toBe('--json takes no value (got "yes").');
    expect(message("--name", "--json")).toBe(
      '--name needs a value, and "--json" looks like another flag. If it is the value, write --name=--json.',
    );
    expect(parse("--name=--json").values).toEqual({ name: "--json" });
  });

  it("lands an alias on its option, merged with the real spelling", () => {
    expect(parse("--models", "remote", "--model", "on-site").values).toEqual({ model: ["remote", "on-site"] });
  });

  it("accepts a fixed value in any case or separator style and returns its canonical spelling", () => {
    expect(parse("--model", "REMOTE,On Site", "--sort", "Newest").values).toEqual({ model: ["remote,on-site"], sort: "newest" });
    expect(parse("--model", "onsite").values).toEqual({ model: ["on-site"] });
  });

  it("refuses a value outside the set, with the nearest one and the whole list", () => {
    expect(message("--sort", "newst")).toBe('--sort: unknown value "newst". Did you mean "newest"? Valid values: relevance, newest.');
    expect(message("--model", "remote,office")).toBe('--model: unknown value "office". Valid values: remote, on-site.');
  });

  it("prefers a real flag name over another flag's alias", () => {
    const specs: OptionSpecs = {
      location: { type: "string", aliases: ["locations"], description: "One place." },
      locations: { type: "string", description: "Structured places." },
    };
    expect(optionNames(specs).get("locations")).toBe("locations");
    expect(parseCommandArgs(["--locations", "x"], specs).values).toEqual({ locations: "x" });
  });
});

describe("help is rendered from the same spec", () => {
  it("lists a closed set once, after the description and before the syntax hint", () => {
    expect(optionHelp({ type: "string", multiple: true, description: "Only these.", choices: ["a", "b"], hint: "Repeat the flag." })).toBe(
      "Only these. Any of: a, b. Repeat the flag.",
    );
    expect(optionHelp({ type: "string", description: "The order.", choices: ["a", "b"] })).toBe("The order. One of: a, b.");
    // <true|false> already says it.
    expect(optionHelp({ type: "string", value: "true|false", description: "Whether.", choices: ["true", "false"] })).toBe("Whether.");
  });

  it("shows every option's choices in its command's help", () => {
    for (const command of [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])]) {
      const help = renderHelp(command, `jobo ${command.name}`).replace(/\s+/g, " ");
      for (const [name, spec] of Object.entries(optionsFor(command))) {
        for (const value of spec.choices ?? []) expect(help, `${command.name} --${name}: ${value}`).toContain(value);
      }
    }
  });

  it("has no help text copied from the connector contract", () => {
    for (const command of [searchCommand, feedCommand]) {
      for (const [name, spec] of Object.entries(command.options ?? {})) {
        if (spec.group !== "Filters") continue;
        const help = optionHelp(spec);
        expect(help, `--${name}`).not.toMatch(/polling trigger|GET \/api\/|server-side|timestamp\b/i);
        // The values of a closed set are listed once, not once as prose and again as a list
        // ("Remote, hybrid or onsite. One of: remote, hybrid, onsite."). A default may be named on top of that.
        const words = help.toLowerCase().split(/[^a-z0-9_+-]+/);
        for (const value of spec.choices ?? []) {
          const mentions = words.filter((word) => word === value.toLowerCase()).length;
          expect(mentions, `--${name} says "${value}" ${mentions} times: ${help}`).toBeLessThanOrEqual(/default/.test(help) ? 2 : 1);
        }
      }
    }
  });

  it("gives --body, --industries and --company-primary-industries a worked example", () => {
    const help = (command: CommandDef, name: string) => optionHelp(optionsFor(command)[name] as OptionSpec);
    expect(help(feedCommand, "body")).toContain("--body @feed.json");
    expect(help(feedCommand, "body")).toContain(`--body '{"job_subcategories":{"include":["Nursing"]}}'`);
    // The value in the flag's own help (shared with its --exclude- twin), the whole flag in the examples.
    expect(help(feedCommand, "industries")).toContain('e.g. "Software Development"');
    expect(help(feedCommand, "exclude-industries")).toContain('e.g. "Software Development"');
    expect(help(feedCommand, "company-primary-industries")).toContain("e.g. Finance");
    expect(help(searchCommand, "industries")).toContain('e.g. "Software Development"');
    expect(feedCommand.examples?.join("\n")).toMatch(/--industries "Software Development"/);
    expect(feedCommand.examples?.join("\n")).toMatch(/--body @feed\.json/);
    expect(feedCommand.examples?.join("\n")).toMatch(/--company-primary-industries Finance/);
    expect(searchCommand.examples?.join("\n")).toMatch(/--industries "Software Development"/);
  });
});

describe("singular and plural filter flags", () => {
  it("knows the other number of a flag name", () => {
    expect(otherNumber("work-model")).toBe("work-models");
    expect(otherNumber("work-models")).toBe("work-model");
    expect(otherNumber("industries")).toBe("industry");
    expect(otherNumber("job-category")).toBe("job-categories");
    expect(otherNumber("occupation-ids")).toBe("occupation-id");
  });

  it("search takes the feed's plural spellings", async () => {
    const h = harness({ responder: empty, env });
    expect(
      await h.run("search", "--work-models", "remote", "--employment-types", "contract", "--experience-levels", "senior", "--languages", "en", "--locations", "Berlin, Germany", "--skill", "Python", "--company", "stripe.com"),
    ).toBe(0);
    expect(h.body()).toMatchObject({
      work_models: ["remote"],
      employment_types: ["contract"],
      experience_levels: ["senior"],
      languages: ["en"],
      locations: ["Berlin, Germany"],
      skills: { include: ["Python"] },
      companies: { include: ["stripe.com"] },
    });
  });

  it("the feed takes search's singular spellings, exclude twins included", async () => {
    const h = harness({ responder: emptyFeed, env });
    expect(
      await h.run("feed", "--max", "5", "--work-model", "remote", "--source", "greenhouse", "--exclude-employment-type", "internship", "--exclude-industry", "Gambling", "--job-category", "Healthcare", "--location", "Germany"),
    ).toBe(0);
    expect(h.body()).toEqual({
      locations: [{ country: "Germany" }],
      sources: ["greenhouse"],
      work_models: ["remote"],
      exclude_employment_types: ["internship"],
      job_categories: { include: ["Healthcare"] },
      industries: { exclude: ["Gambling"] },
      batch_size: 5,
    });
  });

  it("gives every list filter of both commands both spellings", () => {
    for (const command of [searchCommand, feedCommand]) {
      const names = optionNames(command.options ?? {});
      for (const [name, spec] of Object.entries(command.options ?? {})) {
        if (spec.group !== "Filters" || !spec.multiple) continue;
        expect(names.get(otherNumber(name)), `${command.name} --${otherNumber(name)}`).toBe(name);
      }
    }
  });

  it("the feed refuses a free-text place instead of sending it as a country", async () => {
    const h = harness({ responder: emptyFeed, env });
    expect(await h.run("feed", "--max", "5", "--location", "Berlin, Germany")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("country=Germany,city=Berlin");
    expect(h.stderr()).toContain("jobo locations");
  });
});

describe("--limit, --max and --query", () => {
  it("search and feed take --limit for --max", async () => {
    const search = harness({ responder: empty, env });
    await search.run("search", "x", "--limit", "7");
    expect(search.body()).toMatchObject({ page: 1, page_size: 7 });

    const feed = harness({ responder: emptyFeed, env });
    await feed.run("feed", "--limit", "30");
    expect(feed.body()).toEqual({ batch_size: 30 });
  });

  it("expired, filters, companies and locations take --max for --limit", async () => {
    const expired = harness({ env, responder: () => json(200, { job_ids: [], next_cursor: null, has_more: false }) });
    expect(await expired.run("expired", "--max", "40")).toBe(0);
    expect(new URL(expired.requests[0]?.url ?? "").searchParams.get("batch_size")).toBe("40");

    for (const argv of [["filters", "skills", "--max", "3"], ["companies", "stripe", "--max", "3"], ["locations", "berlin", "--max", "3"]]) {
      const h = harness({ env, responder: () => json(200, { options: [], suggestions: [] }) });
      expect(await h.run(...argv), argv.join(" ")).toBe(0);
      expect(new URL(h.requests[0]?.url ?? "").searchParams.get("limit")).toBe("3");
    }
  });

  it("search takes --query for --q", async () => {
    const h = harness({ responder: empty, env });
    expect(await h.run("search", "--query", "data engineer")).toBe(0);
    expect(h.body()).toMatchObject({ queries: ["data engineer"] });
  });
});

describe("mistyped input on the command line", () => {
  it("suggests the command that was meant", async () => {
    const h = harness();
    expect(await h.run("serach", "nurse")).toBe(2);
    expect(h.stderr()).toContain('Unknown command "serach". Did you mean `jobo search`?');
    expect(await h.run("help", "fed")).toBe(2);
    expect(h.stderr()).toContain("Did you mean `jobo feed`?");
  });

  it("suggests the subcommand that was meant", async () => {
    const h = harness();
    expect(await h.run("skill", "instal")).toBe(2);
    expect(h.stderr()).toContain("Did you mean `jobo skill install`? Available: install, path, show.");
  });

  it("never shows Node's own parser text for an unknown flag", async () => {
    const h = harness({ responder: empty, env });
    expect(await h.run("search", "nurse", "--work-modle", "remote")).toBe(2);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toBe("error: Unknown flag --work-modle. Did you mean --work-model?\nRun `jobo search --help` for usage.\n");
  });

  it("accepts the display-cased values a job carries", async () => {
    const h = harness({ responder: empty, env });
    expect(await h.run("search", "--work-model", "Remote,Hybrid", "--employment-type", "Full-time", "--sort", "DISCOVERED_ASC", "--search-description", "FALSE")).toBe(0);
    expect(h.body()).toMatchObject({ work_models: ["remote", "hybrid"], employment_types: ["full-time"], sort: "discovered_asc", search_description: false });

    const feed = harness({ responder: emptyFeed, env });
    expect(await feed.run("feed", "--max", "1", "--experience-levels", "Senior", "--company-is-agency", "False")).toBe(0);
    expect(feed.body()).toMatchObject({ experience_levels: ["senior"], company_is_agency: false });
  });

  it("names the nearest valid value of a fixed set", async () => {
    const h = harness({ responder: empty, env });
    expect(await h.run("search", "--employment-type", "fulltim")).toBe(2);
    expect(h.stderr()).toContain('--employment-type: unknown value "fulltim". Did you mean "full-time"?');
    expect(h.requests).toHaveLength(0);
  });
});
