import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sliceContent, type Content } from "@sunny-pastures/sim";

import { spriteManifest, spriteUrl } from "../index";

const placeholderDir = new URL("../../../../public/sprites/placeholder/", import.meta.url);

/** Every id the slice's content names: crops, goods (recipe outputs, feed, pen products), pens, facilities. */
function listContentIds(content: Content = sliceContent): string[] {
	const ids = new Set<string>(Object.keys(content.crops));
	for (const facility of content.facilities) {
		ids.add(facility.id);
		for (const recipe of Object.values(facility.recipes)) ids.add(recipe.output.good);
	}
	for (const pen of content.pens) {
		ids.add(pen.id);
		ids.add(pen.feed);
		ids.add(pen.product);
	}
	return [...ids];
}

describe("the sprite manifest", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("has an entry for every crop, good, pen and facility the content lists", () => {
		const ids = listContentIds();
		expect(ids).toEqual(expect.arrayContaining(["wheat", "egg", "bread", "chickenPen", "bakery"]));
		for (const id of ids) expect(spriteManifest, id).toHaveProperty(id);
	});

	it("names a placeholder file that exists, with a title, for every entry", () => {
		for (const file of Object.values(spriteManifest)) {
			const url = new URL(file, placeholderDir);
			expect(existsSync(url), file).toBe(true);
			expect(readFileSync(url, "utf8"), file).toMatch(/<title>[^<]+<\/title>/);
		}
	});

	it("gives each entry its own file", () => {
		const files = Object.values(spriteManifest);
		expect(new Set(files).size).toBe(files.length);
	});

	it("serves the placeholder when the art base URL is unset or empty", () => {
		vi.stubEnv("NEXT_PUBLIC_ART_BASE_URL", undefined);
		expect(spriteUrl("wheat")).toBe("/sprites/placeholder/wheat.svg");
		vi.stubEnv("NEXT_PUBLIC_ART_BASE_URL", "");
		expect(spriteUrl("wheat")).toBe("/sprites/placeholder/wheat.svg");
	});

	it("serves from the art base URL when it is set, with or without a trailing slash", () => {
		vi.stubEnv("NEXT_PUBLIC_ART_BASE_URL", "https://art.example.test/sprites");
		expect(spriteUrl("chickenPen")).toBe("https://art.example.test/sprites/chicken-pen.svg");
		vi.stubEnv("NEXT_PUBLIC_ART_BASE_URL", "https://art.example.test/sprites/");
		expect(spriteUrl("chickenPen")).toBe("https://art.example.test/sprites/chicken-pen.svg");
	});
});
