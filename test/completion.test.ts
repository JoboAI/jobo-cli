import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMMANDS, rootHelp } from "../src/cli";
import { COMPLETION_SCRIPTS } from "../src/commands/completion";
import { MCP_CLIENTS } from "../src/commands/mcp";
import { COMPLETE_COMMAND, FILES, rejoin } from "../src/complete";
import { saveKey } from "../src/config";
import { FILTER_FACETS } from "../src/filters";
import { LIVE_KEY, harness, json, type Harness, type HarnessOptions } from "./helpers";

const env = { JOBO_API_KEY: LIVE_KEY };

/** What TAB would offer after `jobo <words…>`; the last word is the one being typed. */
async function candidates(h: Harness, ...words: string[]): Promise<string[]> {
  const before = h.stdout().length;
  expect(await h.run(COMPLETE_COMMAND, "--", ...words)).toBe(0);
  expect(h.stderr(), "a completion never writes to stderr").toBe("");
  return h.stdout().slice(before).split("\n").filter(Boolean);
}

const path = (h: Harness, index = 0) => new URL(h.requests[index]?.url ?? "http://none").pathname;
const param = (h: Harness, name: string, index = 0) => new URL(h.requests[index]?.url ?? "http://none").searchParams.get(name);

/** A facet endpoint holding `values`, answering prefix queries the way the API does. */
function facets(values: Record<string, string[]>) {
  return (request: { url: string }) => {
    const url = new URL(request.url);
    const facet = url.pathname.split("/").pop() ?? "";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const options = (values[facet] ?? []).filter((value) => value.toLowerCase().startsWith(q)).map((key) => ({ key, count: 1 }));
    return json(200, { facet, options });
  };
}

