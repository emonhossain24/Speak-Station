import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
let report;
try {
  report = JSON.parse(result.stdout || output);
} catch {
  const rows = output.split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  report = rows.length === 1 ? rows[0] : rows;
}
function collect(value, found = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return found;
  seen.add(value);
  if (!Array.isArray(value) && typeof value.severity === "string" &&
      (value.name || value.module_name || value.packageName)) found.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) collect(child, found, seen);
  return found;
}
const advisories = collect(report);
if (result.error || advisories.length === 0) {
  process.stderr.write(output || String(result.error || "No parseable audit advisories"));
  process.exit(1);
}
const blocking = advisories.filter((item) => {
  if (!["high", "critical"].includes(String(item.severity).toLowerCase())) return false;
  const name = item.name || item.module_name || item.packageName;
  const detail = JSON.stringify(item);
  // Narrow temporary exception: GitHub currently publishes no fixed version
  // for this exact picomatch advisory. All other high/critical findings block CI.
  return !(name === "picomatch" && detail.includes("GHSA-fc5q-39xc-vjpf"));
});
if (blocking.length || result.status !== 0 && !advisories.length) {
  process.stderr.write(JSON.stringify(blocking.length ? blocking : advisories, null, 2));
  process.exit(1);
}
const allowed = advisories.filter((item) =>
  (item.name || item.module_name || item.packageName) === "picomatch" &&
  JSON.stringify(item).includes("GHSA-fc5q-39xc-vjpf")
);
console.log(`Audit passed; ${allowed.length} exact unpatched picomatch advisory exception(s). Other high/critical findings remain blocking.`);
