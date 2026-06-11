const express = require('express');
const {
  getSupabase,
  calcularMetricas,
  calcularScoreNormalizado,
  estadoScore,
} = require('../services/scoreCalculator');

const router = express.Router();

// ─── GET /api/score/:empresa_id ───────────────────────────────────────────────
router.get('/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;

  const hoy  = new Date();
  let mes, año;

  if (req.query.inicio) {
    // Formato 2: ?inicio=2026-03-01&fin=2026-03-31
    const fecha = new Date(req.query.inicio);
    mes = fecha.getMonth() + 1;
    año = fecha.getFullYear();
  } else {
    // Formato 1: ?mes=3&anio=2026 o ?mes=3&año=2026, o defaults
    mes = parseInt(req.query.mes  || (hoy.getMonth() + 1), 10);
    año = parseInt(req.query.año  || req.query.anio || hoy.getFullYear(), 10);
  }

  if (isNaN(mes) || mes < 1 || mes > 12) {
    return res.status(400).json({ ok: false, error: 'Parámetro mes inválido (1–12)' });
  }
  if (isNaN(año) || año < 2000 || año > 2100) {
    return res.status(400).json({ ok: false, error: 'Parámetro año inválido' });
  }

  const supabase = getSupabase();

  try {
    // Calcular métricas del mes pedido y del mes anterior en paralelo
    const mesAnterior = mes === 1 ? 12 : mes - 1;
    const añoAnterior = mes === 1 ? año - 1 : año;

    const [metricas, metricasAnt] = await Promise.all([
      calcularMetricas(supabase, empresa_id, año, mes),
      calcularMetricas(supabase, empresa_id, añoAnterior, mesAnterior),
    ]);

    // ── Score normalizado ─────────────────────────────────────────────────────
    const {
      ptLiquidez, ptMargen, ptDiasCaja, ptEndeudamiento, ptControl,
      nDisponibles, score,
      dispLiquidez, dispMargen, dispDiasCaja, dispEndeudamiento, dispControl,
    } = calcularScoreNormalizado(metricas);

    const { score: scoreAnt } = calcularScoreNormalizado(metricasAnt);

    // ── Estado / color ────────────────────────────────────────────────────────
    const { estado, color } = score !== null
      ? estadoScore(score)
      : { estado: 'sin_datos', color: '#9CA3AF' };

    return res.json({
      ok: true,
      empresa_id,
      mes,
      año,
      score,
      estado,
      color,
      indicadores_disponibles: nDisponibles,
      indicadores_totales: 5,
      detalle: {
        liquidez:      { valor: metricas.liquidez,          puntos: ptLiquidez,      disponible: dispLiquidez,      peso: 1 },
        margen:        { valor: metricas.margen,            puntos: ptMargen,        disponible: dispMargen,        peso: 1 },
        dias_caja:     { valor: metricas.dias_caja,         puntos: ptDiasCaja,      disponible: dispDiasCaja,      peso: 1 },
        endeudamiento: { valor: metricas.endeudamiento,     puntos: ptEndeudamiento, disponible: dispEndeudamiento, peso: 1 },
        control:       { valor: metricas.pct_categorizado,  puntos: ptControl,       disponible: dispControl,       peso: 2 },
        dias_cobro:    { valor: metricas.dias_cobro,        puntos: 0,               disponible: false,             peso: 0 },
      },
      variacion_vs_mes_anterior: score !== null && scoreAnt !== null ? score - scoreAnt : null,
    });

  } catch (err) {
    console.error('[score] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
