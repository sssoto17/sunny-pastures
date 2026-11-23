import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Game } from "../index";

describe("Game", () => {
	it("tells the player their farm is loading before it arrives", () => {
		render(<Game />);

		expect(screen.getByText("Loading your farm…")).toBeTruthy();
	});
});
