-- Second line of defence for the ledger invariant (SERVER_PLAN S0).
-- money/ledger.js already refuses to post an unbalanced transaction; this
-- constraint means even a hand-written INSERT cannot create money. It is
-- DEFERRABLE so entries may be inserted one row at a time inside a transaction
-- and are only checked at COMMIT.

CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger AS $$
DECLARE
  offending record;
BEGIN
  SELECT transaction_id, currency, SUM(amount) AS total
    INTO offending
    FROM ledger_entries
   WHERE transaction_id = COALESCE(NEW.transaction_id, OLD.transaction_id)
   GROUP BY transaction_id, currency
  HAVING SUM(amount) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % does not balance in %: sum = %',
      offending.transaction_id, offending.currency, offending.total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

-- Ledger entries are immutable: corrections are compensating transactions
-- (PLATFORM_PLAN §2.3), never edits or deletes.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are immutable — post a reversing transaction instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
