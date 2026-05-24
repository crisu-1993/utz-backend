-- ============================================================
-- UTZ Finance — Migración 015
-- Agrega columna recordatorio_id a niko_conversaciones
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Agrega columna recordatorio_id (uuid, nullable) a
--      niko_conversaciones. Nullable porque los mensajes de chat
--      normales y los avisos viejos no tienen recordatorio asociado.
--      SIN FK: la tabla recordatorios se creó externamente y no
--      queremos depender de su esquema exacto.
--   2. Crea un UNIQUE INDEX PARCIAL que impide insertar dos avisos
--      para el mismo recordatorio. Solo aplica cuando tipo='aviso'
--      Y recordatorio_id IS NOT NULL. Los NULL no participan en
--      el índice, así que chats normales y avisos viejos sin
--      recordatorio_id no se ven afectados.
--
-- Por qué:
--   El puente campanita→Niko (endpoint POST /aviso) insertaba un
--   aviso en niko_conversaciones sin saber a cuál recordatorio
--   pertenecía. Si el frontend llamaba varias veces (por recarga
--   de sesión), se generaban avisos duplicados (spam).
--   Con esta migración el endpoint puede recibir recordatorio_id
--   y la BD garantiza a nivel atómico que un recordatorio solo
--   genera UN aviso — sin lógica extra de SELECT previo y sin
--   race conditions entre tabs/dispositivos.
--
-- Impacto en código existente:
--   La columna es nullable y no tiene default, por lo que los
--   INSERTs actuales (chat normal, avisos viejos) siguen
--   funcionando sin cambios. Solo el endpoint /aviso necesitará
--   pasar recordatorio_id cuando se actualice en la siguiente fase.
-- ============================================================


-- ── 1. ADD COLUMN ────────────────────────────────────────────

ALTER TABLE niko_conversaciones
  ADD COLUMN IF NOT EXISTS recordatorio_id uuid;

COMMENT ON COLUMN niko_conversaciones.recordatorio_id IS
  'UUID del recordatorio que originó este aviso. NULL para mensajes de chat normales y avisos legacy. Usado por el UNIQUE parcial para impedir avisos duplicados del mismo recordatorio.';


-- ── 2. UNIQUE PARTIAL INDEX ─────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_niko_conv_aviso_unico
  ON niko_conversaciones (recordatorio_id)
  WHERE tipo = 'aviso' AND recordatorio_id IS NOT NULL;


-- ── 3. VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ────────
--
-- Confirma que la columna existe:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'niko_conversaciones'
--     AND column_name = 'recordatorio_id';
--
-- Resultado esperado:
--   column_name     | data_type | is_nullable | column_default
--   recordatorio_id | uuid      | YES         | NULL
--
-- Confirma que el índice existe:
--
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'niko_conversaciones'
--     AND indexname = 'idx_niko_conv_aviso_unico';
--
-- Resultado esperado:
--   indexname                  | indexdef
--   idx_niko_conv_aviso_unico | CREATE UNIQUE INDEX idx_niko_conv_aviso_unico ON ...
