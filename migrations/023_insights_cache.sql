-- ============================================================
-- UTZ Finance -- Migracion 023
-- Crear tabla insights_cache
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
-- Fecha: 2026-06-01
--
-- Que hace esta migracion:
--   Crea la tabla insights_cache para almacenar los insights y
--   recomendaciones generados por IA (o por fallback deterministico)
--   para cada empresa y mes. Una sola fila por (empresa, mes, anio).
--
-- Por que:
--   Los insights con IA son costosos (llamada a Claude por cada
--   periodo). Para meses cerrados el resultado no cambia, asi que
--   se cachea. El boton "Regenerar" del frontend borra la fila
--   y fuerza una nueva generacion.
--
-- Idempotente:
--   Si. CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--   Seguro de ejecutar multiples veces.
--
-- Impacto en codigo existente:
--   Ninguno. La tabla es nueva y no afecta tablas ni endpoints
--   existentes. El endpoint GET /api/insights/:empresa_id leera
--   de esta tabla como cache antes de generar insights frescos.
-- ============================================================


-- -- 1. CREATE TABLE ----------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_cache (
  id                uuid           DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id        uuid           NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  mes               smallint       NOT NULL CHECK (mes BETWEEN 1 AND 12),
  anio              smallint       NOT NULL CHECK (anio BETWEEN 2020 AND 2100),
  tipo              text           NOT NULL CHECK (tipo IN ('ia', 'deterministico')),
  insights          jsonb          NOT NULL,
  recomendaciones   jsonb          NOT NULL,
  metricas          jsonb          NOT NULL,
  comparacion       jsonb,
  modelo_usado      text,
  tokens_input      integer,
  tokens_output     integer,
  latencia_ms       integer,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT insights_cache_empresa_mes_anio_key UNIQUE (empresa_id, mes, anio)
);

COMMENT ON TABLE insights_cache IS
  'Cache de insights y recomendaciones generados por IA o fallback deterministico. Una fila por (empresa, mes, anio). El boton Regenerar borra la fila para forzar re-generacion.';


-- -- 2. INDICES ---------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_insights_cache_empresa_id
  ON insights_cache (empresa_id);


-- -- 3. VERIFICACION POST-MIGRACION (ejecutar despues) ------------------------
--
-- Confirmar que la tabla existe con las columnas correctas:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'insights_cache'
--   ORDER BY ordinal_position;
--
-- Resultado esperado (15 columnas):
--   id              | uuid                        | NO  | gen_random_uuid()
--   empresa_id      | uuid                        | NO  |
--   mes             | smallint                    | NO  |
--   anio            | smallint                    | NO  |
--   tipo            | text                        | NO  |
--   insights        | jsonb                       | NO  |
--   recomendaciones | jsonb                       | NO  |
--   metricas        | jsonb                       | NO  |
--   comparacion     | jsonb                       | YES |
--   modelo_usado    | text                        | YES |
--   tokens_input    | integer                     | YES |
--   tokens_output   | integer                     | YES |
--   latencia_ms     | integer                     | YES |
--   created_at      | timestamp with time zone    | NO  | now()
--   updated_at      | timestamp with time zone    | NO  | now()
--
-- Confirmar UNIQUE constraint:
--
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'insights_cache'
--     AND indexname = 'insights_cache_empresa_mes_anio_key';
--
-- Resultado esperado:
--   insights_cache_empresa_mes_anio_key | CREATE UNIQUE INDEX ... ON insights_cache (empresa_id, mes, anio)
