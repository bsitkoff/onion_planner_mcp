/**
 * Dev CLI — drive the MCP's tools from the command line, in a fresh process, so
 * code edits take effect immediately (the registered stdio server caches the old
 * code until it's reconnected). Calls the SAME underlying functions the server
 * wraps, so it exercises the real logic — only the MCP transport veneer is skipped.
 *
 * Container resolution honours ONIONSKIN_CONTAINER (default: the live iCloud path),
 * so point it at fixtures or the live container as needed:
 *
 *   npm run call -- read_page Shared/Daily/2026-02-06
 *   npm run call -- write_underlay Shared/Daily/_mcp-test '{"regions":[...]}'
 *   npm run call -- write_underlay Shared/Daily/_mcp-test '{"status":"refreshing"}' --svg '<svg.../>'
 *   ONIONSKIN_CONTAINER=/tmp/onionskin-test npm run call -- list_pages
 *
 * A Bash-spawned process inherits the host's Full Disk Access, so live reads/writes
 * work here without reconnecting the registered server.
 */
import { requireLibrary, listChapters, listPageRows, type PageFilter } from "../src/library.js";
import {
  readPage,
  writeUnderlay,
  setStatus,
  clearUnderlay,
  createPage,
  type AiStatus,
} from "../src/page.js";

const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

function parseJson(arg: string | undefined, what: string): any {
  if (arg === undefined) throw new Error(`Missing ${what} (expected a JSON argument).`);
  try {
    return JSON.parse(arg);
  } catch (e: any) {
    throw new Error(`Bad ${what} JSON: ${e.message}`);
  }
}

async function main() {
  const [tool, ...args] = process.argv.slice(2);
  if (!tool) {
    throw new Error(
      "Usage: npm run call -- <tool> [args]\n" +
        "Tools: get_library | list_pages [chapter] [key=value filters] | read_page <page> [--template] |\n" +
        "  write_underlay <page> <json> | set_underlay_status <page> <status> |\n" +
        "  clear_underlay <page> | create_page <json>",
    );
  }

  const root = await requireLibrary();

  switch (tool) {
    case "get_library":
      return out({ root, exists: true, sharedChapters: await listChapters(root) });

    case "list_pages": {
      // Filters are key=value args (chapter, template, aiStatus, titleContains,
      // modifiedAfter, modifiedBefore). A bare positional arg is still the chapter.
      const filter: PageFilter = {};
      for (const a of args) {
        const eq = a.indexOf("=");
        if (eq === -1) {
          filter.chapter = a;
          continue;
        }
        const key = a.slice(0, eq) as keyof PageFilter;
        (filter as any)[key] = a.slice(eq + 1);
      }
      const rows = await listPageRows(root, filter);
      return out({ count: rows.length, pages: rows });
    }

    case "read_page": {
      if (!args[0]) throw new Error("read_page needs a page path.");
      return out(await readPage(root, args[0], args.includes("--template")));
    }

    case "write_underlay": {
      if (!args[0]) throw new Error("write_underlay needs a page path.");
      // arg[1] is a JSON object: { regions?, svg?, status?, merge?, dryRun? }
      const body = parseJson(args[1], "write body");
      const status: AiStatus = body.status ?? "ready";
      if ((body.regions && body.svg) || (!body.regions && !body.svg)) {
        throw new Error("Provide exactly one of `regions` or `svg` in the JSON body.");
      }
      if (body.merge && body.svg) {
        throw new Error("`merge` is only supported with structured `regions`, not raw `svg`.");
      }
      return out({
        ok: true,
        ...(await writeUnderlay(root, args[0], {
          regions: body.regions,
          svg: body.svg,
          status,
          merge: body.merge,
          dryRun: body.dryRun,
        })),
      });
    }

    case "set_underlay_status": {
      if (!args[0] || !args[1]) throw new Error("set_underlay_status needs <page> <status>.");
      await setStatus(root, args[0], args[1] as AiStatus);
      return out({ ok: true, page: args[0], status: args[1] });
    }

    case "clear_underlay": {
      if (!args[0]) throw new Error("clear_underlay needs a page path.");
      await clearUnderlay(root, args[0]);
      return out({ ok: true, page: args[0], status: "empty" });
    }

    case "create_page": {
      const body = parseJson(args[0], "create options");
      return out({ ok: true, ...(await createPage(root, body)) });
    }

    default:
      throw new Error(`Unknown tool "${tool}".`);
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
