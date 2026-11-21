import { getApi } from "@/server/api";

// A thin adapter (#329, decisions 1 and 5; Humble Object): the request goes to server/api, which
// checks it, runs it and builds the whole response (#397). Node, for postgres.js's TCP connection.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
	return await getApi().postAction(request);
}
