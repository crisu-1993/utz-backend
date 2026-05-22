const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authMiddleware } = require('../middleware/auth');
const {
  resolverPeriodo,
  acumularPorCategoria,
  construirSecciones,
  calcularSubtotales,
  serializarSecciones,
  detectarCandidatasRevision,
} = require('../services/eerrCalculator');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// GET /api/estado-resultados/:empresa_id?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/:empresa_id', authMiddleware, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { desde, hasta, mes, anio } = req.query;

    const { fechaDesde, fechaHasta } = resolverPeriodo({ mes, anio, desde, hasta });

    // 1. Obtener categorías de la empresa con sus secciones
    const { data: categorias, error: errCat } = await supabase
      .from('categorias_eerr')
      .select('id, nombre, tipo, seccion_eerr, es_sistema, primera_vez_usada_at, ultimo_movimiento_at')
      .eq('empresa_id', empresa_id)
      .eq('activa', true);

    if (errCat) throw errCat;

    // 2. Obtener TODAS las transacciones del período (con y sin categoria_id)
    const { data: transacciones, error: errTx } = await supabase
      .from('transacciones_historicas')
      .select('monto_original, tipo, categoria_id')
      .eq('empresa_id', empresa_id)
      .gte('fecha_transaccion', fechaDesde)
      .lte('fecha_transaccion', fechaHasta);

    if (errTx) throw errTx;

    // 3–7. Cálculo puro delegado a eerrCalculator
    const { montosPorCategoria, sinCategorizarIngreso, sinCategorizarEgreso } =
      acumularPorCategoria(transacciones);

    const secciones = construirSecciones(
      categorias, montosPorCategoria, sinCategorizarIngreso, sinCategorizarEgreso
    );

    const subtotales   = calcularSubtotales(secciones);
    const seccionesArray = serializarSecciones(secciones);

    // 8. Detectar categorías candidatas a pregunta de Niko
    const candidatasRevision = detectarCandidatasRevision(categorias, montosPorCategoria);

    res.json({
      ok: true,
      empresa_id,
      periodo: {
        desde: fechaDesde,
        hasta: fechaHasta
      },
      eerr: {
        secciones: seccionesArray,
        subtotales
      },
      niko_revision: candidatasRevision
    });

  } catch (err) {
    console.error('EERR error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
