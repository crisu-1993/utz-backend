-- ============================================================
-- UTZ Finance — Migración 019
-- Agregar clave de idempotencia a tabla recordatorios
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-05-25
--
-- Qué hace esta migración:
--   1. Agrega columna clave_idempotencia (text, NULLABLE) a la tabla
--      recordatorios. Los registros existentes quedan con NULL sin
--      romperse.
--   2. Crea un índice UNIQUE PARCIAL sobre clave_idempotencia que solo
--      aplica cuando el valor NO es NULL. Esto garantiza que:
--      - Los recordatorios tributarios generados por cron tengan una
--        clave única (ej. 'F29-<empresa_id>-2026-06') y no se dupliquen
--        si el proceso corre múltiples veces.
--      - Los recordatorios manuales existentes (clave NULL) convivan
--        sin conflicto, ya que PostgreSQL permite múltiples NULL en un
--        índice UNIQUE parcial.
--
-- Por qué:
--   El nuevo proceso de recordatorios tributarios (cron) necesita
--   idempotencia a nivel de BD: si el cron corre dos veces en el
--   mismo período, el segundo intento debe fallar con conflicto de
--   unique en vez de crear un duplicado. La ventana de 60 segundos
--   actual (anti-duplicados en JS) no es suficiente para un cron
--   que corre cada horas.
--
-- Sobre la columna 'origen':
--   La validación de origen ('manual', 'niko_a_pedido') es solo en
--   código JS (src/routes/recordatorios.js línea 96), NO hay CHECK
--   constraint en la BD. El nuevo valor 'tributario_auto' se agregará
--   en la validación JS en otra pieza, sin tocar la BD.
--
-- Impacto en código existente:
--   Ninguno. Es una columna nueva nullable y un índice nuevo.
--   Los queries existentes no referencian clave_idempotencia y
--   siguen funcionando igual.
-- ============================================================


-- ── 1. COLUMNA clave_idempotencia ──────────────────────────────

ALTER TABLE recordatorios
  ADD COLUMN IF NOT EXISTS clave_idempotencia text;

COMMENT ON COLUMN recordatorios.clave_idempotencia IS
  'Clave de idempotencia para recordatorios generados por cron. Formato: TIPO-EMPRESA_ID-PERIODO (ej. F29-uuid-2026-06). NULL para recordatorios manuales.';


-- ── 2. ÍNDICE UNIQUE PARCIAL ───────────────────────────────────
--
-- Solo aplica cuando clave_idempotencia IS NOT NULL.
-- Permite múltiples NULL (recordatorios manuales) sin conflicto.

CREATE UNIQUE INDEX IF NOT EXISTS idx_recordatorios_clave_idem
  ON recordatorios (clave_idempotencia)
  WHERE clave_idempotencia IS NOT NULL;


-- ── 3. VERIFICACIÓN POST-MIGRACIÓN ────────────────────────────
--
-- Confirmar que la columna existe:
--
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'recordatorios' AND column_name = 'clave_idempotencia';
--
-- Resultado esperado:
--   column_name          | data_type | is_nullable
--   clave_idempotencia   | text      | YES
--
-- Confirmar que el índice existe:
--
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'recordatorios' AND indexname = 'idx_recordatorios_clave_idem';
