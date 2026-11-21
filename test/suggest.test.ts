import { describe, expect, it } from "vitest";

import { canonical, didYouMean, editDistance, nearest } from "../src/suggest";

const LEVELS = ["intern", "entry", "mid", "senior", "lead", "executive"];
const FACETS = ["sources", "skills", "industries", "company_categories", "job_categories", "job_subcategories", "occupations"];

describe("editDistance", () => {
  it("counts inserts, deletes, substitutions and swaps of neighbours as one edit each", () => {
    expect(editDistance("search", "search")).toBe(0);
    expect(editDistance("serach", "search")).toBe(1);
    expect(editDistance("serch", "search")).toBe(1);
    expect(editDistance("searchh", "search")).toBe(1);
    expect(editDistance("sezrch", "search")).toBe(1);
    expect(editDistance("", "feed")).toBe(4);
  });
});

describe("canonical", () => {
  it("forgives case", () => {
    expect(canonical("Remote", ["remote", "hybrid", "onsite"])).toBe("remote");
    expect(canonical("DISCOVERED_ASC", ["relevance", "discovered_asc"])).toBe("discovered_asc");
  });

  it("forgives swapped or missing separators", () => {
    expect(canonical("job-categories", FACETS)).toBe("job_categories");
    expect(canonical("Full Time", ["full-time", "part-time"])).toBe("full-time");
    expect(canonical("on-site", ["remote", "hybrid", "onsite"])).toBe("onsite");
  });

  it("does not guess: a typo is not another spelling", () => {
    expect(canonical("remot", ["remote", "hybrid", "onsite"])).toBeUndefined();
    expect(canonical("", LEVELS)).toBeUndefined();
  });

  it("stays out of it when two candidates differ only by a separator", () => {
    expect(canonical("ab", ["a-b", "a_b"])).toBeUndefined();
    expect(canonical("a-b", ["a-b", "a_b"])).toBe("a-b");
  });
});

describe("nearest", () => {
  it("finds a typo's neighbour", () => {
    expect(nearest("serach", ["search", "feed", "filters"])).toBe("search");
    expect(nearest("work-modle", ["work-model", "work-models", "sort"])).toBe("work-model");
    expect(nearest("job-categoris", FACETS)).toBe("job_categories");
  });

  it("finds a value that was written out too long, or cut short", () => {
    expect(nearest("senior level", LEVELS)).toBe("senior");
    expect(nearest("exec", LEVELS)).toBe("executive");
  });

  it("says nothing when nothing is close", () => {
    expect(nearest("newest", ["relevance", "discovered_asc", "discovered_desc"])).toBeUndefined();
    expect(nearest("salaries", FACETS)).toBeUndefined();
    expect(nearest("x", ["search", "feed"])).toBeUndefined();
  });

  it("phrases the guess, or stays silent", () => {
    expect(didYouMean("serach", ["search"])).toBe(' Did you mean "search"?');
    expect(didYouMean("pagesize", ["page-size"], (guess) => `--${guess}`)).toBe(" Did you mean --page-size?");
    expect(didYouMean("zzz", ["search"])).toBe("");
  });
});
