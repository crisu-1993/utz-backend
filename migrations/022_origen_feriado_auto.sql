-- ============================================================
-- UTZ Finance -- Migracion 022
-- Agregar 'feriado_auto' al CHECK constraint de origen
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-05-27
--
-- Que hace esta migracion:
--   Reemplaza el CHECK constraint recordatorios_origen_check para
--   que acepte cuatro valores: 'manual', 'niko_a_pedido',
--   'tributario_auto' y 'feriado_auto'.
--
-- Por que:
--   El nuevo motor de avisos de feriados (semana corta) generara
--   recordatorios con origen = 'feriado_auto'. Sin esta migracion
--   el INSERT falla por el CHECK constraint existente que solo
--   permite 3 valores.
--
-- Idempotente:
--   Si. DROP IF EXISTS + ADD es seguro de ejecutar multiples veces.
--
-- Impacto en codigo existente:
--   Ninguno. Solo amplia los valores permitidos en la columna.
--   Los recordatorios manuales, de Niko y tributarios siguen
--   funcionando exactamente igual.
-- ============================================================


-- -- 1. REEMPLAZAR CHECK CONSTRAINT ------------------------------------------

ALTER TABLE recordatorios
  DROP CONSTRAINT IF EXISTS recordatorios_origen_check;

ALTER TABLE recordatorios
  ADD CONSTRAINT recordatorios_origen_check
  CHECK (origen = ANY (ARRAY['manual'::text, 'niko_a_pedido'::text, 'tributario_auto'::text, 'feriado_auto'::text]));


-- -- 2. VERIFICACION POST-MIGRACION -----------------------------------------
--
-- Confirmar que el constraint acepta los 4 valores:
--
--   SELECT conname, pg_get_constraintdef(oid) AS def
--   FROM pg_constraint
--   WHERE conrelid = 'public.recordatorios'::regclass
--     AND conname = 'recordatorios_origen_check';
--
-- Resultado esperado:
--   conname                      | def
--   recordatorios_origen_check   | CHECK ((origen = ANY (ARRAY['manual'::text, 'niko_a_pedido'::text, 'tributario_auto'::text, 'feriado_auto'::text])))
