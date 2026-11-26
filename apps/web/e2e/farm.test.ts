import { expect, test } from "@playwright/test";

// The smoke spec (#673; ADR-0011, section 5): it runs in all six projects, so every engine at both
// widths loads the farm and takes a tap. Each test has a fresh browser context with no stored
// session, so the page signs in a new anonymous player and creates its farm (MUST-09.1). Elements
// are found by role and accessible name, as a player using a screen reader would find them.

test.describe("the farm page", () => {
	test("loads the farm for a new anonymous player", async ({ page }) => {
		await page.goto("/");

		await expect(page.getByRole("group", { name: "Farm map" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Plot 1: empty" })).toBeVisible();
	});

	test("answers a tap on a plot", async ({ page, hasTouch }) => {
		await page.goto("/");
		// Plot 6 is the front-most plot. Each lot's sprite is square while its tile is half as tall,
		// so a lot's button reaches over the lots behind it: a tap at the middle of Plot 1's button
		// lands on Plot 5 (found by this spec, #673).
		const plot = page.getByRole("button", { name: "Plot 6: empty" });
		await expect(plot).toBeVisible();
		await expect(plot).not.toBeFocused();

		// A trusted touch on the phone projects; a mouse click at desktop width, which has no touch.
		if (hasTouch) await plot.tap();
		else await plot.click();

		// The farm map's lot button (#599) takes focus on press; its plot popover (#683) isn't on
		// main yet. Once it is, the tap opens it, and this expects the popover instead.
		await expect(plot).toBeFocused();
	});
});
