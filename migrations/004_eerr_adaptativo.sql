-- ============================================================
-- UTZ Finance — Migración 004
-- EERR Adaptativo: categorías por empresa + reglas + RLS
-- ============================================================
--
-- Ejecutar en: Supabase SQL Editor (como owner del schema)
--
-- Qué hace esta migración:
--   1. Crea tabla categorias_eerr (catálogo por empresa)
--   2. Crea tabla reglas_categorizacion (patrones texto→categoría)
--   3. Habilita RLS en ambas tablas con policies patrón EXISTS
--   4. Crea función SECURITY DEFINER + trigger para sembrar
--      categorías base automáticamente en cada empresa nueva
--   5. ALTER transacciones_historicas: agrega categoria_id (FK)
--      categoria_sugerida_ia NO se modifica ni elimina
--   6. Siembra las 12 categorías base en empresa de prueba
--      (1c749792-3add-4cb5-929f-9bd5837bf1f5)
-- ============================================================


-- ── 1. TABLA categorias_eerr ─────────────────────────────────

CREATE TABLE IF NOT EXISTS categorias_eerr (
  id          uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id  uuid    NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nombre      text    NOT NULL,
  tipo        text    NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  es_sistema  boolean DEFAULT false,
  activa      boolean DEFAULT true,
  orden       integer DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_categorias_eerr_nombre
  ON categorias_eerr(empresa_id, nombre, tipo);

CREATE INDEX IF NOT EXISTS idx_categorias_eerr_empresa
  ON categorias_eerr(empresa_id);

CREATE INDEX IF NOT EXISTS idx_categorias_eerr_tipo
  ON categorias_eerr(empresa_id, tipo);

COMMENT ON TABLE categorias_eerr IS
  'Catálogo de categorías EERR por empresa. es_sistema=true son las categorías base UTZ, no borrables por el usuario.';

COMMENT ON COLUMN categorias_eerr.es_sistema IS
  'true = categoría base UTZ. No puede ser eliminada por el usuario.';


-- ── 2. TABLA reglas_categorizacion ──────────────────────────

CREATE TABLE IF NOT EXISTS reglas_categorizacion (
  id            uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id    uuid    NOT NULL REFERENCES empresas(id)        ON DELETE CASCADE,
  categoria_id  uuid    NOT NULL REFERENCES categorias_eerr(id) ON DELETE CASCADE,
  patron        text    NOT NULL,
  tipo_patron   text    DEFAULT 'contiene'
                  CHECK (tipo_patron IN ('contiene', 'empieza_con', 'exacto')),
  activa        boolean DEFAULT true,
  creada_por    text    DEFAULT 'usuario'
                  CHECK (creada_por IN ('usuario', 'niko')),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reglas_empresa
  ON reglas_categorizacion(empresa_id);

CREATE INDEX IF NOT EXISTS idx_reglas_categoria
  ON reglas_categorizacion(categoria_id);

CREATE INDEX IF NOT EXISTS idx_reglas_activa
  ON reglas_categorizacion(empresa_id, activa);

COMMENT ON TABLE reglas_categorizacion IS
  'Reglas patrón→categoría por empresa. Aprende de confirmaciones del usuario y sugerencias de Niko.';

COMMENT ON COLUMN reglas_categorizacion.patron IS
  'Texto a buscar en descripcion_normalizada. Ej: "copec", "redcompra mall".';

COMMENT ON COLUMN reglas_categorizacion.tipo_patron IS
  'contiene: substr match | empieza_con: prefix match | exacto: igualdad estricta.';


-- ── 3. ALTER transacciones_historicas ───────────────────────
--
-- categoria_sugerida_ia NO se modifica ni elimina.
-- El código existente que la lee sigue funcionando sin cambios.
-- categoria_id es la nueva fuente de verdad para EERR Adaptativo.

ALTER TABLE transacciones_historicas
  ADD COLUMN IF NOT EXISTS categoria_id uuid
    REFERENCES categorias_eerr(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tx_categoria_id
  ON transacciones_historicas(categoria_id);

COMMENT ON COLUMN transacciones_historicas.categoria_id IS
  'FK a categorias_eerr. Fuente de verdad para EERR Adaptativo. Convive con categoria_sugerida_ia (no se elimina).';


-- ── 4. ENABLE ROW LEVEL SECURITY ────────────────────────────

ALTER TABLE categorias_eerr       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reglas_categorizacion ENABLE ROW LEVEL SECURITY;


-- ── 5. RLS POLICIES — categorias_eerr ───────────────────────

CREATE POLICY "Owners can view their categorias"
  ON categorias_eerr
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = categorias_eerr.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can insert their categorias"
  ON categorias_eerr
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = categorias_eerr.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can update their categorias"
  ON categorias_eerr
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = categorias_eerr.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can delete their categorias"
  ON categorias_eerr
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = categorias_eerr.empresa_id
        AND e.owner_id = auth.uid()
    )
  );


-- ── 6. RLS POLICIES — reglas_categorizacion ─────────────────

CREATE POLICY "Owners can view their reglas"
  ON reglas_categorizacion
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = reglas_categorizacion.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can insert their reglas"
  ON reglas_categorizacion
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = reglas_categorizacion.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can update their reglas"
  ON reglas_categorizacion
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = reglas_categorizacion.empresa_id
        AND e.owner_id = auth.uid()
    )
  );

