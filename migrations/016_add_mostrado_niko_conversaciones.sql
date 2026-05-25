-- ============================================================
-- UTZ Finance — Migración 016
-- Agrega columna mostrado a niko_conversaciones
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Agrega columna mostrado (boolean, NOT NULL, default false)
--      a niko_conversaciones. Indica si un aviso (tipo='aviso')
--      ya provocó que la burbuja del chat se abriera en el frontend.
--      Los mensajes de chat normales también quedan en false, pero
--      no importa — la lógica de "mostrar burbuja" solo mira
--      tipo='aviso'.
--   2. Marca como mostrado=true todos los avisos PRE-EXISTENTES
--      al momento de la migración, para que la Capa 3 no intente
--      abrir la burbuja por avisos históricos que ya son viejos
--      cuando se despliega. Los avisos NUEVOS, posteriores a la
--      migración, nacerán con mostrado=false y activarán la
--      burbuja correctamente.
--
-- Por qué:
--   Capa 3 del puente campanita-Niko. Sin esta columna, cada vez
--   que el frontend consulta mensajes no leídos, la burbuja se
--   abriría repetidamente por el mismo aviso. Con `mostrado`, la
--   burbuja se abre UNA sola vez por aviso: el frontend la abre,
--   marca mostrado=true, y no vuelve a insistir.
--
-- Impacto en código existente:
--   La columna tiene default false y NOT NULL, por lo que los
--   INSERTs actuales (chat normal, avisos) siguen funcionando
--   sin cambios. Solo la lógica de Capa 3 (frontend) usará
--   esta columna para filtrar avisos pendientes de mostrar.
-- ============================================================


-- ── 1. ADD COLUMN ────────────────────────────────────────────

ALTER TABLE niko_conversaciones
  ADD COLUMN IF NOT EXISTS mostrado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN niko_conversaciones.mostrado IS
  'Indica si este aviso (tipo=aviso) ya provocó que la burbuja del chat se abriera en el frontend. La lógica de Capa 3 solo mira esta columna en filas con tipo=aviso. Los mensajes normales quedan en false sin efecto.';


-- ── 2. MARCAR AVISOS PRE-EXISTENTES COMO YA MOSTRADOS ───────
--
-- Todos los avisos que existan al momento de migrar se consideran
-- "ya mostrados" para que el despliegue no abra burbujas por
-- avisos históricos. Los avisos nuevos (post-migración) nacerán
-- con mostrado=false y activarán la burbuja una vez.

UPDATE niko_conversaciones SET mostrado = true WHERE tipo = 'aviso';


-- ── 3. VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ────────
--
-- Confirma que la columna existe:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'niko_conversaciones'
--     AND column_name = 'mostrado';
--
-- Resultado esperado:
--   column_name | data_type | is_nullable | column_default
--   mostrado    | boolean   | NO          | false
