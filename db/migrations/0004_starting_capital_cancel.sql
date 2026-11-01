ALTER TABLE "starting_capital" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "starting_capital" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "starting_capital" ADD CONSTRAINT "starting_capital_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;