import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { actions, snapshots } from "../schema";

// The table definitions drizzle-kit generates the migrations from (#372, criterion 2; #331
// decisions 1, 3, 4 and 5). grants.stack.ts checks what the database then does with them.
function describeTable(table: PgTable) {
	const config = getTableConfig(table);
	return {
		schema: config.schema,
		name: config.name,
		rls: config.enableRLS,
		columns: config.columns.map((column) => [column.name, column.getSQLType(), column.notNull]),
		defaults: config.columns.filter((column) => column.hasDefault).map((column) => column.name),
		primaryKey: config.primaryKeys.map((key) => key.columns.map((column) => column.name)),
		unique: config.uniqueConstraints.map((key) => key.columns.map((column) => column.name)),
		checks: config.checks.map((check) => check.name),
		indexes: config.indexes.length,
		foreignKeys: config.foreignKeys.map((key) => {
			const reference = key.reference();
			const foreign = getTableConfig(reference.foreignTable);
			return {
				columns: reference.columns.map((column) => column.name),
				references: `${foreign.schema ?? "public"}.${foreign.name}(${reference.foreignColumns.map((column) => column.name).join()})`,
				onDelete: key.onDelete,
			};
		}),
	};
}

const toAuthUsers = { columns: ["farm_id"], references: "auth.users(id)", onDelete: "cascade" };

describe("game.actions", () => {
	it("is the action log: not null everywhere, keyed by farm and seq, with RLS on", () => {
		expect(describeTable(actions)).toEqual({
			schema: "game",
			name: "actions",
			rls: true,
			columns: [
				["farm_id", "uuid", true],
				["seq", "bigint", true],
				["at", "bigint", true],
				["action", "jsonb", true],
				["idempotency_key", "uuid", true],
				["answer", "jsonb", true],
				["rules_version", "integer", true],
			],
			defaults: [],
			primaryKey: [["farm_id", "seq"]],
			unique: [["farm_id", "idempotency_key"]],
			checks: ["actions_seq_check", "actions_at_check", "actions_rules_version_check"],
			indexes: 0,
			foreignKeys: [toAuthUsers],
		});
	});
});

describe("game.snapshots", () => {
	it("is keyed by farm, seq and rules version, with RLS on", () => {
		expect(describeTable(snapshots)).toEqual({
			schema: "game",
			name: "snapshots",
			rls: true,
			columns: [
				["farm_id", "uuid", true],
				["seq", "bigint", true],
				["at", "bigint", true],
				["state", "jsonb", true],
				["rules_version", "integer", true],
			],
			defaults: [],
			primaryKey: [["farm_id", "seq", "rules_version"]],
			unique: [],
			checks: ["snapshots_seq_check", "snapshots_at_check", "snapshots_rules_version_check"],
			indexes: 0,
			foreignKeys: [toAuthUsers],
		});
	});
});
