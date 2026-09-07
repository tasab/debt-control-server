CREATE TABLE "account_balances" (
	"account_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"data" jsonb,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "balance_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"exponent" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_base" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"currency" text,
	"percent_bps" integer DEFAULT 0 NOT NULL,
	"fixed_amount" bigint DEFAULT 0 NOT NULL,
	"min_amount" bigint,
	"max_amount" bigint,
	"payer" text DEFAULT 'sender' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_key_scope_pk" PRIMARY KEY("key","scope")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"entry_type" text,
	"comment" text,
	"counterparty_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rotated_to" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"idempotency_key" text,
	"actor_id" text,
	"reversal_of" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" text[] DEFAULT ARRAY['invest']::text[] NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"bid" bigint NOT NULL,
	"sell" bigint NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fx_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"amount_from" bigint NOT NULL,
	"amount_to" bigint NOT NULL,
	"rate_used" bigint NOT NULL,
	"side" text NOT NULL,
	"rate_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_currency" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_count_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"count_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"register_id" text,
	"currency" text NOT NULL,
	"counted" bigint NOT NULL,
	"previous" bigint NOT NULL,
	"delta" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"transaction_id" text,
	"counted_by" text,
	"note" text,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reversal_tx_id" text
);
--> statement-breakpoint
CREATE TABLE "registers" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "starting_capital" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"joined_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"hidden_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"direction" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"target_account_id" text,
	"transaction_id" text,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
CREATE TABLE "member_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"rate_annual_bps" integer DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_shares" ADD CONSTRAINT "balance_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_source_id_rate_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."rate_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_quote_currencies_code_fk" FOREIGN KEY ("quote") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_rate_id_exchange_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count_lines" ADD CONSTRAINT "cash_count_lines_count_id_cash_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."cash_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count_lines" ADD CONSTRAINT "cash_count_lines_register_id_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starting_capital" ADD CONSTRAINT "starting_capital_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_rates" ADD CONSTRAINT "member_rates_member_id_business_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."business_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_identity" ON "accounts" USING btree ("owner_type","owner_id","kind","currency") WHERE kind <> 'business_register';--> statement-breakpoint
CREATE INDEX "idx_accounts_owner" ON "accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_log" USING btree ("actor_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_balance_shares_token" ON "balance_shares" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_balance_shares_user" ON "balance_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_fee_policies_kind" ON "fee_policies" USING btree ("kind","effective_from");--> statement-breakpoint
CREATE INDEX "idx_entries_account" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_entries_tx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transactions_idem" ON "transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_transactions_created" ON "transactions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_rates_pair" ON "exchange_rates" USING btree ("base","quote","observed_at");--> statement-breakpoint
CREATE INDEX "idx_fx_quotes_user" ON "fx_quotes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_businesses_owner" ON "businesses" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_cash_count_lines_count" ON "cash_count_lines" USING btree ("count_id");--> statement-breakpoint
CREATE INDEX "idx_cash_counts_biz" ON "cash_counts" USING btree ("business_id","counted_at");--> statement-breakpoint
CREATE INDEX "idx_registers_biz" ON "registers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_starting_capital_biz" ON "starting_capital" USING btree ("business_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_members_pair" ON "business_members" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_members_user" ON "business_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_contributions_member" ON "contributions" USING btree ("member_id","declared_at");--> statement-breakpoint
CREATE INDEX "idx_contributions_status" ON "contributions" USING btree ("status","declared_at");--> statement-breakpoint
CREATE INDEX "idx_member_rates_member" ON "member_rates" USING btree ("member_id","effective_from");