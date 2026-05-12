-- Migration: create niko_recordatorios
-- Purpose: persist proactive reminders sent by Niko (categorization pending, incoherent transactions, etc.)
-- Created: 2026-05-12

CREATE TABLE niko_recordatorios (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  leido       boolean NOT NULL DEFAULT false,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_niko_recordatorios_empresa_id
  ON niko_recordatorios (empresa_id);

CREATE INDEX idx_niko_recordatorios_empresa_leido
  ON niko_recordatorios (empresa_id, leido)
  WHERE leido = false;

ALTER TABLE niko_recordatorios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their niko_recordatorios"
  ON niko_recordatorios FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = niko_recordatorios.empresa_id
        AND e.owner_id = auth.uid()
    )
  );