CREATE POLICY "Owners can delete their reglas"
  ON reglas_categorizacion
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM empresas e
      WHERE e.id = reglas_categorizacion.empresa_id
        AND e.owner_id = auth.uid()
    )
  );


-- ── 7. FUNCIÓN SEED con SECURITY DEFINER ────────────────────
--
-- SECURITY DEFINER: la función se ejecuta con los permisos
-- del owner del schema (postgres), no del usuario que dispara
-- el trigger. Necesario porque cuando se crea la empresa,
-- la RLS aún no puede validar auth.uid() como owner
-- (el INSERT de la empresa y el trigger son la misma tx).
--
-- SET search_path = public: buena práctica de seguridad para
-- evitar ataques de search_path con SECURITY DEFINER.

CREATE OR REPLACE FUNCTION fn_sembrar_categorias_base()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO categorias_eerr
    (empresa_id, nombre, tipo, es_sistema, activa, orden)
  VALUES
    -- INGRESOS
    (NEW.id, 'Ventas',               'ingreso', true, true,  1),
    (NEW.id, 'Otros ingresos',       'ingreso', true, true,  2),
    -- EGRESOS
    (NEW.id, 'Costo Directo',        'egreso',  true, true,  3),
    (NEW.id, 'Sueldos y honorarios', 'egreso',  true, true,  4),
    (NEW.id, 'Servicios básicos',    'egreso',  true, true,  5),
    (NEW.id, 'Arriendo',             'egreso',  true, true,  6),
    (NEW.id, 'Marketing',            'egreso',  true, true,  7),
    (NEW.id, 'Operacional',          'egreso',  true, true,  8),
    (NEW.id, 'Impuestos',            'egreso',  true, true,  9),
    (NEW.id, 'Inversión',            'egreso',  true, true, 10),
    (NEW.id, 'Financieros',          'egreso',  true, true, 11),
    (NEW.id, 'Otros',                'egreso',  true, true, 12)
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;


-- ── 8. TRIGGER ───────────────────────────────────────────────

CREATE OR REPLACE TRIGGER trg_sembrar_categorias_base
  AFTER INSERT ON empresas
  FOR EACH ROW
  EXECUTE FUNCTION fn_sembrar_categorias_base();


-- ── 9. SEED empresa de prueba ────────────────────────────────
--
-- Empresa: dfhdg (1c749792-3add-4cb5-929f-9bd5837bf1f5)
--
-- El trigger solo aplica a INSERTs futuros en empresas.
-- Este INSERT manual siembra las categorías de la empresa
-- de prueba ya existente.
--
-- NOTA RLS: Este bloque se ejecuta desde el SQL Editor de
-- Supabase como owner del schema (postgres), que bypasea RLS
-- automáticamente. No requiere ningún ajuste adicional.

INSERT INTO categorias_eerr
  (empresa_id, nombre, tipo, es_sistema, activa, orden)
VALUES
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Ventas',               'ingreso', true, true,  1),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Otros ingresos',       'ingreso', true, true,  2),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Costo Directo',        'egreso',  true, true,  3),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Sueldos y honorarios', 'egreso',  true, true,  4),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Servicios básicos',    'egreso',  true, true,  5),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Arriendo',             'egreso',  true, true,  6),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Marketing',            'egreso',  true, true,  7),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Operacional',          'egreso',  true, true,  8),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Impuestos',            'egreso',  true, true,  9),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Inversión',            'egreso',  true, true, 10),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Financieros',          'egreso',  true, true, 11),
  ('1c749792-3add-4cb5-929f-9bd5837bf1f5', 'Otros',                'egreso',  true, true, 12)
ON CONFLICT DO NOTHING;


-- ── 10. VERIFICACIÓN POST-MIGRACIÓN (ejecutar después) ───────
--
-- Categorías sembradas en empresa de prueba:
--
--   SELECT tipo, nombre, orden, es_sistema
--   FROM categorias_eerr
--   WHERE empresa_id = '1c749792-3add-4cb5-929f-9bd5837bf1f5'
--   ORDER BY orden;
--
-- Columnas en transacciones_historicas (ambas deben aparecer):
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'transacciones_historicas'
--     AND column_name IN ('categoria_sugerida_ia', 'categoria_id');
--
-- RLS habilitado en las nuevas tablas:
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('categorias_eerr', 'reglas_categorizacion');
--
-- Trigger registrado:
--
--   SELECT trigger_name, event_object_table
--   FROM information_schema.triggers
--   WHERE trigger_name = 'trg_sembrar_categorias_base';