describe("jobo __complete: commands, flags and fixed values", () => {
  it("is hidden: not a command, not in the help, not offered", async () => {
    expect(COMMANDS.map((command) => command.name)).not.toContain(COMPLETE_COMMAND);
    expect(rootHelp()).not.toContain(COMPLETE_COMMAND);
    expect(await candidates(harness(), "__")).toEqual([]);
  });

  it("completes commands, and `help <command>`", async () => {
    const h = harness();
    expect(await candidates(h, "")).toEqual([...COMMANDS.map((command) => command.name), "help"]);
    expect(await candidates(h, "se")).toEqual(["search"]);
    expect(await candidates(h, "co")).toEqual(["company", "companies", "completion"]);
    expect(await candidates(h, "help", "f")).toEqual(["feed", "filters"]);
    expect(await candidates(h, "-")).toEqual(["--help", "--version"]);
  });

  it("completes subcommands", async () => {
    const h = harness();
    expect(await candidates(h, "skill", "")).toEqual(["install", "path", "show"]);
    expect(await candidates(h, "skill", "ins")).toEqual(["install"]);
    expect(await candidates(h, "skill", "install", "--pr")).toEqual(["--project"]);
  });

  it("completes the current command's flags, by their one name", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--work")).toEqual(["--work-model"]);
    expect(await candidates(h, "feed", "--work")).toEqual(["--work-models"]);
    expect(await candidates(h, "search", "--pag")).toEqual(["--page", "--page-size"]);
    // Aliases parse, but are not offered: one flag, one candidate.
    expect(await candidates(h, "search", "--lim")).toEqual([]);
    expect(await candidates(h, "search", "--que")).toEqual([]);
    const all = await candidates(h, "expired", "-");
    expect(all).toEqual(["--since", "--limit", "--all", "--cursor", "--json", "--jsonl", "--csv", "--table", "--fields", "--output", "--overwrite", "--append", "--api-key", "--api-url", "--quiet", "--help", "--version"]);
  });

  it("does not offer a spent flag again, unless it repeats", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--json", "--js")).toEqual(["--jsonl"]);
    expect(await candidates(h, "search", "--skills", "Go", "--skil")).toEqual(["--skills"]);
    expect(await candidates(h, "search", "--page", "2", "--pag")).toEqual(["--page-size"]);
  });

  it("completes the values of a closed set, in any case", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--work-model", "")).toEqual(["remote", "hybrid", "onsite"]);
    expect(await candidates(h, "search", "--experience-level", "SEN")).toEqual(["senior"]);
    expect(await candidates(h, "search", "--sort", "disc")).toEqual(["discovered_asc", "discovered_desc"]);
    expect(await candidates(h, "feed", "--company-sizes", "5")).toEqual(["51-200", "501-1000", "5001-10000"]);
    expect(await candidates(h, "feed", "--company-is-agency", "")).toEqual(["true", "false"]);
    expect(await candidates(h, "search", "--include-fields", "")).toContain("none");
    // An alias is still the same flag when its value is completed.
    expect(await candidates(h, "search", "--work-models", "hy")).toEqual(["hybrid"]);
  });

  it("completes the last item of a comma-separated value and keeps the rest", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--work-model", "remote,")).toEqual(["remote,hybrid", "remote,onsite"]);
    expect(await candidates(h, "search", "--work-model", "remote,hy")).toEqual(["remote,hybrid"]);
    expect(await candidates(h, "search", "--experience-level", "Senior,lead,e")).toEqual(["Senior,lead,entry", "Senior,lead,executive"]);
    // A single-valued flag has no list to continue.
    expect(await candidates(h, "search", "--sort", "relevance,d")).toEqual([]);
  });

  it("completes --flag=value as one word", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--sort=rel")).toEqual(["--sort=relevance"]);
    expect(await candidates(h, "search", "--work-model=remote,o")).toEqual(["--work-model=remote,onsite"]);
    expect(await candidates(h, "search", "--json=")).toEqual([]);
  });

  it("offers well-known values of an open set without enforcing them", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--language", "e")).toEqual(["en", "es", "el", "et"]);
    expect(await candidates(h, "feed", "--company-categories", "b2")).toEqual(["b2b", "b2c", "b2b2c", "b2g"]);
    expect(h.requests).toHaveLength(0);
  });

  it("completes facet names for `jobo filters`, client ids for `jobo mcp` and shells for `jobo completion`", async () => {
    const h = harness();
    expect(await candidates(h, "filters", "")).toEqual([...FILTER_FACETS]);
    expect(await candidates(h, "filters", "job")).toEqual(["job_categories", "job_subcategories"]);
    expect(await candidates(h, "filters", "skills", "")).toEqual([]);
    expect(await candidates(h, "filters", "--limit", "5", "occ")).toEqual(["occupations"]);
    expect(await candidates(h, "mcp", "")).toEqual(MCP_CLIENTS.clients.map((client) => client.slug));
    expect(await candidates(h, "mcp", "claude-c")).toEqual(["claude-code"]);
    expect(await candidates(h, "completion", "")).toEqual(["bash", "zsh", "fish"]);
  });

  it("leaves file names to the shell", async () => {
    const h = harness();
    for (const words of [
      ["search", "-o", ""],
      ["search", "nurse", "--output", "res"],
      ["feed", "--max", "5", "--cursor-file", ""],
      ["skill", "install", "--dir", "~/"],
      ["job", "abc", "--output=out"],
    ]) {
      expect(await candidates(h, ...words), words.join(" ")).toEqual([FILES]);
    }
  });

  it("offers nothing where nothing is known", async () => {
    const h = harness();
    expect(await candidates(h, "search", "")).toEqual([]);
    expect(await candidates(h, "search", "--q", "")).toEqual([]);
    expect(await candidates(h, "search", "--posted-after", "2")).toEqual([]);
    expect(await candidates(h, "nosuchcommand", "")).toEqual([]);
    expect(await candidates(h, "search", "--", "--wo")).toEqual([]);
    expect(await candidates(h)).toEqual([...COMMANDS.map((command) => command.name), "help"]);
    expect(h.requests).toHaveLength(0);
  });

  it("looks past an opening quote", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--work-model", '"rem')).toEqual(["remote"]);
  });
});

