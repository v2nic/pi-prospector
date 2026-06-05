import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ProspectorConfig } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.json");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

export function loadConfig(): ProspectorConfig {
	try { const raw = fs.readFileSync(CONFIG_PATH, "utf-8"); return JSON.parse(raw) as ProspectorConfig; } catch { return {}; }
}

export function getDbPath(config?: ProspectorConfig): string {
	const c = config ?? loadConfig();
	if (c.dbPath) return c.dbPath.replace(/^~/, os.homedir());
	return DEFAULT_DB_PATH;
}

export function getSessionsDir(): string { return SESSIONS_DIR; }