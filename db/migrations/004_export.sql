-- Export: SOLAS verified gross mass details and vessel stowage position.

ALTER TABLE units
  ADD COLUMN vgm_method       text CHECK (vgm_method IS NULL OR vgm_method IN ('SM1','SM2')),
  ADD COLUMN vgm_verified_by  text,          -- responsible party / signatory
  ADD COLUMN vgm_at           timestamptz,
  ADD COLUMN stow_position    text;          -- vessel cell, bay-row-tier (e.g. 0120682)

ALTER TABLE units ADD CONSTRAINT units_vgm_positive CHECK (vgm_kg IS NULL OR vgm_kg > 0);
