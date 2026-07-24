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
 * Normalize a caller-supplied chapter reference to the bare chapter name.
 *
 * `get_library` advertises each chapter as `{ name: "2026-06", path: "Shared/2026-06" }`,
 * and callers naturally feed either form back into the `chapter` argument. The internals
 * prepend `Shared/` themselves, so a `Shared/2026-06` value would double the prefix
 * (`Shared/Shared/2026-06`) and silently match nothing. Strip a leading `Shared/` (and
 * surrounding slashes) so both the `name` and the `path` work.
 */
export function normalizeChapter(chapter: string): string {
  return chapter
    .trim()
    .replace(/^\/+/, "")
    .replace(/^Shared\//, "")
    .replace(/\/+$/, "");
}

/**
 * `normalizeChapter` for the *write* paths, which need a chapter that actually exists.
 *
 * A blank or whitespace-only value normalizes to `""`, and `Shared/` + `""` resolves to
 * the Shared/ root itself — `resolvePageRel` permits `abs === base`, and Shared/ *is* a
 * directory, so the existence check passes and the write lands outside the documented
 * scope (a `.folder.json` in Shared/, or a page folder created directly under it rather
 * than inside a chapter). Zod's `.min(1)` alone doesn't close this — `"  "` clears it, and
 * the dev CLI and any direct `page.ts` caller bypass zod entirely — so the guard belongs
 * here, on the shared path both writers take.
 */
export function requireChapterName(chapter: string): string {
  const name = normalizeChapter(chapter);
  if (!name) {
    throw new Error(
      "`chapter` must name a chapter under Shared/ (got an empty value). " +
        'Pass a chapter name like "2026-07" or "Daily" — Shared/ itself is not a chapter.',
    );
  }
  return name;
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
