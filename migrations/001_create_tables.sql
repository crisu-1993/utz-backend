-- ============================================================
-- UTZ Finance — Migración 001
-- Tablas: transacciones_historicas, importaciones_historicas
-- ============================================================

-- Tabla principal de transacciones procesadas
CREATE TABLE IF NOT EXISTS transacciones_historicas (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id              UUID NOT NULL,
  importacion_id          UUID,
  fecha_transaccion       DATE NOT NULL,
  descripcion_original    TEXT NOT NULL,
  descripcion_normalizada TEXT,
  tipo                    VARCHAR(10) NOT NULL CHECK (tipo IN ('ingreso', 'egreso')),
  monto_original          NUMERIC(15,2) NOT NULL,
  moneda_original         VARCHAR(3) DEFAULT 'CLP',
  categoria_sugerida_ia   VARCHAR(50),
  confianza_deteccion     NUMERIC(4,3),
  estado                  VARCHAR(30) DEFAULT 'pendiente_revision',
  fuente                  VARCHAR(50) DEFAULT 'cartola_banco',
  archivo_origen          TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_tx_empresa    ON transacciones_historicas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_tx_fecha      ON transacciones_historicas(fecha_transaccion);
CREATE INDEX IF NOT EXISTS idx_tx_tipo       ON transacciones_historicas(tipo);
CREATE INDEX IF NOT EXISTS idx_tx_categoria  ON transacciones_historicas(categoria_sugerida_ia);
CREATE INDEX IF NOT EXISTS idx_tx_estado     ON transacciones_historicas(estado);

-- Tabla de control de importaciones
CREATE TABLE IF NOT EXISTS importaciones_historicas (
  id                          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id                  UUID NOT NULL,
  archivo_nombre              TEXT,
  bucket_path                 TEXT,
  estado                      VARCHAR(30) DEFAULT 'pendiente',
  total_transacciones         INTEGER DEFAULT 0,
  total_ingresos              NUMERIC(15,2) DEFAULT 0,
  total_egresos               NUMERIC(15,2) DEFAULT 0,
  error_mensaje               TEXT,
  fecha_inicio_procesamiento  TIMESTAMPTZ,
  fecha_fin_procesamiento     TIMESTAMPTZ,
  tiempo_procesamiento_ms     INTEGER,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imp_empresa ON importaciones_historicas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_imp_estado  ON importaciones_historicas(estado);
