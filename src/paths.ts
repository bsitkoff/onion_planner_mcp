import fs from "node:fs";
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

/** The `Shared/` book folder. */
export function sharedDir(root: string): string {
  return path.join(root, "Shared");
}

/**
 * Marker the Onionskin app writes at the library root once it has stamped every chapter's
 * `permissions.inkReadable` with an explicit value (app issue #144 Phase B,
 * `InkPermissionMigration.swift`). Its presence is what retires the `Shared/` location gate
 * here — so this server and the app flip together however their releases are ordered: a
 * library the new app hasn't migrated yet keeps the old rules.
 */
export const INK_PERMISSIONS_MARKER = ".ink-permissions-v1.json";

/** True once the app has migrated this library to the per-chapter ink-read model. */
export function locationGateRetired(root: string): boolean {
  return fs.existsSync(path.join(root, INK_PERMISSIONS_MARKER));
}

/**
 * The top-level book folders this server may reach: every chapter folder (`Shared/` and
 * `Private/`) once the location gate is retired, else `Shared/` only.
 */
export function bookFolders(root: string): string[] {
  return locationGateRetired(root) ? ["Shared", "Private"] : ["Shared"];
}

/**
 * Resolve a caller-supplied chapter reference to its library-relative folder, e.g.
 * `"Shared/2026-06"` or `"Private/Notes"`.
 *
 * `get_library` advertises each chapter as `{ name, path }`, and callers naturally feed either
 * form back. A value starting with a reachable book folder (`Shared/…`, or `Private/…` once the
 * gate is retired) is used as given; a bare name resolves to the first book folder that holds
 * it, falling back to `Shared/` (where new chapters go). Returns `""` for a blank value.
 */
export function chapterRel(root: string, chapter: string): string {
  const cleaned = chapter.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!cleaned) return "";
  const folders = bookFolders(root);
  for (const f of folders) {
    if (cleaned === f) return "";
    if (cleaned.startsWith(f + "/")) return cleaned;
  }
  for (const f of folders) {
    if (fs.existsSync(path.join(root, f, cleaned))) return `${f}/${cleaned}`;
  }
  return `Shared/${cleaned}`;
}

/**
 * `chapterRel` for the *write* paths, which need a real chapter. A blank value would resolve
 * to a book folder itself — `resolvePageRel` permits that and it *is* a directory, so a write
 * would land outside any chapter (a `.folder.json` in `Shared/`, or a page directly under it).
 * Zod's `.min(1)` alone doesn't close this (`"  "` clears it, and the dev CLI bypasses zod), so
 * the guard lives here, on the path both writers take.
 */
export function requireChapterRel(root: string, chapter: string): string {
  const rel = chapterRel(root, chapter);
  if (!rel) {
    throw new Error(
      "`chapter` must name a chapter (got an empty value or a bare book folder). " +
        'Pass a chapter name like "2026-07" or "Daily" — Shared/ itself is not a chapter.',
    );
  }
  return rel;
}

/**
 * Validate a caller-supplied page-relative path and return its absolute path.
 *
 * The relative path is the page "id" handed back by list_pages, e.g.
 * "Shared/Daily/2026-02-06". This is the single path-safety chokepoint: the path must start
 * with a reachable book folder (`bookFolders`), and nothing may escape it. Root content
 * (`Templates/`, `Stickers/`, `Diagnostics/`, `settings.json`) is never reachable. What the AI
 * may *read* inside a chapter is a separate, per-chapter question (`permissions.inkReadable`,
 * checked by `read_ink`).
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
  const folders = bookFolders(root);
  if (!folders.includes(segments[0])) {
    throw new Error(
      folders.length === 1
        ? `Refusing "${rel}": only pages under "Shared/" may be touched. ` +
            `Private and root content are off-limits.`
        : `Refusing "${rel}": only pages under ${folders.map((f) => `"${f}/"`).join(" or ")} ` +
            `may be touched. Root content is off-limits.`,
    );
  }

  const abs = path.join(root, cleaned);
  const base = path.join(root, segments[0]);
  // Final containment check (defends against any normalization surprise).
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`Refusing "${rel}": resolves outside the ${segments[0]} folder.`);
  }
  return abs;
}
