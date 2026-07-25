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
	"related_loan_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
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
CREATE TABLE "funding_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount_target" bigint NOT NULL,
	"amount_funded" bigint DEFAULT 0 NOT NULL,
	"rate_annual_bps" integer NOT NULL,
	"term_days" integer NOT NULL,
	"repayment_type" text NOT NULL,
	"min_ticket" bigint DEFAULT 10000 NOT NULL,
	"min_fill_bps" integer DEFAULT 5000 NOT NULL,
	"purpose" text,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fundings" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"hold_tx_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "loan_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"loan_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"principal_share" bigint NOT NULL,
	"share_bps" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"business_id" text NOT NULL,
	"currency" text NOT NULL,
	"principal" bigint NOT NULL,
	"outstanding_principal" bigint NOT NULL,
	"accrued_interest" bigint DEFAULT 0 NOT NULL,
	"paid_interest" bigint DEFAULT 0 NOT NULL,
	"rate_annual_bps" integer NOT NULL,
	"term_days" integer NOT NULL,
	"repayment_type" text NOT NULL,
	"status" text DEFAULT 'disbursed' NOT NULL,
	"disbursed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accrued_through" timestamp with time zone,
	"matures_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repayment_splits" (
	"id" text PRIMARY KEY NOT NULL,
	"repayment_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"principal" bigint DEFAULT 0 NOT NULL,
	"interest" bigint DEFAULT 0 NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repayments" (
	"id" text PRIMARY KEY NOT NULL,
	"loan_id" text NOT NULL,
	"seq" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"principal_due" bigint DEFAULT 0 NOT NULL,
	"interest_due" bigint DEFAULT 0 NOT NULL,
	"principal_paid" bigint DEFAULT 0 NOT NULL,
	"interest_paid" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"amount_base" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_snapshots_user_id_date_currency_kind_pk" PRIMARY KEY("user_id","date","currency","kind")
);
--> statement-breakpoint
ALTER TABLE "account_balances" ADD CONSTRAINT "account_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_source_id_rate_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."rate_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_quote_currencies_code_fk" FOREIGN KEY ("quote") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_rate_id_exchange_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."exchange_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starting_capital" ADD CONSTRAINT "starting_capital_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundings" ADD CONSTRAINT "fundings_request_id_funding_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."funding_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundings" ADD CONSTRAINT "fundings_investor_id_users_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_shares" ADD CONSTRAINT "loan_shares_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_shares" ADD CONSTRAINT "loan_shares_investor_id_users_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_request_id_funding_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."funding_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_splits" ADD CONSTRAINT "repayment_splits_repayment_id_repayments_id_fk" FOREIGN KEY ("repayment_id") REFERENCES "public"."repayments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_splits" ADD CONSTRAINT "repayment_splits_investor_id_users_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayments" ADD CONSTRAINT "repayments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_identity" ON "accounts" USING btree ("owner_type","owner_id","kind","currency") WHERE kind <> 'business_register';--> statement-breakpoint
CREATE INDEX "idx_accounts_owner" ON "accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_log" USING btree ("actor_id","ts");--> statement-breakpoint
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
CREATE INDEX "idx_registers_biz" ON "registers" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_starting_capital_biz" ON "starting_capital" USING btree ("business_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_requests_status" ON "funding_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_requests_business" ON "funding_requests" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_fundings_request" ON "fundings" USING btree ("request_id","status");--> statement-breakpoint
CREATE INDEX "idx_fundings_investor" ON "fundings" USING btree ("investor_id","status");--> statement-breakpoint
CREATE INDEX "idx_shares_loan" ON "loan_shares" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "idx_shares_investor" ON "loan_shares" USING btree ("investor_id");--> statement-breakpoint
CREATE INDEX "idx_loans_business" ON "loans" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "idx_splits_repayment" ON "repayment_splits" USING btree ("repayment_id");--> statement-breakpoint
CREATE INDEX "idx_repayments_loan" ON "repayments" USING btree ("loan_id","due_at");--> statement-breakpoint
CREATE INDEX "idx_snapshots_user_date" ON "balance_snapshots" USING btree ("user_id","date");