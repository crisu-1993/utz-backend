-- ───────────────────────────────────────────────────────
-- Migración 006: UNIQUE constraint en reglas_categorizacion
-- ───────────────────────────────────────────────────────
-- Propósito: Permite usar UPSERT nativo de Supabase para
-- la creación de reglas y previene duplicados a nivel BD.
--
-- Necesario porque:
-- - UPSERT manual (SELECT → UPDATE/INSERT) tiene race
--   conditions: dos requests simultáneos podrían crear
--   duplicados
-- - .upsert() de Supabase necesita un constraint UNIQUE
--   declarado para usar onConflict
--
-- Garantiza: cada empresa tiene UNA sola regla por
-- combinación (patron, tipo_patron). Si Niko o el
-- usuario intentan crear una regla que ya existe, se
-- actualiza en lugar de duplicar.
-- ───────────────────────────────────────────────────────

ALTER TABLE reglas_categorizacion
  ADD CONSTRAINT uq_regla_empresa_patron_tipo
  UNIQUE (empresa_id, patron, tipo_patron);


-- ── VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ──────
--
-- Confirma que el constraint quedó creado:
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'reglas_categorizacion'::regclass
--     AND contype = 'u';
--
-- Resultado esperado:
--   conname                        | pg_get_constraintdef
--   uq_regla_empresa_patron_tipo   | UNIQUE (empresa_id, patron, tipo_patron)
