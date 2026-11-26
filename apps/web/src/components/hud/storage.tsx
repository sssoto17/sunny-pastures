import type { FarmStorage } from "@/client/store";
import { Button, Meter, Popover } from "@/components/ui";

import { listGoods } from "./goods";

type StoredGoods = FarmStorage["silo"];

export interface StorageProps {
	readonly storage: FarmStorage;
}

/** The silo's and the barn's fill as meters, and the Storage button that lists what each holds. */
export function Storage({ storage }: StorageProps) {
	return (
		<>
			<FillMeter label="Silo" stored={storage.silo} />
			<FillMeter label="Barn" stored={storage.barn} />
			<Popover trigger={<Button size="sm">Storage</Button>} label="Storage">
				<GoodsList label="Silo" stored={storage.silo} />
				<GoodsList label="Barn" stored={storage.barn} />
			</Popover>
		</>
	);
}

interface StoredProps {
	readonly label: string;
	readonly stored: StoredGoods;
}

function FillMeter({ label, stored }: StoredProps) {
	const total = Object.values(stored.goods).reduce((sum, count) => sum + count, 0);
	return (
		<Meter
			label={label}
			value={total}
			max={stored.capacity}
			valueLabel={`${String(total)} of ${String(stored.capacity)}`}
		/>
	);
}

function GoodsList({ label, stored }: StoredProps) {
	const goods = listGoods(stored.goods);
	return (
		<>
			<h2>{label}</h2>
			<ul aria-label={label}>
				{goods.length === 0 && <li>Empty</li>}
				{goods.map((good) => (
					<li key={good.id}>
						{good.name}: {good.count}
					</li>
				))}
			</ul>
		</>
	);
}
