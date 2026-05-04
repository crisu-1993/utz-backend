const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

const {
  calcularRango,
  calcularRangoAnterior,
  calcularRangoMes,
  variacionPct,
  consultarPeriodo,
} = require('../utils/periodos');

// ─── GET /api/resumen/:empresa_id ─────────────────────────────────────────────
router.get('/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;

  let rango, rangoAnt, periodo;

  console.log('[/api/resumen] req:', {
    empresa_id: req.params.empresa_id,
    fecha_inicio: req.query.fecha_inicio,
    fecha_fin: req.query.fecha_fin,
    inicio: req.query.inicio,
    fin: req.query.fin,
    mes: req.query.mes,
    anio: req.query.anio,
    periodo: req.query.periodo,
  });

  if (req.query.fecha_inicio && req.query.fecha_fin) {
    // PRIORIDAD: fechas explícitas → usarlas directamente sin derivar nada
    rango = {
      fecha_inicio: req.query.fecha_inicio,
      fecha_fin:    req.query.fecha_fin,
    };
    // rangoAnt: mismo rango desplazado hacia atrás por la misma duración
    const msInicio = new Date(req.query.fecha_inicio).getTime();
    const msFin    = new Date(req.query.fecha_fin).getTime();
    const durMs    = msFin - msInicio + 86400000; // +1 día (rango inclusivo)
    rangoAnt = {
      fecha_inicio: new Date(msInicio - durMs).toISOString().split('T')[0],
      fecha_fin:    new Date(msFin    - durMs).toISOString().split('T')[0],
    };
    periodo = 'custom';
  } else if (req.query.inicio || req.query.fecha_inicio) {
    // Formato legado: solo fecha de inicio → extraer mes y calcular rango mensual
    const raw   = req.query.inicio || req.query.fecha_inicio;
    const fecha = new Date(raw);
    const mes   = fecha.getMonth() + 1;
    const anio  = fecha.getFullYear();
    rango    = calcularRangoMes(anio, mes);
    rangoAnt = calcularRangoMes(mes === 1 ? anio - 1 : anio, mes === 1 ? 12 : mes - 1);
    periodo  = 'mes';
  } else if (req.query.mes) {
    // Formato 1: ?mes=3&anio=2026 o ?mes=3&año=2026 (anio opcional, default año actual)
    const mes  = parseInt(req.query.mes, 10);
    const anio = parseInt(req.query.anio || req.query.año || new Date().getFullYear(), 10);
    console.log('[RESUMEN] params recibidos:', req.query.mes, req.query.anio, req.query.inicio);
    rango    = calcularRangoMes(anio, mes);
    rangoAnt = calcularRangoMes(mes === 1 ? anio - 1 : anio, mes === 1 ? 12 : mes - 1);
    periodo  = 'mes';
  } else {
    // Formato original: ?periodo=mes|semana|hoy|año (default: mes actual)
    periodo = (req.query.periodo || 'mes').toLowerCase();
    const periodosValidos = ['hoy', 'semana', 'mes', 'año'];
    if (!periodosValidos.includes(periodo)) {
      return res.status(400).json({
        ok: false,
        error: `Período inválido. Use: ${periodosValidos.join(', ')}`,
      });
    }
    console.log('[RESUMEN] params recibidos:', req.query.mes, req.query.anio, req.query.inicio);
    rango    = calcularRango(periodo);
    rangoAnt = calcularRangoAnterior(periodo);
  }

  console.log('[RESUMEN] fechas calculadas:', rango.fecha_inicio, rango.fecha_fin);

  const supabase = getSupabase();

  try {

    // Consultar período actual y anterior en paralelo
    const [txActual, txAnterior] = await Promise.all([
      consultarPeriodo(supabase, empresa_id, rango.fecha_inicio, rango.fecha_fin),
      consultarPeriodo(supabase, empresa_id, rangoAnt.fecha_inicio, rangoAnt.fecha_fin),
    ]);

    // ── Calcular totales actuales ─────────────────────────────────────────────
    let entraron = 0;
    let salieron = 0;
    let mayorIngreso = null;
    const gastosPorCategoria = {};

    for (const t of txActual) {
      const monto = Number(t.monto_original);

      if (t.tipo === 'ingreso') {
        entraron += monto;
        if (!mayorIngreso || monto > mayorIngreso.monto) {
          mayorIngreso = {
            descripcion: t.descripcion_normalizada || t.descripcion_original || '',
            monto,
          };
        }
      } else {
        salieron += monto;
        const cat = t.categoria_sugerida_ia || 'otros_gastos';
        gastosPorCategoria[cat] = (gastosPorCategoria[cat] || 0) + monto;
      }
    }

    // Mayor gasto por categoría
    let mayorGasto = null;
    for (const [cat, monto] of Object.entries(gastosPorCategoria)) {
      if (!mayorGasto || monto > mayorGasto.monto) {
        mayorGasto = { categoria: cat, monto: Math.round(monto) };
      }
    }

    // Facturas pendientes (ingresos en estado pendiente_revision)
    const pendientes = txActual.filter(
      t => t.tipo === 'ingreso' && t.estado === 'pendiente_revision'
    );
    const montoPendiente = pendientes.reduce((s, t) => s + Number(t.monto_original), 0);

    // ── Calcular totales del período anterior ─────────────────────────────────
    let entroAnt = 0;
    let salioAnt = 0;
    for (const t of txAnterior) {
      if (t.tipo === 'ingreso') entroAnt += Number(t.monto_original);
      else                      salioAnt += Number(t.monto_original);
    }

    const resultado    = entraron - salieron;
    const resultadoAnt = entroAnt - salioAnt;

    return res.json({
      ok: true,
      empresa_id,
      periodo,
      fecha_inicio:         rango.fecha_inicio,
      fecha_fin:            rango.fecha_fin,
      entraron:             Math.round(entraron),
      salieron:             Math.round(salieron),
      resultado:            Math.round(resultado),
      resultado_positivo:   resultado >= 0,
      mayor_ingreso:        mayorIngreso
        ? { descripcion: mayorIngreso.descripcion, monto: Math.round(mayorIngreso.monto) }
        : null,
      mayor_gasto:          mayorGasto,
      pendientes: {
        facturas_sin_cobrar: pendientes.length,
        monto_pendiente:     Math.round(montoPendiente),
      },
      comparacion_periodo_anterior: {
        entraron_variacion_pct:   variacionPct(entraron, entroAnt),
        salieron_variacion_pct:   variacionPct(salieron, salioAnt),
        resultado_variacion_pct:  variacionPct(resultado, resultadoAnt),
      },
    });

  } catch (err) {
    console.error('[resumen] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
