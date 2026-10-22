// Asks the newest soak run to stop at the end of its current cycle. It records the run as "interrupted".
import fs from "node:fs";
import path from "node:path";
import { fromRoot } from "./env";

const latest = fromRoot(path.join(".data", "soak", "LATEST"));
if (!fs.existsSync(latest)) { console.log("No soak run found."); process.exit(0); }
const id = fs.readFileSync(latest, "utf8").trim();
fs.writeFileSync(fromRoot(path.join(".data", "soak", id, "STOP")), new Date().toISOString());
console.log(`Stop requested for soak run ${id}. It finishes its current cycle, then writes summary.json.`);
