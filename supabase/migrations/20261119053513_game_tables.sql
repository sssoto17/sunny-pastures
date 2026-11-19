CREATE SCHEMA "game";
--> statement-breakpoint
CREATE TABLE "game"."actions" (
	"farm_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"at" bigint NOT NULL,
	"action" jsonb NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"rules_version" integer NOT NULL,
	CONSTRAINT "actions_farm_id_seq_pk" PRIMARY KEY("farm_id","seq"),
	CONSTRAINT "actions_farm_id_idempotency_key_unique" UNIQUE("farm_id","idempotency_key"),
	CONSTRAINT "actions_seq_check" CHECK ("game"."actions"."seq" between 1 and 9007199254740991),
	CONSTRAINT "actions_at_check" CHECK ("game"."actions"."at" between 0 and 9007199254740991),
	CONSTRAINT "actions_rules_version_check" CHECK ("game"."actions"."rules_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "game"."actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "game"."snapshots" (
	"farm_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"at" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"rules_version" integer NOT NULL,
	CONSTRAINT "snapshots_farm_id_seq_rules_version_pk" PRIMARY KEY("farm_id","seq","rules_version"),
	CONSTRAINT "snapshots_seq_check" CHECK ("game"."snapshots"."seq" between 1 and 9007199254740991),
	CONSTRAINT "snapshots_at_check" CHECK ("game"."snapshots"."at" between 0 and 9007199254740991),
	CONSTRAINT "snapshots_rules_version_check" CHECK ("game"."snapshots"."rules_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "game"."snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "game"."actions" ADD CONSTRAINT "actions_farm_id_users_id_fk" FOREIGN KEY ("farm_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game"."snapshots" ADD CONSTRAINT "snapshots_farm_id_users_id_fk" FOREIGN KEY ("farm_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;