import { createFromSource } from "fumadocs-core/search/server";
import { errorResponse } from "../../../lib/http";
import { source } from "../../../lib/source";

export const runtime = "nodejs";

const search = createFromSource(source);

export async function GET(req: Request) {
  const query = new URL(req.url).searchParams.get("query") ?? "";
  // The built-in handler reads the query with no length limit, so an oversized one is refused here first.
  if (query.length > 200) return errorResponse(400, "query_too_long");
  return search.GET(req);
}
