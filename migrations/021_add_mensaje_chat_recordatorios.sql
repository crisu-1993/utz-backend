-- ============================================================
-- UTZ Finance — Migración 021
-- Agregar columna mensaje_chat a tabla recordatorios
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-05-26
--
-- Qué hace esta migración:
--   Agrega columna mensaje_chat (text, NULLABLE) a la tabla
--   recordatorios. Permite separar dos textos que antes compartían
--   el campo descripcion:
--     - descripcion: nota corta que se muestra en el dashboard.
--     - mensaje_chat: mensaje con tono que Niko envía por chat
--       cuando avisa el recordatorio.
--
-- Impacto: ninguno. Migración aditiva pura.
--   - Los recordatorios existentes quedan con mensaje_chat = NULL.
--   - NULL significa "usar el template genérico de aviso" (sin cambio
--     de comportamiento hasta que el backend lo lea).
--   - Idempotente: usa IF NOT EXISTS.
-- ============================================================

ALTER TABLE recordatorios
  ADD COLUMN IF NOT EXISTS mensaje_chat text;

COMMENT ON COLUMN recordatorios.mensaje_chat IS
  'Mensaje que Niko envía por chat cuando avisa este recordatorio. '
  'NULL = usar el template genérico (recordatorios del usuario). '
  'Con valor = usar ese texto tal cual (ej. recordatorios tributarios).';

-- ── Verificación ────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'recordatorios'
--    AND column_name = 'mensaje_chat';
