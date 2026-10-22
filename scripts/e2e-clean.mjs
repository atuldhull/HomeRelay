// Clears ONLY the isolated end-to-end database and its document folder before Playwright starts the stack.
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const data = resolve(import.meta.dirname, "..", ".data");
for (const name of ["e2e.db", "e2e.db-wal", "e2e.db-shm", "e2e-documents"]) rmSync(resolve(data, name), { recursive: true, force: true });