describe("jobo __complete: words that bash split at = and :", () => {
  it("puts them back together and offers only the piece bash will replace", async () => {
    const h = harness();
    expect(await candidates(h, "search", "--sort", "=", "rel")).toEqual(["relevance"]);
    expect(await candidates(h, "search", "--sort", "=")).toEqual(["relevance", "discovered_asc", "discovered_desc"]);
    expect(await candidates(h, "search", "--work-model", "=", "remote,o")).toEqual(["remote,onsite"]);
    // A space after the "=" starts a new word.
    expect(await candidates(h, "completion", "--api-url", "=", "")).toEqual(["bash", "zsh", "fish"]);
  });

  it("rejoins the pieces and reports the part bash holds", () => {
    expect(rejoin(["search", "--sort", "=", "rel"])).toEqual({ words: ["search", "--sort=rel"], held: "--sort=" });
    expect(rejoin(["search", "--sort", "="])).toEqual({ words: ["search", "--sort="], held: "--sort=" });
    expect(rejoin(["feed", "--locations", "country", "=", "Germany,city", "=", "Ber"])).toEqual({
      words: ["feed", "--locations", "country=Germany,city=Ber"],
      held: "country=Germany,city=",
    });
    expect(rejoin(["search", "--sort", "=", "relevance", "--work-model", "re"])).toEqual({
      words: ["search", "--sort=relevance", "--work-model", "re"],
      held: "",
    });
    expect(rejoin(["search", "--sort=rel"])).toEqual({ words: ["search", "--sort=rel"], held: "" });
    expect(rejoin(["search", "--sort", "=", ""])).toEqual({ words: ["search", "--sort=", ""], held: "" });
  });
});

