-- ============================================================
-- UTZ Finance — Migración 003
-- Agrega columna tratamiento a empresas
-- ============================================================
--
-- tratamiento define cómo Niko se dirige al cliente:
--   'tu'    → trato informal (default)
--   'usted' → trato formal
--
-- Ejecutar en Supabase SQL Editor.

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS tratamiento TEXT DEFAULT 'tu'
    CHECK (tratamiento IN ('tu', 'usted'));

COMMENT ON COLUMN empresas.tratamiento IS
  'Preferencia de tratamiento para Niko: "tu" (informal) o "usted" (formal). Default: tu.';
