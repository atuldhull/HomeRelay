// Reports the newest soak run honestly. A run whose process was killed (reboot, sleep, closed terminal) cannot write
// its own result, so summary.json would say "running" forever; this judges it by its heartbeat instead.
import fs from "node:fs";
import path from "node:path";
import { fromRoot } from "./env";

const latest = fromRoot(path.join(".data", "soak", "LATEST"));
if (!fs.existsSync(latest)) { console.log("No soak run found."); process.exit(0); }
const id = fs.readFileSync(latest, "utf8").trim();
const dir = fromRoot(path.join(".data", "soak", id));
const s = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
const lines = fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8").trim().split("\n").filter(Boolean);
const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
const beat = new Date(last?.at ?? s.updated_at).getTime();
const gaps = lines.slice(1).map((l, i) => new Date(JSON.parse(l).at).getTime() - new Date(JSON.parse(lines[i]).at).getTime());
const interval = gaps.length ? Math.min(...gaps) : 300_000;
const silentFor = Date.now() - beat;
let status: string = s.status;
if (s.status === "running" && silentFor > 3 * interval) status = "interrupted (process ended without writing a result)";

console.log(`run ${id}`);
console.log(`status:    ${status}`);
console.log(`declared:  ${s.declared_duration_hours} h · elapsed at last heartbeat: ${last ? (last.elapsed_min / 60).toFixed(2) : s.elapsed_hours} h`);
console.log(`last beat: ${new Date(beat).toISOString()} (${Math.round(silentFor / 60000)} min ago)`);
console.log(`totals:    ${s.totals.requests} requests · ${s.totals.errors} errors · ${s.totals.verification_failures} verification failures · ${s.totals.cycles_completed}/${s.totals.cycles} cycles`);
console.log(`unexpected exits: ${s.unexpected_exits.length} · passed: ${s.passed}`);
