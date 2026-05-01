// src/utils/periodos.js

// ─── Calcular rango de fechas según período ───────────────────────────────────
function calcularRango(periodo) {
  const hoy = new Date();
  const año = hoy.getFullYear();
  const mes = hoy.getMonth();
  const dia = hoy.getDate();

  let inicio, fin;

  switch (periodo) {
    case 'hoy':
      inicio = new Date(año, mes, dia, 0, 0, 0);
      fin    = new Date(año, mes, dia, 23, 59, 59);
      break;
    case 'semana': {
      const dow = hoy.getDay();
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
      fin    = new Date(año, mes + 1, 0, 23, 59, 59);
      break;
  }

  return {
    fecha_inicio: inicio.toISOString().split('T')[0],
    fecha_fin:    fin.toISOString().split('T')[0],
  };
}

function calcularRangoAnterior(periodo) {
  const hoy = new Date();
  const año = hoy.getFullYear();
  const mes = hoy.getMonth();
  const dia = hoy.getDate();

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
      fin    = new Date(año, mes, 0, 23, 59, 59);
      break;
  }

  return {
    fecha_inicio: inicio.toISOString().split('T')[0],
    fecha_fin:    fin.toISOString().split('T')[0],
  };
}

function calcularRangoMes(anio, mes) {
  const ultimoDia = new Date(anio, mes, 0).getDate();
  return {
    fecha_inicio: `${anio}-${String(mes).padStart(2, '0')}-01`,
    fecha_fin:    `${anio}-${String(mes).padStart(2, '0')}-${ultimoDia}`,
  };
}

function variacionPct(actual, anterior) {
  if (anterior === 0) return actual > 0 ? 100 : 0;
  return Math.round(((actual - anterior) / Math.abs(anterior)) * 100);
}

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

module.exports = {
  calcularRango,
  calcularRangoAnterior,
  calcularRangoMes,
  variacionPct,
  consultarPeriodo,
};
