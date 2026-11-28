"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import {
	Button as AriaButton,
	Dialog as AriaDialog,
	Meter as AriaMeter,
	Popover as AriaPopover,
	UNSTABLE_ToastRegion as AriaToastRegion,
	DialogTrigger,
	Heading,
	Label,
	Modal,
	ModalOverlay,
	Text,
	UNSTABLE_Toast as Toast,
	UNSTABLE_ToastContent as ToastContent,
	UNSTABLE_ToastQueue as ToastQueue,
} from "react-aria-components";
import type { PressEvent } from "react-aria-components";

/**
 * The UI primitives (ADR-0010, section 6): thin React Aria wrappers every screen uses. They carry
 * no class names, colours or sizes; each sets `data-variant`, `data-size` or `data-tone` from its
 * props, and the design-system strand styles those attributes in place without changing a
 * signature. Pattern: Adapter over React Aria Components, with a closed set of variants.
 */

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md";
export type BadgeTone = "neutral" | "attention" | "success";

export interface ButtonProps {
	/** @default "secondary" */
	variant?: ButtonVariant;
	/** @default "md" */
	size?: ButtonSize;
	children: ReactNode;
	onPress?: (event: PressEvent) => void;
	isDisabled?: boolean;
}

export function Button({ variant = "secondary", size = "md", ...rest }: ButtonProps) {
	return <AriaButton {...rest} data-variant={variant} data-size={size} />;
}

export interface IconButtonProps {
	/** The accessible name: an icon has no text of its own. */
	label: string;
	/** @default "quiet" */
	variant?: ButtonVariant;
	/** @default "md" */
	size?: ButtonSize;
	/** The icon. */
	children: ReactNode;
	onPress?: (event: PressEvent) => void;
	isDisabled?: boolean;
}

export function IconButton({ label, variant = "quiet", size = "md", ...rest }: IconButtonProps) {
	return <AriaButton {...rest} aria-label={label} data-variant={variant} data-size={size} />;
}

export interface BadgeProps {
	/** @default "neutral" */
	tone?: BadgeTone;
	children: ReactNode;
}

/** One pulse of an attention cue, in ms; the styles animate `[data-pulse]` over this long. */
export const pulseCycleMs = 1200;
/** An attention cue pulses this many cycles after it appears, then rests (ADR-0010). */
export const pulseCycles = 3;

/**
 * An `attention` badge sets `data-pulse` for its first `pulseCycles` cycles, then rests (ADR-0010,
 * "Accessibility bar"). Under `prefers-reduced-motion: reduce` it never sets it.
 */
export function Badge({ tone = "neutral", children }: BadgeProps) {
	const isPulsing = usePulse(tone === "attention");
	return (
		<span data-tone={tone} {...(isPulsing ? { "data-pulse": "" } : {})}>
			{children}
		</span>
	);
}

/** True for the first cycles after mount while `isOn`; never under reduced motion. */
function usePulse(isOn: boolean): boolean {
	const [isPulsing, setIsPulsing] = useState(false);
	useEffect(() => {
		const isStill =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (!isOn || isStill) return;

		setIsPulsing(true);
		const timer = setTimeout(() => {
			setIsPulsing(false);
		}, pulseCycles * pulseCycleMs);
		return () => {
			clearTimeout(timer);
		};
	}, [isOn]);
	return isPulsing;
}

export interface PanelProps {
	/** The region's accessible name. */
	label: string;
	children: ReactNode;
}

export function Panel({ label, children }: PanelProps) {
	return (
		<section aria-label={label} data-panel="">
			{children}
		</section>
	);
}

export interface MeterProps {
	label: string;
	value: number;
	max: number;
	/** The value as words, shown and announced in place of the default percentage. */
	valueLabel?: string;
}

export function Meter({ label, value, max, valueLabel }: MeterProps) {
	return (
		<AriaMeter value={value} minValue={0} maxValue={max} valueLabel={valueLabel}>
			{({ valueText }) => (
				<>
					<Label>{label}</Label>
					<span>{valueText}</span>
					<div data-meter-track="">
						<div data-meter-fill="" />
					</div>
				</>
			)}
		</AriaMeter>
	);
}

export interface PopoverProps {
	/** The element that opens it: a `Button` or an `IconButton`. */
	trigger: ReactElement;
	/** The popover's accessible name. */
	label: string;
	/** Content, or a function of `close`, for a button inside that closes the popover. */
	children: ReactNode | ((close: () => void) => ReactNode);
}

export function Popover({ trigger, label, children }: PopoverProps) {
	return (
		<DialogTrigger>
			{trigger}
			<AriaPopover>
				<AriaDialog aria-label={label}>
					{typeof children === "function" ? ({ close }) => children(close) : children}
				</AriaDialog>
			</AriaPopover>
		</DialogTrigger>
	);
}

export interface DialogProps {
	/** Shown as the dialog's heading and its accessible name. */
	title: string;
	children: ReactNode;
	isOpen: boolean;
	onOpenChange: (isOpen: boolean) => void;
}

/** A modal: focus stays inside while it is open, and Escape closes it. */
export function Dialog({ title, children, isOpen, onOpenChange }: DialogProps) {
	return (
		<ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
			<Modal>
				<AriaDialog>
					<Heading slot="title">{title}</Heading>
					{children}
				</AriaDialog>
			</Modal>
		</ModalOverlay>
	);
}

interface ToastContentValue {
	message: string;
}

const toastTimeoutMs = 5000;
const toastQueue = new ToastQueue<ToastContentValue>({ maxVisibleToasts: 3 });

/** Queues a message for the `ToastRegion`, which announces it in a live region. */
export function showToast(message: string): void {
	toastQueue.add({ message }, { timeout: toastTimeoutMs });
}

/** Mount once, near the root; `showToast` feeds it. */
export function ToastRegion() {
	return (
		<AriaToastRegion queue={toastQueue} aria-label="Notifications">
			{({ toast }) => (
				<Toast toast={toast}>
					<ToastContent>
						<Text slot="title">{toast.content.message}</Text>
					</ToastContent>
					<AriaButton slot="close" aria-label="Dismiss">
						×
					</AriaButton>
				</Toast>
			)}
		</AriaToastRegion>
	);
}
