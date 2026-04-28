const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Tabla de scoring ─────────────────────────────────────────────────────────
//
//  Indicador       | >umbral_alto → 20pts | entre → 10pts  | <umbral_bajo → 0pts
//  liquidez        | >1.5               | 1–1.5          | <1
//  margen          | >20%               | 10–20%         | <10%
//  dias_caja       | >30                | 15–30          | <15
//  dias_cobro      | <30                | 30–60          | >60
//  endeudamiento   | <30%               | 30–60%         | >60%

function puntosLiquidez(v) {
  if (v > 1.5) return 20;
  if (v >= 1)  return 10;
  return 0;
}

function puntosMargen(v) {
  if (v > 20) return 20;
  if (v >= 10) return 10;
  return 0;
}

function puntosDiasCaja(v) {
  if (v > 30) return 20;
  if (v >= 15) return 10;
  return 0;
}

function puntosDiasCobro(v) {
  if (v < 30) return 20;
  if (v <= 60) return 10;
  return 0;
}

function puntosEndeudamiento(v) {
  if (v < 30) return 20;
  if (v <= 60) return 10;
  return 0;
}

// ─── Texto de estado según score ──────────────────────────────────────────────
function estadoScore(score) {
  if (score >= 80) return { estado: 'Excelente',          color: 'green'  };
  if (score >= 60) return { estado: 'Requiere atención',  color: 'amber'  };
  if (score >= 40) return { estado: 'En riesgo',          color: 'orange' };
  return             { estado: 'Crítico',               color: 'red'    };
}

// ─── Calcular métricas para un mes ───────────────────────────────────────────
async function calcularMetricas(supabase, empresa_id, año, mes) {
  const desde = `${año}-${String(mes).padStart(2, '0')}-01`;
  const ultimoDia = new Date(año, mes, 0).getDate();
  const hasta = `${año}-${String(mes).padStart(2, '0')}-${ultimoDia}`;

  // Transacciones del mes
  const { data: txMes, error: errMes } = await supabase
    .from('transacciones_historicas')
    .select('tipo, monto_original, categoria_sugerida_ia, estado, fecha_transaccion')
    .eq('empresa_id', empresa_id)
    .gte('fecha_transaccion', desde)
    .lte('fecha_transaccion', hasta);

  if (errMes) throw new Error(errMes.message);

  // Todas las transacciones históricas hasta el fin del mes (para saldo acumulado)
  const { data: txHistorico, error: errHist } = await supabase
    .from('transacciones_historicas')
    .select('tipo, monto_original')
    .eq('empresa_id', empresa_id)
    .lte('fecha_transaccion', hasta);

  if (errHist) throw new Error(errHist.message);

  const txMesArr   = txMes      || [];
  const txHistArr  = txHistorico || [];

  // ── Totales del mes ───────────────────────────────────────────────────────
  let ingresosMes = 0;
  let egresosMes  = 0;
  let gastosFinancMes = 0;
  let ingresosPendientes = 0;

  for (const t of txMesArr) {
    const monto = Number(t.monto_original);
    if (t.tipo === 'ingreso') {
      ingresosMes += monto;
      if (t.estado === 'pendiente_revision') ingresosPendientes += monto;
    } else {
      egresosMes += monto;
      if (t.categoria_sugerida_ia === 'gastos_financieros') {
        gastosFinancMes += monto;
      }
    }
  }

  // ── Saldo acumulado histórico ─────────────────────────────────────────────
  let saldoHistorico = 0;
  for (const t of txHistArr) {
    const monto = Number(t.monto_original);
    saldoHistorico += t.tipo === 'ingreso' ? monto : -monto;
  }

  // ── Calcular indicadores ──────────────────────────────────────────────────

  // 1. Liquidez: ingresos / egresos del mes
  const liquidez = egresosMes > 0
    ? Math.round((ingresosMes / egresosMes) * 100) / 100
    : ingresosMes > 0 ? 9.99 : 0;

  // 2. Margen neto: (ingresos - egresos) / ingresos * 100
  const margen = ingresosMes > 0
    ? Math.round(((ingresosMes - egresosMes) / ingresosMes) * 10000) / 100
    : 0;

  // 3. Días caja: saldo_acumulado / (egresos_mes / 30)
  //    Cuántos días de gastos puede cubrir el saldo disponible
  const egresosDiarios = egresosMes / 30;
  const diasCaja = egresosDiarios > 0
    ? Math.round(Math.max(0, saldoHistorico) / egresosDiarios)
    : saldoHistorico > 0 ? 999 : 0;

  // 4. Días cobro: ingresos pendientes como % de ingresos mensuales × 30 días
  //    Aproxima cuántos días tarda en cobrarse
  const diasCobro = ingresosMes > 0
    ? Math.round((ingresosPendientes / ingresosMes) * 30)
    : 0;

  // 5. Endeudamiento: gastos financieros / ingresos * 100
  const endeudamiento = ingresosMes > 0
    ? Math.round((gastosFinancMes / ingresosMes) * 10000) / 100
    : 0;

  return {
    liquidez:      Math.round(liquidez * 100) / 100,
    margen:        Math.round(margen * 100) / 100,
    dias_caja:     Math.min(diasCaja, 999),
    dias_cobro:    diasCobro,
    endeudamiento: Math.round(endeudamiento * 100) / 100,
  };
}

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

    // ── Calcular puntos ───────────────────────────────────────────────────────
    const ptLiquidez     = puntosLiquidez(metricas.liquidez);
    const ptMargen       = puntosMargen(metricas.margen);
    const ptDiasCaja     = puntosDiasCaja(metricas.dias_caja);
    const ptDiasCobro    = puntosDiasCobro(metricas.dias_cobro);
    const ptEndeudamiento = puntosEndeudamiento(metricas.endeudamiento);

    const score = ptLiquidez + ptMargen + ptDiasCaja + ptDiasCobro + ptEndeudamiento;

    // Score del mes anterior
    const scoreAnt =
      puntosLiquidez(metricasAnt.liquidez) +
      puntosMargen(metricasAnt.margen) +
      puntosDiasCaja(metricasAnt.dias_caja) +
      puntosDiasCobro(metricasAnt.dias_cobro) +
      puntosEndeudamiento(metricasAnt.endeudamiento);

    const { estado, color } = estadoScore(score);

    return res.json({
      ok: true,
      empresa_id,
      mes,
      año,
      score,
      estado,
      color,
      detalle: {
        liquidez:      { valor: metricas.liquidez,      puntos: ptLiquidez     },
        margen:        { valor: metricas.margen,        puntos: ptMargen       },
        dias_caja:     { valor: metricas.dias_caja,     puntos: ptDiasCaja     },
        dias_cobro:    { valor: metricas.dias_cobro,    puntos: ptDiasCobro    },
        endeudamiento: { valor: metricas.endeudamiento, puntos: ptEndeudamiento },
      },
      variacion_vs_mes_anterior: score - scoreAnt,
    });

  } catch (err) {
    console.error('[score] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
