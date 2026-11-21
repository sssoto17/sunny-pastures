/** A body read as text, or why it couldn't be. */
export type BodyText =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: "too_large" | "not_utf8" };

/**
 * Reads a body as UTF-8 text, stopping as soon as it passes `limit` bytes (#330, "Request"), so a
 * chunked body with no `Content-Length`, or one that lies about it, is never held in full. An
 * absent body reads as empty text.
 */
export async function readBodyText(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<BodyText> {
	if (body === null) return { ok: true, text: "" };

	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let size = 0;
	let text = "";
	for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
		size += chunk.value.byteLength;
		const decoded = size > limit ? null : decode(decoder, chunk.value);
		if (decoded === null) {
			await reader.cancel();
			return { ok: false, reason: size > limit ? "too_large" : "not_utf8" };
		}

		text += decoded;
	}
	const rest = decode(decoder, null);
	return rest === null ? { ok: false, reason: "not_utf8" } : { ok: true, text: text + rest };
}

// The next piece of text, or null for bytes that aren't UTF-8 (`fatal` makes the decoder throw a
// TypeError). Its own try, so a fault in the stream itself is rethrown, never read as a bad body.
// `null` bytes flush the decoder: a body that ends inside a character isn't UTF-8 either.
function decode(decoder: TextDecoder, bytes: Uint8Array | null): string | null {
	try {
		return bytes === null ? decoder.decode() : decoder.decode(bytes, { stream: true });
	} catch {
		return null;
	}
}
