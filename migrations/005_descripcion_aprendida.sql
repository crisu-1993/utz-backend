-- ============================================================
-- UTZ Finance — Migración 005
-- EERR Adaptativo: columna descripcion_aprendida en reglas
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Agrega columna descripcion_aprendida (text, nullable)
--      a reglas_categorizacion
--   2. NO modifica índices (no aplica indexar texto libre)
--   3. NO modifica RLS (la columna hereda las policies
--      existentes de la tabla automáticamente)
-- ============================================================


-- ── 1. ALTER TABLE ───────────────────────────────────────────

ALTER TABLE reglas_categorizacion
  ADD COLUMN IF NOT EXISTS descripcion_aprendida text;

COMMENT ON COLUMN reglas_categorizacion.descripcion_aprendida IS
  'Contexto que el usuario le dio a Niko al confirmar la regla.
   Ej: "le compro harina a Don Manuel", "es el arriendo del local".
   Niko lo usa para recordar de qué se trata el patrón sin tener
   que preguntar de nuevo. Nullable: las reglas creadas antes de
   esta migración no tienen contexto guardado.';


-- ── 2. VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ────────
--
-- Confirma que la columna existe con el tipo correcto:
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'reglas_categorizacion'
--     AND column_name = 'descripcion_aprendida';
--
-- Resultado esperado:
--   column_name             | data_type | is_nullable
--   descripcion_aprendida   | text      | YES
