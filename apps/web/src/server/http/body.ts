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
	try {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			size += chunk.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				return { ok: false, reason: "too_large" };
			}

			text += decoder.decode(chunk.value, { stream: true });
		}
		return { ok: true, text: text + decoder.decode() };
	} catch (error) {
		// `fatal` makes the decoder throw a TypeError on bytes that aren't UTF-8; anything else is
		// a fault in the stream, not in the request.
		if (error instanceof TypeError) return { ok: false, reason: "not_utf8" };
		throw error;
	}
}