describe("jobo __complete: looked-up values", () => {
  const sources = { sources: ["greenhouse", "lever_co", "ashby", "gem"] };

  it("fetches a facet's whole list once, with one short attempt, and serves it from disk for ten minutes", async () => {
    const options: HarnessOptions = { env, responder: facets(sources), now: new Date("2026-11-20T12:00:00Z") };
    const h = harness(options);

    expect(await candidates(h, "search", "--sources", "g")).toEqual(["greenhouse", "gem"]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("GET");
    expect(path(h)).toBe("/api/connectors/filter-options/sources");
    expect(param(h, "limit")).toBe("250");
    expect(param(h, "q")).toBeNull();
    expect(h.requests[0]?.timeoutMs).toBe(4000);
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(LIVE_KEY);
    expect(readdirSync(join(h.home, ".cache", "jobo"))).toEqual(["complete-sources.json"]);

    // The feed's flags, the exclude twin and the next word of a list all read the same cache.
    options.now = new Date("2026-11-20T12:09:00Z");
    expect(await candidates(h, "feed", "--exclude-sources", "le")).toEqual(["lever_co"]);
    expect(await candidates(h, "search", "--sources", "greenhouse,")).toEqual(["greenhouse,lever_co", "greenhouse,ashby", "greenhouse,gem"]);
    expect(h.requests).toHaveLength(1);

    options.now = new Date("2026-11-20T12:10:01Z");
    expect(await candidates(h, "search", "--sources", "a")).toEqual(["ashby"]);
    expect(h.requests).toHaveLength(2);
  });

  it("keeps the cache under XDG_CACHE_HOME when that is set", async () => {
    const h = harness({ responder: facets(sources) });
    const cache = join(h.cwd, "xdg-cache");
    h.io.env = { ...env, XDG_CACHE_HOME: cache };
    await candidates(h, "search", "--sources", "");
    expect(existsSync(join(cache, "jobo", "complete-sources.json"))).toBe(true);
    expect(existsSync(join(h.home, ".cache"))).toBe(false);
  });

  it("does not reuse a list cached from another API host", async () => {
    const h = harness({ env, responder: facets(sources) });
    await candidates(h, "search", "--sources", "");
    h.io.env = { ...env, JOBO_API_URL: "https://staging.example" };
    await candidates(h, "search", "--sources", "");
    expect(h.requests.map((request) => new URL(request.url).host)).toEqual(["connect.jobo.world", "staging.example"]);
  });

  it("completes industries and job categories from their own lists, as whole names", async () => {
    const h = harness({
      env,
      responder: facets({
        industries: ["Software Development", "Film, TV & Stage Production", "Financial Services"],
        job_categories: ["healthcare", "engineering"],
        job_subcategories: ["nursing"],
      }),
    });
    expect(await candidates(h, "search", "--industries", "F")).toEqual(["Film, TV & Stage Production", "Financial Services"]);
    // A name may hold a comma, so nothing before one is treated as a finished item.
    expect(await candidates(h, "search", "--industries", "Film, T")).toEqual(["Film, TV & Stage Production"]);
    expect(await candidates(h, "search", "--exclude-industries", "soft")).toEqual(["Software Development"]);
    expect(await candidates(h, "feed", "--job-categories", "h")).toEqual(["healthcare"]);
    expect(await candidates(h, "search", "--job-subcategories", "")).toEqual(["nursing"]);
    expect(h.requests.map((_, index) => path(h, index))).toEqual([
      "/api/connectors/filter-options/industries",
      "/api/connectors/filter-options/job_categories",
      "/api/connectors/filter-options/job_subcategories",
    ]);
  });

  it("asks for a prefix when a full page of a list does not hold it", async () => {
    const head = Array.from({ length: 250 }, (_, index) => `Industry ${index}`);
    const h = harness({
      env,
      responder: (request) => {
        const q = new URL(request.url).searchParams.get("q");
        return json(200, { options: (q ? ["Zoos and Botanical Gardens"] : head).map((key) => ({ key, count: 1 })) });
      },
    });
    expect(await candidates(h, "search", "--industries", "zoo")).toEqual(["Zoos and Botanical Gardens"]);
    expect(h.requests).toHaveLength(2);
    expect(param(h, "q", 1)).toBe("zoo");
  });

  it("looks skills up by prefix on every keystroke, uncached", async () => {
    const h = harness({ env, responder: facets({ skills: ["Python", "PyTorch", "Kubernetes"] }) });
    expect(await candidates(h, "search", "--skills", "py")).toEqual(["Python", "PyTorch"]);
    expect(await candidates(h, "search", "--exclude-skills", "Go,kub")).toEqual(["Go,Kubernetes"]);
    expect(h.requests).toHaveLength(2);
    expect(path(h)).toBe("/api/connectors/filter-options/skills");
    expect(param(h, "q")).toBe("py");
    expect(param(h, "limit")).toBe("20");
    expect(param(h, "q", 1)).toBe("kub");
    expect(existsSync(join(h.home, ".cache"))).toBe(false);
  });

  it("completes a company to its domain", async () => {
    const suggestions = [
      { id: "1", ids: ["1"], name: "Stripe", domain: "stripe.com", country: "US", job_count: 400 },
      { id: "2", ids: ["2"], name: "Stripe Press", domain: null, country: "US", job_count: 0 },
      { id: "3", ids: ["3"], name: "Strava", domain: "strava.com", country: "US", job_count: 30 },
    ];
    const h = harness({ env, responder: () => json(200, { suggestions }) });
    expect(await candidates(h, "search", "--companies", "str")).toEqual(["stripe.com", "strava.com"]);
    expect(path(h)).toBe("/api/connectors/companies/suggest");
    expect(param(h, "q")).toBe("str");
    expect(await candidates(h, "feed", "--exclude-companies", "shopify.com,stra")).toEqual(["shopify.com,strava.com"]);
    expect(param(h, "q", 1)).toBe("stra");
    // The API matched "Alphabet" by name: its domain is offered though it does not start with the word.
    const byName = harness({ env, responder: () => json(200, { suggestions: [{ id: "9", ids: ["9"], name: "Alphabet", domain: "abc.xyz" }] }) });
    expect(await candidates(byName, "search", "--companies", "alph")).toEqual(["abc.xyz"]);
  });

  it("completes a place: free text for search, country=… for the feed", async () => {
    const suggestions = [
      { city: "Berlin", region: "Berlin", country: "Germany", display_name: "Berlin, Berlin, Germany", country_code: "DE" },
      { city: null, region: "Bern", country: "Switzerland", display_name: "Bern, Switzerland", country_code: "CH" },
    ];
    const h = harness({ env, responder: () => json(200, { suggestions }) });
    expect(await candidates(h, "search", "--location", "Ber")).toEqual(["Berlin, Berlin, Germany", "Bern, Switzerland"]);
    expect(path(h)).toBe("/api/connectors/locations/suggest");
    expect(param(h, "q")).toBe("Ber");
    expect(await candidates(h, "feed", "--locations", "ber")).toEqual([
      "country=Germany,region=Berlin,city=Berlin",
      "country=Switzerland,region=Bern",
    ]);
    // Typing a level by hand: the place is what follows the last "=".
    expect(await candidates(h, "feed", "--locations", "country=Ger")).toEqual(["country=Germany,region=Berlin,city=Berlin"]);
    expect(param(h, "q", 2)).toBe("Ger");
  });

  it("does not ask the suggest endpoints about fewer than two characters", async () => {
    const h = harness({ env, responder: () => json(200, { suggestions: [] }) });
    expect(await candidates(h, "search", "--companies", "s")).toEqual([]);
    expect(await candidates(h, "search", "--location", "")).toEqual([]);
    expect(await candidates(h, "feed", "--locations", "country=G")).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });

  it("uses the saved key", async () => {
    const h = harness({ responder: facets(sources) });
    saveKey(h.io, LIVE_KEY);
    expect(await candidates(h, "search", "--sources", "ash")).toEqual(["ashby"]);
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(LIVE_KEY);
  });

  it("prints nothing and sends nothing when no usable key is saved", async () => {
    const none = harness({ responder: facets(sources) });
    expect(await candidates(none, "search", "--sources", "")).toEqual([]);
    expect(await candidates(none, "search", "--companies", "stripe")).toEqual([]);
    expect(none.requests).toHaveLength(0);

    const malformed = harness({ env: { JOBO_API_KEY: "not-a-key" }, responder: facets(sources) });
    expect(await candidates(malformed, "search", "--sources", "")).toEqual([]);
    expect(malformed.requests).toHaveLength(0);

    const broken = harness({ responder: facets(sources) });
    saveKey(broken.io, LIVE_KEY);
    writeFileSync(join(broken.home, ".config", "jobo", "config.json"), "{not json");
    expect(await candidates(broken, "search", "--sources", "")).toEqual([]);
  });

  it.each([
    ["a 500", () => json(500, { title: "Server error" })],
    ["a 429", () => json(429, { title: "Too many requests" }, { "retry-after": "30" })],
    ["a sandbox refusal", () => json(404, { title: "Not available in the sandbox", status: 404, code: "not_available_in_sandbox" })],
    ["a response that is not JSON", () => ({ status: 200, headers: {}, body: "<html>" })],
    [
      "a timeout",
      () => {
        throw new Error("the request timed out after 2s");
      },
    ],
  ])("prints nothing on %s, without retrying or waiting", async (_name, responder) => {
    const h = harness({ env, responder });
    expect(await candidates(h, "search", "--sources", "g")).toEqual([]);
    expect(await candidates(h, "search", "--skills", "py")).toEqual([]);
    expect(await candidates(h, "search", "--companies", "stripe")).toEqual([]);
    expect(await candidates(h, "feed", "--locations", "berlin")).toEqual([]);
    expect(h.requests).toHaveLength(4);
    expect(h.sleeps).toEqual([]);
    // A failed list is not cached as an empty one.
    expect(existsSync(join(h.home, ".cache", "jobo", "complete-sources.json"))).toBe(false);
  });

  it("only ever calls the free lookup endpoints, with GET", async () => {
    const h = harness({ env, responder: () => json(200, { options: [{ key: "x", count: 1 }], suggestions: [] }) });
    for (const command of [...COMMANDS, ...COMMANDS.flatMap((entry) => entry.subcommands ?? [])]) {
      const parent = COMMANDS.find((entry) => entry.subcommands?.includes(command));
      const words = parent ? [parent.name, command.name] : [command.name];
      for (const name of Object.keys(command.options ?? {})) {
        await candidates(h, ...words, `--${name}`, "ab");
        await candidates(h, ...words, `--${name}`, "country=ab");
      }
      await candidates(h, ...words, "ab");
    }
    expect(h.requests.length).toBeGreaterThan(10);
    for (const request of h.requests) {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toMatch(/^\/api\/connectors\/(filter-options\/[a-z_]+|companies\/suggest|locations\/suggest)$/);
      expect(request.timeoutMs).toBe(4000);
    }
  });

  it("drops a value that would break the one-candidate-per-line protocol", async () => {
    const h = harness({ env, responder: () => json(200, { options: [{ key: "ok" }, { key: "two\nlines" }, { key: "" }, { key: "ok" }] }) });
    expect(await candidates(h, "search", "--sources", "")).toEqual(["ok"]);
  });
});

describe("jobo completion", () => {
  it.each(["bash", "zsh", "fish"] as const)("prints a %s script that calls back into jobo", async (shell) => {
    const h = harness();
    expect(await h.run("completion", shell)).toBe(0);
    expect(h.stdout()).toBe(COMPLETION_SCRIPTS[shell]);
    expect(h.stdout()).toContain(`jobo ${COMPLETE_COMMAND} -- `);
    expect(h.stdout()).toContain(FILES);
    expect(h.stderr()).toBe("");
    expect(h.requests).toHaveLength(0);
  });

  it("holds no command, flag or value of its own: the scripts cannot go stale", () => {
    for (const script of Object.values(COMPLETION_SCRIPTS)) {
      const code = script
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      for (const command of COMMANDS) expect(code).not.toMatch(new RegExp(`\\b${command.name}\\b`));
      expect(code).not.toMatch(/--[a-z]{2,}/);
    }
  });

  it("never evaluates or word-splits a candidate", () => {
    // Candidates are API data: `compgen -W` and `eval` would run a "$(…)" inside one.
    expect(COMPLETION_SCRIPTS.bash).not.toMatch(/compgen -W|\beval\b(?! "\$\(jobo completion)/);
    expect(COMPLETION_SCRIPTS.zsh).not.toMatch(/\beval\b(?! "\$\(jobo completion)/);
    expect(COMPLETION_SCRIPTS.fish).not.toMatch(/\beval\b/);
  });

  it("documents the install line of every shell in its help", async () => {
    const h = harness();
    expect(await h.run("completion", "--help")).toBe(0);
    expect(h.stdout()).toContain('eval "$(jobo completion bash)"');
    expect(h.stdout()).toContain('eval "$(jobo completion zsh)"');
    expect(h.stdout()).toContain("jobo completion fish > ~/.config/fish/completions/jobo.fish");
  });

  it("quotes the lookup timeout the code uses", async () => {
    const h = harness();
    expect(await h.run("completion", "--help")).toBe(0);
    expect(h.stdout()).toMatch(/give up after\s+4\s+seconds/);
  });

  it("refuses an unknown shell, and a missing one", async () => {
    const h = harness();
    expect(await h.run("completion", "powershell")).toBe(2);
    expect(h.stderr()).toContain("Valid values: bash, zsh, fish");
    expect(await h.run("completion")).toBe(2);
    expect(await h.run("completion", "Zsh")).toBe(0);
  });
});
