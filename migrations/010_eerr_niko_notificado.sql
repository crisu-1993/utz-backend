-- Migración 010: flag notificación Niko sobre EERR Ampliado
ALTER TABLE empresas
ADD COLUMN IF NOT EXISTS eerr_ampliado_niko_notificado
boolean DEFAULT false;

-- Verificación
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'empresas'
AND column_name = 'eerr_ampliado_niko_notificado';
