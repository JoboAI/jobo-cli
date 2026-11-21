import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { configPath, maskKey, resolveApiKey, resolveApiUrl, saveKey } from "../src/config";
import { LIVE_KEY, OTHER_LIVE_KEY, TEST_KEY, harness, json, searchPage } from "./helpers";

const filtersOk = () => json(200, { enums: { work_models: [], employment_types: [], experience_levels: [] }, sources: [] });
const posix = process.platform !== "win32";

describe("config location", () => {
  it("defaults to ~/.config/jobo/config.json and honours XDG_CONFIG_HOME", () => {
    expect(configPath({ env: {}, homedir: "/home/u", platform: "linux" })).toBe("/home/u/.config/jobo/config.json");
    expect(configPath({ env: {}, homedir: "/Users/u", platform: "darwin" })).toBe("/Users/u/.config/jobo/config.json");
    expect(configPath({ env: { XDG_CONFIG_HOME: "/xdg" }, homedir: "/home/u", platform: "linux" })).toBe(
      "/xdg/jobo/config.json",
    );
  });

  it("uses %APPDATA% on Windows", () => {
    const path = configPath({ env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, homedir: "C:\\Users\\u", platform: "win32" });
    expect(path).toContain("AppData");
    expect(path.endsWith("config.json")).toBe(true);
  });
});

describe("key precedence", () => {
  it("--api-key beats JOBO_API_KEY, which beats the saved key", () => {
    const h = harness();
    saveKey(h.io, LIVE_KEY);
    expect(resolveApiKey(h.io)).toEqual({ key: LIVE_KEY, source: "config" });

    const withEnv = { ...h.io, env: { JOBO_API_KEY: TEST_KEY } };
    expect(resolveApiKey(withEnv)).toEqual({ key: TEST_KEY, source: "env" });
    expect(resolveApiKey(withEnv, OTHER_LIVE_KEY)).toEqual({ key: OTHER_LIVE_KEY, source: "flag" });
    expect(resolveApiKey({ ...h.io, env: { JOBO_API_KEY: "  " } })).toEqual({ key: LIVE_KEY, source: "config" });
  });

  it("sends the key the precedence picks", async () => {
    const page = () => json(200, searchPage([], { total: 0, page: 1, page_size: 10, total_pages: 0 }));
    const h = harness({ responder: page, env: { JOBO_API_KEY: TEST_KEY } });
    saveKey(h.io, LIVE_KEY);
    await h.run("search", "x");
    await h.run("search", "x", "--api-key", OTHER_LIVE_KEY);
    expect(h.requests[0]?.headers["X-Api-Key"]).toBe(TEST_KEY);
    expect(h.requests[1]?.headers["X-Api-Key"]).toBe(OTHER_LIVE_KEY);

    const saved = harness({ responder: page });
    saveKey(saved.io, LIVE_KEY);
    await saved.run("search", "x");
    expect(saved.requests[0]?.headers["X-Api-Key"]).toBe(LIVE_KEY);
  });

  it("explains how to get a key when there is none (exit 3, nothing sent)", async () => {
    const h = harness();
    expect(await h.run("search", "x")).toBe(3);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("jobo auth");
    expect(h.stderr()).toContain("https://enterprise.jobo.world/api-keys");
  });

  it("rejects a malformed key locally (exit 3, nothing sent)", async () => {
    const h = harness({ env: { JOBO_API_KEY: "jbe_live_tooshort" } });
    expect(await h.run("search", "x")).toBe(3);
    expect(h.requests).toHaveLength(0);
    expect(h.stderr()).toContain("does not look like a Jobo API key");
  });
});

