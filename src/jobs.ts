import type { Job, JobLocation } from "@jobo-ai/connector-core";

import { toKeyValue, type Column } from "./output";

function place(location: JobLocation): string {
  return location.location ?? [location.city, location.region, location.country].filter(Boolean).join(", ");
}

function locations(row: unknown): string {
  const list = (row as Partial<Job>).locations;
  return Array.isArray(list) ? list.map(place).filter(Boolean).join(" | ") : "";
}

function day(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function salary(row: unknown): string {
  const pay = (row as Partial<Job>).compensation;
  if (!pay || (pay.min == null && pay.max == null)) return "";
  const range = pay.min != null && pay.max != null && pay.min !== pay.max ? `${pay.min}–${pay.max}` : `${pay.min ?? pay.max}`;
  return [range, pay.currency, pay.period].filter(Boolean).join(" ");
}

/** Terminal view: enough to choose a listing, with the id `jobo job` takes. */
export const JOB_TABLE_COLUMNS: readonly Column[] = [
  { key: "id" },
  { key: "title", max: 44 },
  { key: "company.name", header: "company", max: 26 },
  { key: "locations", header: "location", get: locations, max: 30 },
  { key: "workplace_type", header: "work model" },
  { key: "date_posted", header: "posted", get: (row) => day((row as Partial<Job>).date_posted) },
];

/** CSV view: one flat row per job. */
export const JOB_CSV_COLUMNS: readonly Column[] = [
  { key: "id" },
  { key: "title" },
  { key: "company.name" },
  { key: "company.id" },
  { key: "locations", get: locations },
  { key: "workplace_type" },
  { key: "employment_type" },
  { key: "experience_level" },
  { key: "compensation.min" },
  { key: "compensation.max" },
  { key: "compensation.currency" },
  { key: "compensation.period" },
  { key: "date_posted" },
  { key: "source" },
  { key: "listing_url" },
  { key: "apply_url" },
];

/** One job as a terminal page: the facts, then the summary and the description. */
export function jobView(document: unknown): string {
  const job = document as Partial<Job>;
  const head = toKeyValue([
    ["Title", job.title],
    ["Company", job.company?.name],
    ["Location", locations(job)],
    ["Work model", job.workplace_type],
    ["Employment", job.employment_type],
    ["Experience", job.experience_level],
    ["Compensation", salary(job)],
    ["Posted", day(job.date_posted)],
    ["Source", job.source],
    ["Listing", job.listing_url],
    ["Apply", job.apply_url],
    ["Job id", job.id],
    ["Company id", job.company?.id],
  ]);
  const sections = [head];
  if (job.summary) sections.push(`\n${job.summary.trim()}\n`);
  if (job.description) sections.push(`\n${job.description.trim()}\n`);
  return sections.join("");
}
