import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
	Badge,
	Button,
	Dialog,
	IconButton,
	Meter,
	Panel,
	Popover,
	showToast,
	ToastRegion,
} from "../index";

describe("Button", () => {
	it("is a button named by its text, with the default variant and size", () => {
		render(<Button>Plant</Button>);

		const button = screen.getByRole("button", { name: "Plant" });
		expect(button.getAttribute("data-variant")).toBe("secondary");
		expect(button.getAttribute("data-size")).toBe("md");
	});

	it("sets data-variant and data-size from its props", () => {
		render(
			<Button variant="danger" size="sm">
				Sell
			</Button>,
		);

		const button = screen.getByRole("button", { name: "Sell" });
		expect(button.getAttribute("data-variant")).toBe("danger");
		expect(button.getAttribute("data-size")).toBe("sm");
	});

	it("fires onPress on click, Enter and Space", async () => {
		const user = userEvent.setup();
		const onPress = vi.fn();
		render(<Button onPress={onPress}>Plant</Button>);

		await user.click(screen.getByRole("button"));
		expect(onPress).toHaveBeenCalledTimes(1);

		await user.keyboard("{Enter}");
		expect(onPress).toHaveBeenCalledTimes(2);

		await user.keyboard(" ");
		expect(onPress).toHaveBeenCalledTimes(3);
	});
});

describe("IconButton", () => {
	it("takes its accessible name from label", () => {
		render(
			<IconButton label="Close">
				<svg aria-hidden="true" />
			</IconButton>,
		);

		const button = screen.getByRole("button", { name: "Close" });
		expect(button.getAttribute("data-variant")).toBe("quiet");
		expect(button.getAttribute("data-size")).toBe("md");
	});

	it("fires onPress on click, Enter and Space", async () => {
		const user = userEvent.setup();
		const onPress = vi.fn();
		render(
			<IconButton label="Close" onPress={onPress}>
				<svg aria-hidden="true" />
			</IconButton>,
		);

		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.keyboard("{Enter}");
		await user.keyboard(" ");

		expect(onPress).toHaveBeenCalledTimes(3);
	});
});

describe("Badge", () => {
	it("shows its text with the neutral tone by default", () => {
		render(<Badge>New</Badge>);

		expect(screen.getByText("New").getAttribute("data-tone")).toBe("neutral");
	});

	it("sets data-tone from its prop", () => {
		render(<Badge tone="success">Done</Badge>);

		expect(screen.getByText("Done").getAttribute("data-tone")).toBe("success");
	});
});

describe("Panel", () => {
	it("is a region named by its label", () => {
		render(<Panel label="Orders">Nothing yet.</Panel>);

		expect(screen.getByRole("region", { name: "Orders" }).textContent).toBe("Nothing yet.");
	});
});

describe("Meter", () => {
	it("is a meter named by its label that exposes its value and maximum", () => {
		render(<Meter label="Barn" value={30} max={50} />);

		const meter = screen.getByRole("meter", { name: "Barn" });
		expect(meter.getAttribute("aria-valuenow")).toBe("30");
		expect(meter.getAttribute("aria-valuemax")).toBe("50");
	});
});

describe("Dialog", () => {
	it("is a modal dialog named by its title", () => {
		render(
			<Dialog title="Sell goods" isOpen onOpenChange={vi.fn()}>
				<Button>Confirm</Button>
			</Dialog>,
		);

		expect(screen.getByRole("dialog", { name: "Sell goods" })).toBeTruthy();
	});

	it("keeps focus inside while open", async () => {
		const user = userEvent.setup();
		render(
			<>
				<Button>Outside</Button>
				<Dialog title="Sell goods" isOpen onOpenChange={vi.fn()}>
					<Button>Confirm</Button>
					<Button>Cancel</Button>
				</Dialog>
			</>,
		);

		for (let tab = 0; tab < 5; tab += 1) {
			await user.tab();
			expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
		}
	});

	it("asks to close on Escape", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(
			<Dialog title="Sell goods" isOpen onOpenChange={onOpenChange}>
				<Button>Confirm</Button>
			</Dialog>,
		);

		await user.keyboard("{Escape}");

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

describe("Popover", () => {
	it("opens from its trigger and returns focus to it on close", async () => {
		const user = userEvent.setup();
		render(
			<Popover trigger={<Button>Info</Button>} label="Details">
				<p>Ripens in two minutes.</p>
			</Popover>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Info" }));
		expect(screen.getByRole("dialog", { name: "Details" })).toBeTruthy();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Info" }));
		});
	});
});

describe("showToast", () => {
	it("announces the message in a live region", () => {
		render(<ToastRegion />);

		act(() => {
			showToast("Wheat planted.");
		});

		const region = screen.getByRole("region", { name: "Notifications" });
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Wheat planted.");
		expect(region.contains(alert)).toBe(true);
	});
});
