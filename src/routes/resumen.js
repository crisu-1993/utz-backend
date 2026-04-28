const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Calcular rango de fechas según período ───────────────────────────────────
function calcularRango(periodo) {
  const hoy = new Date();
  const año  = hoy.getFullYear();
  const mes  = hoy.getMonth(); // 0-indexed
  const dia  = hoy.getDate();

  let inicio, fin;

  switch (periodo) {
    case 'hoy':
      inicio = new Date(año, mes, dia, 0, 0, 0);
      fin    = new Date(año, mes, dia, 23, 59, 59);
      break;

    case 'semana': {
      // Lunes de la semana actual
      const dow = hoy.getDay(); // 0=dom, 1=lun...
      const diffLunes = (dow === 0) ? -6 : 1 - dow;
      inicio = new Date(año, mes, dia + diffLunes, 0, 0, 0);
      fin    = new Date(año, mes, dia + diffLunes + 6, 23, 59, 59);
      break;
    }

    case 'año':
      inicio = new Date(año, 0, 1);
      fin    = new Date(año, 11, 31, 23, 59, 59);
      break;

    case 'mes':
    default:
      inicio = new Date(año, mes, 1);
      fin    = new Date(año, mes + 1, 0, 23, 59, 59); // último día del mes
      break;
  }

  return {
    fecha_inicio: inicio.toISOString().split('T')[0],
    fecha_fin:    fin.toISOString().split('T')[0],
  };
}

// ─── Calcular rango del período anterior ─────────────────────────────────────
function calcularRangoAnterior(periodo) {
  const hoy = new Date();
  const año  = hoy.getFullYear();
  const mes  = hoy.getMonth();
  const dia  = hoy.getDate();

  let inicio, fin;

  switch (periodo) {
    case 'hoy': {
      const ayer = new Date(año, mes, dia - 1);
      inicio = new Date(ayer.getFullYear(), ayer.getMonth(), ayer.getDate(), 0, 0, 0);
      fin    = new Date(ayer.getFullYear(), ayer.getMonth(), ayer.getDate(), 23, 59, 59);
      break;
    }

    case 'semana': {
      const dow = hoy.getDay();
      const diffLunes = (dow === 0) ? -6 : 1 - dow;
      // semana anterior: lunes - 7 a domingo - 7
      inicio = new Date(año, mes, dia + diffLunes - 7, 0, 0, 0);
      fin    = new Date(año, mes, dia + diffLunes - 1, 23, 59, 59);
      break;
    }

    case 'año':
      inicio = new Date(año - 1, 0, 1);
      fin    = new Date(año - 1, 11, 31, 23, 59, 59);
      break;

    case 'mes':
    default:
      inicio = new Date(año, mes - 1, 1);
      fin    = new Date(año, mes, 0, 23, 59, 59); // último día del mes anterior
      break;
  }

  return {
    fecha_inicio: inicio.toISOString().split('T')[0],
    fecha_fin:    fin.toISOString().split('T')[0],
  };
}

// ─── Calcular rango exacto de un mes específico ───────────────────────────────
function calcularRangoMes(anio, mes) {
  const ultimoDia = new Date(anio, mes, 0).getDate();
  return {
    fecha_inicio: `${anio}-${String(mes).padStart(2, '0')}-01`,
    fecha_fin:    `${anio}-${String(mes).padStart(2, '0')}-${ultimoDia}`,
  };
}

// ─── Calcular variación % entre dos valores ───────────────────────────────────
function variacionPct(actual, anterior) {
  if (anterior === 0) return actual > 0 ? 100 : 0;
  return Math.round(((actual - anterior) / Math.abs(anterior)) * 100);
}

// ─── Consultar totales de un período ─────────────────────────────────────────
async function consultarPeriodo(supabase, empresa_id, fecha_inicio, fecha_fin) {
  const { data, error } = await supabase
    .from('transacciones_historicas')
    .select('tipo, monto_original, descripcion_normalizada, descripcion_original, categoria_sugerida_ia, estado')
    .eq('empresa_id', empresa_id)
    .gte('fecha_transaccion', fecha_inicio)
    .lte('fecha_transaccion', fecha_fin);

  if (error) throw new Error(error.message);
  return data || [];
}

// ─── GET /api/resumen/:empresa_id ─────────────────────────────────────────────
router.get('/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;

  let rango, rangoAnt, periodo;

  if (req.query.inicio) {
    // Formato 2: ?inicio=2026-03-01&fin=2026-03-31
    const fecha = new Date(req.query.inicio);
    const mes   = fecha.getMonth() + 1;
    const anio  = fecha.getFullYear();
    rango    = calcularRangoMes(anio, mes);
    rangoAnt = calcularRangoMes(mes === 1 ? anio - 1 : anio, mes === 1 ? 12 : mes - 1);
    periodo  = 'mes';
  } else if (req.query.mes && (req.query.anio || req.query.año)) {
    // Formato 1: ?mes=3&anio=2026 o ?mes=3&año=2026
    const mes  = parseInt(req.query.mes, 10);
    const anio = parseInt(req.query.anio || req.query.año, 10);
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
    rango    = calcularRango(periodo);
    rangoAnt = calcularRangoAnterior(periodo);
  }

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
