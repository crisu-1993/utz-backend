-- Migración 009: flag revelación EERR Ampliado
ALTER TABLE empresas
ADD COLUMN IF NOT EXISTS eerr_ampliado_revelado
boolean DEFAULT false;

ALTER TABLE empresas
ADD COLUMN IF NOT EXISTS eerr_ampliado_revelado_at
timestamptz;

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'empresas'
AND column_name IN (
  'eerr_ampliado_revelado',
  'eerr_ampliado_revelado_at'
);
