-- ============================================================
-- UTZ Finance — Migración 014
-- Agrega columna tipo a niko_conversaciones
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Agrega columna tipo (text, NOT NULL, DEFAULT 'chat')
--      a niko_conversaciones, con CHECK ('chat' o 'aviso').
--   2. NO modifica índices (el filtro por tipo será poco
--      selectivo: la gran mayoría son 'chat').
--   3. NO modifica RLS (la columna hereda las policies
--      existentes de la tabla automáticamente).
--
-- Por qué:
--   Necesitamos distinguir mensajes de chat normal de avisos
--   automáticos de recordatorios. Los avisos se muestran en el
--   historial del usuario pero se excluyen del contexto que se
--   envía al LLM, para no confundir a Niko.
--
-- Impacto en código existente:
--   El DEFAULT 'chat' cubre todas las filas existentes y los
--   inserts actuales (niko.js, nikoV2.js, nikoServiceV2.js)
--   sin necesidad de tocarlos. Solo el endpoint nuevo de aviso
--   pasará tipo: 'aviso' explícitamente.
-- ============================================================


-- ── 1. ALTER TABLE ───────────────────────────────────────────

ALTER TABLE niko_conversaciones
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'chat'
    CHECK (tipo IN ('chat', 'aviso'));

COMMENT ON COLUMN niko_conversaciones.tipo IS
  'Tipo de mensaje: "chat" (conversación normal con Niko) o "aviso" (recordatorio automático insertado sin LLM). Default: chat.';


-- ── 2. VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ────────
--
-- Confirma que la columna existe con el tipo y default correctos:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'niko_conversaciones'
--     AND column_name = 'tipo';
--
-- Resultado esperado:
--   column_name | data_type | is_nullable | column_default
--   tipo        | text      | NO          | 'chat'::text
