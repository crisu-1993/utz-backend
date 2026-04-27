-- ============================================================
-- UTZ Finance — Migración 002
-- Agrega columnas numero_documento y saldo_posterior
-- a transacciones_historicas
-- ============================================================

ALTER TABLE transacciones_historicas
  ADD COLUMN IF NOT EXISTS numero_documento TEXT,
  ADD COLUMN IF NOT EXISTS saldo_posterior  NUMERIC(15,2);

COMMENT ON COLUMN transacciones_historicas.numero_documento IS
  'Identificador interno del documento (Docto., N° Doc, Nro., etc.). No es un monto.';

COMMENT ON COLUMN transacciones_historicas.saldo_posterior IS
  'Saldo de la cuenta después de aplicado el movimiento.';