describe("jobo auth", () => {
  it("verifies with the free filters call, then saves the key with mode 0600", async () => {
    const h = harness({ responder: filtersOk });
    expect(await h.run("auth", "--api-key", LIVE_KEY)).toBe(0);

    // The free endpoint, not a search: verifying a key must never be billable.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.method).toBe("GET");
    expect(h.requests[0]?.url).toBe("https://connect.jobo.world/api/connectors/filters");

    const path = join(h.home, ".config", "jobo", "config.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ api_key: LIVE_KEY });
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    }
    expect(h.stdout()).toContain(maskKey(LIVE_KEY));
    expect(h.stdout() + h.stderr()).not.toContain(LIVE_KEY);
  });

  it.runIf(posix)("tightens a config file that already existed with loose permissions", async () => {
    const h = harness({ responder: filtersOk });
    const path = configPath(h.io);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}\n", { mode: 0o644 });
    expect(await h.run("auth", "--api-key", LIVE_KEY)).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("prompts with masked input in a terminal", async () => {
    const h = harness({ responder: filtersOk, stdinTTY: true, secret: `  ${LIVE_KEY}\n` });
    expect(await h.run("auth")).toBe(0);
    expect(h.prompts).toEqual(["Jobo API key: "]);
    expect(JSON.parse(readFileSync(configPath(h.io), "utf8")).api_key).toBe(LIVE_KEY);
  });

  it("reads the key from stdin when piped", async () => {
    // A sandbox key is refused on the filters endpoint, but only after it authenticated.
    const sandbox = harness({
      responder: () => json(404, { title: "Not available in the sandbox", status: 404, code: "not_available_in_sandbox" }),
      stdinTTY: false,
      stdinText: `${TEST_KEY}\n`,
    });
    expect(await sandbox.run("auth")).toBe(0);
    expect(sandbox.prompts).toEqual([]);
    expect(JSON.parse(readFileSync(configPath(sandbox.io), "utf8")).api_key).toBe(TEST_KEY);
    expect(sandbox.stdout()).toContain("sandbox key");
  });

  it("saves nothing when the API rejects the key (exit 3)", async () => {
    const h = harness({ responder: () => json(401, { error: "Invalid or expired API key" }) });
    expect(await h.run("auth", "--api-key", LIVE_KEY)).toBe(3);
    expect(existsSync(configPath(h.io))).toBe(false);
    expect(h.stderr()).toContain("nothing was saved");
    expect(h.requests).toHaveLength(1);
  });

  it("saves nothing when the key is malformed, and sends nothing", async () => {
    const h = harness();
    expect(await h.run("auth", "--api-key", "sk-not-a-jobo-key")).toBe(3);
    expect(h.requests).toHaveLength(0);
    expect(existsSync(configPath(h.io))).toBe(false);
  });

  it("--no-verify saves without a request", async () => {
    const h = harness();
    expect(await h.run("auth", "--api-key", LIVE_KEY, "--no-verify")).toBe(0);
    expect(h.requests).toHaveLength(0);
    expect(JSON.parse(readFileSync(configPath(h.io), "utf8")).api_key).toBe(LIVE_KEY);
  });

  it("--show prints the location and a masked key, never the key", async () => {
    const h = harness({ env: { JOBO_API_KEY: OTHER_LIVE_KEY } });
    saveKey(h.io, LIVE_KEY);
    expect(await h.run("auth", "--show")).toBe(0);
    const text = h.stdout();
    expect(text).toContain(configPath(h.io));
    expect(text).toContain("jbe_live_…wxyz");
    expect(text).toContain("JOBO_API_KEY");
    expect(text).toContain(`Saved key: ${maskKey(LIVE_KEY)}`);
    expect(text).not.toContain(LIVE_KEY);
    expect(text).not.toContain(OTHER_LIVE_KEY);
    expect(h.requests).toHaveLength(0);
  });

  it("--show exits 3 when no key is configured", async () => {
    const h = harness();
    expect(await h.run("auth", "--show")).toBe(3);
    expect(h.stdout()).toContain("No API key in use");
  });

  it("logout removes the saved key and mentions a key still in the environment", async () => {
    const h = harness({ env: { JOBO_API_KEY: TEST_KEY } });
    saveKey(h.io, LIVE_KEY);
    expect(await h.run("logout")).toBe(0);
    expect(existsSync(configPath(h.io))).toBe(false);
    expect(h.stdout()).toContain("JOBO_API_KEY is still set");
    expect(await h.run("logout")).toBe(0);
    expect(h.stdout()).toContain("No saved key");
  });
});

describe("masking and API URL", () => {
  it("shows the prefix and last four characters only", () => {
    expect(maskKey(LIVE_KEY)).toBe("jbe_live_…bbbb");
    expect(maskKey(TEST_KEY)).toBe("jbe_test_…dddd");
  });

  it("defaults to the one API host and refuses plain http elsewhere", () => {
    expect(resolveApiUrl({ env: {} })).toBe("https://connect.jobo.world");
    expect(resolveApiUrl({ env: { JOBO_API_URL: "http://127.0.0.1:9999/" } })).toBe("http://127.0.0.1:9999");
    expect(resolveApiUrl({ env: { JOBO_API_URL: "http://127.0.0.1:1" } }, "https://proxy.example")).toBe("https://proxy.example");
    expect(() => resolveApiUrl({ env: {} }, "http://connect.jobo.world")).toThrow(/https/);
  });
});
