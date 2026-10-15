import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformance } from "@knct-log/conformance";
import { inProcessServer } from "./helpers.ts";

const server = inProcessServer("campus");
conformance("campus (in-process)", () => server);
