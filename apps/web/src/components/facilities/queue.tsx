import {
	sliceContent,
	type Action,
	type Job,
	type OwnedFacility,
	type Recipe,
} from "@sunny-pastures/sim";

import { Button } from "@/components/ui";

import { formatTimeLeft, nameGood } from "../orderBoard";

export interface FacilityQueueProps {
	readonly facility: OwnedFacility;
	readonly index: number;
	/** The farm's clock, in ms. */
	readonly now: number;
	/** Shows a "Collect" on a finished job; the popover's queue only reads. */
	readonly onCollect?: (action: Action) => void;
	/** Why "Collect" is off, or null when it works. */
	readonly collectReason?: string | null;
}

/** The queue slots, in the order the jobs started: running, waiting or done, with time left. */
export function FacilityQueue({
	facility,
	index,
	now,
	onCollect,
	collectReason = null,
}: FacilityQueueProps) {
	const slots = findSlots(index, facility);
	return (
		<ul aria-label="Queue">
			{Array.from({ length: slots }, (_, slot) => {
				const job = facility.jobs[slot];
				return (
					<li key={slot}>
						{job === undefined ? (
							<span>Slot {String(slot + 1)}: empty</span>
						) : (
							<span>
								Slot {String(slot + 1)}: {describeJob(job, facility.jobs[slot - 1], index, now)}
							</span>
						)}
						{job?.status === "done" && slot === 0 && onCollect !== undefined && (
							<>
								<Button
									variant="primary"
									isDisabled={collectReason !== null}
									onPress={() => {
										onCollect({ type: "collect", facility: index });
									}}
								>
									Collect
								</Button>
								{collectReason !== null && <p>{collectReason}</p>}
							</>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/** The queue's slots at the facility's tier now (MUST-03.5); tier 1 comes with the facility. */
function findSlots(index: number, facility: OwnedFacility): number {
	const content = sliceContent.facilities[index];
	if (content === undefined) return facility.jobs.length;

	return facility.tier <= 1 ? content.slots : (content.tiers[facility.tier - 2]?.slots ?? 0);
}

/** A job's line: what it makes and its state; a running one lists the time left from `now`. */
function describeJob(job: Job, before: Job | undefined, index: number, now: number): string {
	const recipes: Readonly<Record<string, Recipe | undefined>> | undefined =
		sliceContent.facilities[index]?.recipes;
	const output = recipes?.[job.recipe]?.output;
	const name = output === undefined ? job.recipe : nameGood(output.good, output.amount);
	if (job.status === "done") return `${name}, done`;

	// A job starts when the one before it ends, so a running job behind another one waits.
	const state = before?.status === "running" ? "waiting" : "running";
	return `${name}, ${state}, ${formatTimeLeft(job.readyAt, now)} left`;
}
