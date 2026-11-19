-- What the source itself did at each signal, for auditing follower deviation.
ALTER TABLE signals ADD COLUMN src_ts INTEGER;      -- source's own fill time (ms), when known
ALTER TABLE signals ADD COLUMN src_px TEXT;         -- source execution price per coin
ALTER TABLE signals ADD COLUMN src_entry TEXT;      -- source average entry before the change
ALTER TABLE signals ADD COLUMN src_equity TEXT;     -- source account equity at detection
ALTER TABLE signals ADD COLUMN src_realized TEXT;   -- source realised PnL of the change, when known
ALTER TABLE signals ADD COLUMN src_basis TEXT;      -- fills | positions: how src_px / src_ts were obtained
