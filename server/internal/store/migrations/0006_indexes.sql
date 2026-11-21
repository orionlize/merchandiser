-- Idempotent; applied on every start.
-- get_task loads each of its last 50 signals' orders by signal_id.
CREATE INDEX IF NOT EXISTS idx_orders_signal ON orders(signal_id);
