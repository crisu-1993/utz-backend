-- ============================================================
-- UTZ Finance — Migración 020
-- Agregar 'tributario_auto' al CHECK constraint de origen
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-05-25
-- Estado: YA EJECUTADA A MANO el 2026-05-25
--
-- Qué hace esta migración:
--   Reemplaza el CHECK constraint recordatorios_origen_check para
--   que acepte tres valores: 'manual', 'niko_a_pedido' y
--   'tributario_auto'.
--
-- Por qué:
--   El constraint original fue creado directamente en Supabase
--   (sin migración) cuando se creó la tabla, y solo permitía
--   'manual' y 'niko_a_pedido'. El nuevo motor tributario
--   (src/services/recordatoriosTributarios.js) genera
--   recordatorios con origen = 'tributario_auto', lo que
--   producía un error de CHECK al insertar.
--   La validación JS en recordatorios.js:96 ya incluía
--   'tributario_auto' desde la pieza 3b-1, pero faltaba
--   actualizar la BD.
--
-- Impacto en código existente:
--   Ninguno. Solo amplía los valores permitidos en la columna.
--   Los recordatorios manuales y de Niko siguen funcionando
--   exactamente igual.
-- ============================================================


-- ── 1. REEMPLAZAR CHECK CONSTRAINT ────────────────────────────

ALTER TABLE recordatorios
  DROP CONSTRAINT IF EXISTS recordatorios_origen_check;

ALTER TABLE recordatorios
  ADD CONSTRAINT recordatorios_origen_check
  CHECK (origen = ANY (ARRAY['manual'::text, 'niko_a_pedido'::text, 'tributario_auto'::text]));


-- ── 2. VERIFICACIÓN POST-MIGRACIÓN ───────────────────────────
--
-- Confirmar que el constraint acepta los 3 valores:
--
--   SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--   WHERE conrelid = 'public.recordatorios'::regclass
--     AND conname = 'recordatorios_origen_check';
--
-- Resultado esperado:
--   conname                      | def
--   recordatorios_origen_check   | CHECK ((origen = ANY (ARRAY['manual'::text, 'niko_a_pedido'::text, 'tributario_auto'::text])))
