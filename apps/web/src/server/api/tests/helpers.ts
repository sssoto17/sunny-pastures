import { expect, vi } from "vitest";

/**
 * The contract's 500 (#470): the fixed body and the headers every response carries, errors
 * included, and none of `hidden`, the detail that the server's log has and a response never does.
 */
export async function expectContract500(response: Response, hidden: string): Promise<void> {
	const body = await response.text();
	expect(JSON.parse(body)).toEqual({
		error: "internal",
		message: "Something went wrong on the server. Try again.",
	});
	expect(body).not.toContain(hidden);
	expect(response.headers.get("Rules-Version")).toBe("1");
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Server-Timing")).toMatch(/^total;dur=[\d.]+$/);
}

/** The requests the API tests send, as the routes' clients would. */
export function buildGetRequest(): Request {
	return new Request("http://app.test/api/farm");
}

export function buildPlantRequest(): Request {
	const headers = new Headers();
	headers.set("Content-Type", "application/json");
	headers.set("Idempotency-Key", crypto.randomUUID());
	return new Request("http://app.test/api/farm/actions", {
		method: "POST",
		headers,
		body: JSON.stringify({ action: { type: "plant", plot: 0, crop: "wheat" }, expectedSeq: 0 }),
	});
}

/** Collects what the API sends to the server's log, so a test can see what a response hid. */
export function spyOnLog(): unknown[][] {
	const logged: unknown[][] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		logged.push(args);
	});
	return logged;
}
