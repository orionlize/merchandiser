-- How a 'fills' lead source reads the trade history:
-- NULL/'interval' = every few seconds; 'trigger' = when lastTradeTime moves.
ALTER TABLE sources ADD COLUMN lead_poll TEXT;
