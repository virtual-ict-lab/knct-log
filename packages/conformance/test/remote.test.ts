import { conformance } from "../src/suite.ts";

const baseUrl = process.env.TARGET_URL;
if (!baseUrl) throw new Error("TARGET_URL is required (e.g. http://localhost:8787)");
conformance(baseUrl, () => ({ baseUrl }));
