// SHA-256 (FIPS 180-4) in pure TypeScript, synchronous, with its own UTF-8 encoding: the sim's lib
// has no TextEncoder and no crypto (ADR-0003, section 6).

// The first 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = Uint32Array.of(
	0x428a2f98,
	0x71374491,
	0xb5c0fbcf,
	0xe9b5dba5,
	0x3956c25b,
	0x59f111f1,
	0x923f82a4,
	0xab1c5ed5,
	0xd807aa98,
	0x12835b01,
	0x243185be,
	0x550c7dc3,
	0x72be5d74,
	0x80deb1fe,
	0x9bdc06a7,
	0xc19bf174,
	0xe49b69c1,
	0xefbe4786,
	0x0fc19dc6,
	0x240ca1cc,
	0x2de92c6f,
	0x4a7484aa,
	0x5cb0a9dc,
	0x76f988da,
	0x983e5152,
	0xa831c66d,
	0xb00327c8,
	0xbf597fc7,
	0xc6e00bf3,
	0xd5a79147,
	0x06ca6351,
	0x14292967,
	0x27b70a85,
	0x2e1b2138,
	0x4d2c6dfc,
	0x53380d13,
	0x650a7354,
	0x766a0abb,
	0x81c2c92e,
	0x92722c85,
	0xa2bfe8a1,
	0xa81a664b,
	0xc24b8b70,
	0xc76c51a3,
	0xd192e819,
	0xd6990624,
	0xf40e3585,
	0x106aa070,
	0x19a4c116,
	0x1e376c08,
	0x2748774c,
	0x34b0bcb5,
	0x391c0cb3,
	0x4ed8aa4a,
	0x5b9cca4f,
	0x682e6ff3,
	0x748f82ee,
	0x78a5636f,
	0x84c87814,
	0x8cc70208,
	0x90befffa,
	0xa4506ceb,
	0xbef9a3f7,
	0xc67178f2,
);

// The first 32 bits of the fractional parts of the square roots of the first 8 primes.
const H0 = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/** SHA-256 of the UTF-8 bytes of `message`, as 64 lowercase hex digits. */
export function sha256Hex(message: string): string {
	const bytes = utf8(message);
	// Padding: one 0x80 byte, zeros, then the message length in bits as a 64-bit big-endian
	// integer, to a whole number of 64-byte blocks.
	const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bits = bytes.length * 8;
	view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
	view.setUint32(padded.length - 4, bits % 0x1_0000_0000);

	const hash = Uint32Array.from(H0);
	const w = new Uint32Array(64);
	for (let block = 0; block < padded.length; block += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4);
		for (let i = 16; i < 64; i++) {
			const w15 = word(w, i - 15);
			const w2 = word(w, i - 2);
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
			w[i] = word(w, i - 16) + s0 + word(w, i - 7) + s1; // a Uint32Array stores mod 2^32
		}

		let a = word(hash, 0);
		let b = word(hash, 1);
		let c = word(hash, 2);
		let d = word(hash, 3);
		let e = word(hash, 4);
		let f = word(hash, 5);
		let g = word(hash, 6);
		let h = word(hash, 7);
		for (let i = 0; i < 64; i++) {
			const t1 =
				h +
				(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
				((e & f) ^ (~e & g)) +
				word(K, i) +
				word(w, i);
			const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		[a, b, c, d, e, f, g, h].forEach((v, i) => {
			hash[i] = word(hash, i) + v;
		});
	}
	return Array.from(hash, (v) => v.toString(16).padStart(8, "0")).join("");
}

/** Reads a word whose index is in range by construction (noUncheckedIndexedAccess can't see it). */
function word(words: Uint32Array, i: number): number {
	return words[i] ?? 0;
}

function rotr(x: number, n: number): number {
	return (x >>> n) | (x << (32 - n));
}

/** UTF-8 bytes of a well-formed UTF-16 string. A lone surrogate has no encoding, so it throws. */
function utf8(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let cp = text.charCodeAt(i);
		if (cp >= 0xd800 && cp <= 0xdfff) {
			const low = text.charCodeAt(i + 1);
			if (cp > 0xdbff || !(low >= 0xdc00 && low <= 0xdfff)) {
				throw new Error(`sha256: lone surrogate at index ${String(i)}`);
			}
			cp = 0x10000 + (cp - 0xd800) * 0x400 + (low - 0xdc00);
			i++;
		}
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		else if (cp < 0x10000) {
			out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		} else {
			out.push(
				0xf0 | (cp >> 18),
				0x80 | ((cp >> 12) & 0x3f),
				0x80 | ((cp >> 6) & 0x3f),
				0x80 | (cp & 0x3f),
			);
		}
	}
	return Uint8Array.from(out);
}
