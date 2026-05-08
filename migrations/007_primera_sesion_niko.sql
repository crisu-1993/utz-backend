-- Migración 007: columna para detectar primera sesión de Niko por empresa
-- Permite que Niko use presentación formal solo en la primera conversación

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS primera_conversacion_niko_completada boolean DEFAULT false NOT NULL;

-- Marcar como completada a todas las empresas existentes (ya tuvieron su primera sesión)
UPDATE empresas
SET primera_conversacion_niko_completada = true
WHERE created_at < now() - interval '1 hour';
