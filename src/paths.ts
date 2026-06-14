import os from "node:os";
import path from "node:path";

/**
 * Resolve the Onionskin library root (the iCloud `Documents/` directory).
 *
 * Precedence:
 *   1. ONIONSKIN_CONTAINER env var (absolute path to the `Documents/` dir) —
 *      used for a re-pointed iCloud container id, or to test against fixtures.
 *   2. The default iCloud container location on this Mac.
 *
 * Returns an absolute path. Does NOT guarantee the path exists — callers check.
 */
export function resolveRoot(): string {
  const override = process.env.ONIONSKIN_CONTAINER?.trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(
    os.homedir(),
    "Library",
    "Mobile Documents",
    "iCloud~com~onionskin~app",
    "Documents",
  );
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The shared sandbox directory — the only place this server may write. */
export function sharedDir(root: string): string {
  return path.join(root, "Shared");
}

/**
 * Validate a caller-supplied page-relative path and return its absolute path.
 *
 * The relative path is the page "id" handed back by list_pages, e.g.
 * "Shared/Daily/2026-02-06". This is the single chokepoint that enforces the
 * permission model: everything must live under `Shared/`, nothing may escape it,
 * and `Private/` is unreachable by construction.
 *
 * Throws a descriptive Error on any violation.
 */
export function resolvePageRel(root: string, rel: string): string {
  const cleaned = rel.replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (!cleaned) throw new Error("Empty page path.");

  // No traversal, no absolute escapes, no Windows-y separators.
  const segments = cleaned.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`Illegal path "${rel}" (contains traversal segments).`);
  }
  if (segments[0] !== "Shared") {
    throw new Error(
      `Refusing "${rel}": only pages under "Shared/" may be touched. ` +
        `Private and root content are off-limits.`,
    );
  }

  const abs = path.join(root, cleaned);
  const base = sharedDir(root);
  // Final containment check (defends against any normalization surprise).
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`Refusing "${rel}": resolves outside the Shared sandbox.`);
  }
  return abs;
}
