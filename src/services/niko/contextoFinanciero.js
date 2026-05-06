'use strict';

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOMBRES_MES = [
  '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function labelMes(año, mes) {
  return `${NOMBRES_MES[mes]} ${año}`;
}

function variacionPct(actual, anterior) {
  if (anterior === 0) return null;
  return Math.round(((actual - anterior) / Math.abs(anterior)) * 100);
}

// ─── Calcular resumen de un conjunto de transacciones de un mes ───────────────

function calcularResumenMes(transacciones, mes, año) {
  let ingresos = 0;
  let egresos  = 0;
  const gastosPorCategoria = {};

  for (const tx of transacciones) {
    const monto = Number(tx.monto_original) || 0;
    if (tx.tipo === 'ingreso') {
      ingresos += monto;
    } else {
      egresos += monto;
      const cat = tx.categoria_sugerida_ia || 'otros_gastos';
      gastosPorCategoria[cat] = (gastosPorCategoria[cat] || 0) + monto;
    }
  }

  const resultado  = ingresos - egresos;
  const margen_pct = ingresos > 0
    ? Math.round((resultado / ingresos) * 1000) / 10   // 1 decimal
    : 0;

  // Top 3 egresos por categoría (descendente)
  const top_egresos = Object.entries(gastosPorCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([categoria, total]) => ({
      categoria,
      total: Math.round(total),
    }));

  return {
    mes,
    año,
    label:               labelMes(año, mes),
    ingresos:            Math.round(ingresos),
    egresos:             Math.round(egresos),
    resultado:           Math.round(resultado),
    margen_pct,
    total_transacciones: transacciones.length,
    top_egresos,
  };
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Obtiene el contexto financiero completo de una empresa.
 * Hace UNA sola query a Supabase y procesa todo en memoria.
 *
 * @param {string} empresa_id
 * @returns {Promise<object>}
 */
async function obtenerContextoFinanciero(empresa_id) {
  const supabase = getSupabase();

  const { data: transacciones, error } = await supabase
    .from('transacciones_historicas')
    .select('fecha_transaccion, tipo, monto_original, categoria_sugerida_ia')
    .eq('empresa_id', empresa_id)
    .order('fecha_transaccion', { ascending: true });

  if (error) {
    throw new Error(`[contextoFinanciero] Error consultando transacciones: ${error.message}`);
  }

  if (!transacciones || transacciones.length === 0) {
    return {
      meses_disponibles:    [],
      ultimo_mes_con_datos: null,
      resumenes_por_mes:    [],
    };
  }

  // ── Agrupar transacciones por "año-mes" ───────────────────────────────────
  const porMes = {};  // clave: "2026-01"

  for (const tx of transacciones) {
    const fecha = tx.fecha_transaccion;           // "2026-01-15"
    const clave = fecha.substring(0, 7);          // "2026-01"
    if (!porMes[clave]) porMes[clave] = [];
    porMes[clave].push(tx);
  }

  // ── Ordenar claves cronológicamente ──────────────────────────────────────
  const claves = Object.keys(porMes).sort();

  // ── Calcular resumen por mes ──────────────────────────────────────────────
  const resumenes_por_mes = claves.map(clave => {
    const [añoStr, mesStr] = clave.split('-');
    const año = parseInt(añoStr, 10);
    const mes = parseInt(mesStr, 10);
    return calcularResumenMes(porMes[clave], mes, año);
  });

  // ── Último mes con datos ──────────────────────────────────────────────────
  const ultimoResumen = resumenes_por_mes[resumenes_por_mes.length - 1];
  const ultimo_mes_con_datos = {
    mes:   ultimoResumen.mes,
    año:   ultimoResumen.año,
    label: ultimoResumen.label,
  };

  // ── Labels de meses disponibles ───────────────────────────────────────────
  const meses_disponibles = resumenes_por_mes.map(r => r.label);

  return {
    meses_disponibles,
    ultimo_mes_con_datos,
    resumenes_por_mes,
  };
}

module.exports = { obtenerContextoFinanciero };
