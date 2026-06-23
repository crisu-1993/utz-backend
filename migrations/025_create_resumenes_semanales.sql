-- ============================================================
-- UTZ Finance — Migración 025
-- Crear tabla resumenes_semanales
-- Guarda cada resumen generado (histórico + anti-duplicados)
-- ============================================================

CREATE TABLE IF NOT EXISTS resumenes_semanales (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  empresa_id    uuid        NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  fecha_inicio  date        NOT NULL,
  fecha_fin     date        NOT NULL,
  entraron      bigint      NOT NULL,
  salieron      bigint      NOT NULL,
  resultado     bigint      NOT NULL,
  resultado_anterior  bigint,                       -- null si no hubo semana previa con datos
  mensaje       text        NOT NULL,               -- el texto generado, tal cual se entregó
  canal         text        NOT NULL DEFAULT 'app', -- app | whatsapp (futuro)
  entregado     boolean     NOT NULL DEFAULT false, -- el frontend lo marca al mostrarlo
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resumenes_semanales_empresa_rango_key UNIQUE (empresa_id, fecha_inicio, fecha_fin)
);

CREATE INDEX IF NOT EXISTS idx_resumenes_empresa     ON resumenes_semanales (empresa_id);
CREATE INDEX IF NOT EXISTS idx_resumenes_no_entregado ON resumenes_semanales (empresa_id, entregado);
