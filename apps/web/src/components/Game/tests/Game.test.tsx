import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import Game from "../index";

describe("Game", () => {
	it("tells the player, in a status message, that their farm is loading", () => {
		render(<Game />);

		expect(screen.getByRole("status").textContent).toBe("Loading your farm…");
	});
});
