import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout, { metadata } from "../layout";
import Home from "../page";

describe("the root layout", () => {
	it("renders its children inside an English document", () => {
		const html = renderToStaticMarkup(
			<RootLayout>
				<p>farm</p>
			</RootLayout>,
		);

		expect(html).toMatch(/^<html lang="en">/);
		expect(html).toContain("<body><p>farm</p></body>");
	});

	it("names the game in the page title", () => {
		expect(metadata.title).toBe("Sunny Pastures");
	});
});

describe("the home page", () => {
	it("shows the game's name as its heading", () => {
		expect(renderToStaticMarkup(<Home />)).toContain("<h1>Sunny Pastures</h1>");
	});

	it("mounts the game, which shows its loading state first", () => {
		expect(renderToStaticMarkup(<Home />)).toContain('<p role="status">Loading your farm…</p>');
	});
});
