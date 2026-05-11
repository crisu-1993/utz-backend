-- Migración 008: seccion_eerr + visibilidad inteligente
-- Agrega jerarquía contable a categorias_eerr

-- 1. Agregar campo seccion_eerr
ALTER TABLE categorias_eerr
ADD COLUMN IF NOT EXISTS seccion_eerr text
CHECK (seccion_eerr IN (
  'ingreso_principal',
  'ingreso_secundario',
  'costo_directo',
  'gasto_operacional',
  'gasto_marketing',
  'gasto_financiero',
  'otros_egresos'
));

-- 2. Agregar campos de visibilidad inteligente
ALTER TABLE categorias_eerr
ADD COLUMN IF NOT EXISTS primera_vez_usada_at timestamptz,
ADD COLUMN IF NOT EXISTS ultimo_movimiento_at timestamptz;

-- 3. Mapear las 12 categorías base a su seccion_eerr
UPDATE categorias_eerr SET seccion_eerr = 'ingreso_principal'
WHERE nombre = 'Ventas' AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'ingreso_secundario'
WHERE nombre = 'Otros ingresos' AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'costo_directo'
WHERE nombre = 'Costo Directo' AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'gasto_operacional'
WHERE nombre IN (
  'Sueldos y honorarios',
  'Servicios básicos',
  'Arriendo',
  'Operacional'
) AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'gasto_marketing'
WHERE nombre = 'Marketing' AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'gasto_financiero'
WHERE nombre IN ('Impuestos', 'Financieros')
AND es_sistema = true;

UPDATE categorias_eerr SET seccion_eerr = 'otros_egresos'
WHERE nombre IN ('Inversión', 'Otros')
AND es_sistema = true;

-- 4. Actualizar función seed para nuevas empresas
CREATE OR REPLACE FUNCTION sembrar_categorias_base(p_empresa_id uuid)
RETURNS void AS $$
BEGIN
  INSERT INTO categorias_eerr
    (empresa_id, nombre, tipo, es_sistema, seccion_eerr)
  VALUES
    (p_empresa_id, 'Ventas',               'ingreso', true, 'ingreso_principal'),
    (p_empresa_id, 'Otros ingresos',        'ingreso', true, 'ingreso_secundario'),
    (p_empresa_id, 'Costo Directo',         'egreso',  true, 'costo_directo'),
    (p_empresa_id, 'Sueldos y honorarios',  'egreso',  true, 'gasto_operacional'),
    (p_empresa_id, 'Servicios básicos',     'egreso',  true, 'gasto_operacional'),
    (p_empresa_id, 'Arriendo',              'egreso',  true, 'gasto_operacional'),
    (p_empresa_id, 'Marketing',             'egreso',  true, 'gasto_marketing'),
    (p_empresa_id, 'Operacional',           'egreso',  true, 'gasto_operacional'),
    (p_empresa_id, 'Impuestos',             'egreso',  true, 'gasto_financiero'),
    (p_empresa_id, 'Inversión',             'egreso',  true, 'otros_egresos'),
    (p_empresa_id, 'Financieros',           'egreso',  true, 'gasto_financiero'),
    (p_empresa_id, 'Otros',                 'egreso',  true, 'otros_egresos')
  ON CONFLICT (empresa_id, nombre, tipo) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
