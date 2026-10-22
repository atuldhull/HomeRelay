// Writes sample household documents for the demo into .data/demo-files (git-ignored). Uploading them is up to you.
import fs from "node:fs";
import path from "node:path";
import { makePdf, PNG_1PX } from "../tests/fixtures/pdf";
import { fromRoot } from "./env";

const dir = fromRoot(".data/demo-files");
fs.mkdirSync(dir, { recursive: true });
const files: [string, Buffer][] = [
  ["Washer warranty.pdf", makePdf(["Washer warranty card. Model WM-4471, serial 88213. Valid until March 2028.", "Service centre: call 1800-555-0101 and quote the serial number."])],
  ["Courier receipt.txt", Buffer.from("Courier receipt\nParcel 7731 delivered to the building reception.\nCollected by: pending\n")],
  ["Dishwasher user guide.md", Buffer.from("# Dishwasher user guide\n\nError E15: water in the base tray. Switch off, tilt gently, call service if it repeats.\n")],
  ["Package photo.png", PNG_1PX],
];
for (const [name, bytes] of files) fs.writeFileSync(path.join(dir, name), bytes);
console.log(`Wrote ${files.length} sample files to ${dir}`);
