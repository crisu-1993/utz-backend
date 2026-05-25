-- ============================================================
-- UTZ Finance — Migración 017
-- Crear tabla feriados (feriados chilenos, global)
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Crea la tabla `feriados` para almacenar feriados chilenos.
--      Es una tabla GLOBAL (sin empresa_id) porque los feriados
--      son iguales para todas las empresas.
--   2. Crea índices para búsqueda por fecha, por año, y un
--      unique compuesto (fecha, nombre) para evitar duplicados
--      pero permitir más de un feriado en la misma fecha
--      (ej. futuros regionales).
--
-- Por qué:
--   Los recordatorios tributarios necesitan saber si una fecha
--   de vencimiento cae en feriado para ajustarla al día hábil
--   siguiente. También se usará para un futuro aviso de
--   "semana corta" en el dashboard.
--
-- Impacto en código existente:
--   Ninguno. Es una tabla nueva sin dependencias. Los servicios
--   que la consulten se agregarán después.
-- ============================================================


-- ── 1. CREATE TABLE ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feriados (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha         date        NOT NULL,
  nombre        text        NOT NULL,
  tipo          text        NOT NULL DEFAULT 'nacional',
  irrenunciable boolean     NOT NULL DEFAULT false,
  anio          smallint    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE feriados IS
  'Feriados chilenos (nacionales y regionales). Tabla global, no vinculada a empresa.';


-- ── 2. ÍNDICES ──────────────────────────────────────────────

-- Unique compuesto: permite más de un feriado en la misma fecha
-- (ej. nacional + regional) pero no duplicados exactos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feriados_fecha_nombre
  ON feriados (fecha, nombre);

-- Búsqueda por año completo (cargar todos los feriados de un año)
CREATE INDEX IF NOT EXISTS idx_feriados_anio
  ON feriados (anio);

-- Búsqueda por rango de fechas (ej. "feriados entre hoy y fin de mes")
CREATE INDEX IF NOT EXISTS idx_feriados_fecha
  ON feriados (fecha);


-- ── 3. RLS (deshabilitado por ahora) ────────────────────────
--
-- Esta tabla contiene data pública (feriados chilenos), sin
-- información sensible. No se habilita RLS por ahora.
-- Si se quiere restringir a usuarios autenticados en el futuro:
--
--   ALTER TABLE feriados ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "Authenticated users can read feriados"
--     ON feriados FOR SELECT
--     USING (auth.role() = 'authenticated');


-- ── 4. VERIFICACIÓN POST-MIGRACIÓN ─────────────────────────
--
-- Confirmar que la tabla existe:
--
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'feriados'
--   ORDER BY ordinal_position;
