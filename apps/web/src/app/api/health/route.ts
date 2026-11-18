import { getApi } from "@/server/api";

// A thin adapter (#329, decisions 1 and 5; Humble Object): call server/api, map to a Response.
// Game routes need Node for postgres.js's TCP connection; health runs where they run.
export const runtime = "nodejs";

export function GET(): Response {
	return Response.json(getApi().health());
}
