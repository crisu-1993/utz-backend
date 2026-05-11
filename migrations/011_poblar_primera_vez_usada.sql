-- Migración 011: poblar primera_vez_usada_at para
-- categorías que ya tienen transacciones asignadas
UPDATE categorias_eerr c
SET
  primera_vez_usada_at = sub.primera_tx,
  ultimo_movimiento_at = sub.ultima_tx
FROM (
  SELECT
    categoria_id,
    MIN(fecha_transaccion) AS primera_tx,
    MAX(fecha_transaccion) AS ultima_tx
  FROM transacciones_historicas
  WHERE categoria_id IS NOT NULL
  GROUP BY categoria_id
) sub
WHERE c.id = sub.categoria_id;

-- Verificación
SELECT nombre, primera_vez_usada_at, ultimo_movimiento_at
FROM categorias_eerr
WHERE empresa_id = '1c749792-3add-4cb5-929f-9bd5837bf1f5'
AND primera_vez_usada_at IS NOT NULL
ORDER BY nombre;
