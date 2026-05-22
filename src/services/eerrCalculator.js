'use strict';

// ─── eerrCalculator.js ────────────────────────────────────────────────────────
//
// Funciones PURAS de cálculo del EERR Ampliado.
// Extraídas de src/routes/estadoResultados.js para ser reutilizables tanto
// por el endpoint del dashboard como por el contexto financiero de Niko.
//
// REGLA: ninguna función aquí toca Supabase ni req/res.
// Reciben datos ya traídos de la BD → devuelven datos calculados.

// ─── Jerarquía del EERR Ampliado ─────────────────────────────────────────────
// (antes en estadoResultados.js líneas 12–21)

const JERARQUIA_EERR = [
  { seccion: 'ingreso_principal',  label: 'Ingresos',              tipo: 'ingreso' },
  { seccion: 'ingreso_secundario', label: 'Otros ingresos',        tipo: 'ingreso' },
  { seccion: 'otros_ingresos',     label: 'Otros ingresos',        tipo: 'ingreso' },
  { seccion: 'costo_directo',      label: 'Costos directos',       tipo: 'egreso'  },
  { seccion: 'gasto_operacional',  label: 'Gastos operacionales',  tipo: 'egreso'  },
  { seccion: 'gasto_marketing',    label: 'Marketing',             tipo: 'egreso'  },
  { seccion: 'gasto_financiero',   label: 'Gastos financieros',    tipo: 'egreso'  },
  { seccion: 'otros_egresos',      label: 'Otros egresos',         tipo: 'egreso'  },
];

// ─── Helper: calcular si categoría debe mostrarse ─────────────────────────────
// (antes en estadoResultados.js líneas 24–31)

function debeVisualizarse(cat, totalMonto) {
  // Nunca usada → no mostrar
  if (!cat.primera_vez_usada_at) return false;
  // Tiene monto este período → mostrar siempre
  if (totalMonto > 0) return true;
  // Fue usada alguna vez → mostrar (lógica de 3 meses la maneja Niko)
  return true;
}

// ─── resolverPeriodo ──────────────────────────────────────────────────────────
// (antes en estadoResultados.js líneas 39–59)
//
// Convierte los query params opcionales a un par de fechas YYYY-MM-DD.
//
// @param {object} params  - { mes, anio, desde, hasta } (todos opcionales, como strings)
// @returns {{ fechaDesde: string, fechaHasta: string }}

function resolverPeriodo({ mes, anio, desde, hasta } = {}) {
  const ahora = new Date();
  let fechaDesde, fechaHasta;

  if (mes && anio) {
    // Formato del frontend: ?mes=3&anio=2026
    const m = parseInt(mes, 10);
    const y = parseInt(anio, 10);
    fechaDesde = new Date(y, m - 1, 1).toISOString().split('T')[0];
    fechaHasta = new Date(y, m, 0).toISOString().split('T')[0];
  } else if (desde && hasta) {
    // Formato alternativo: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
    fechaDesde = desde;
    fechaHasta = hasta;
  } else {
    // Default: mes actual
    fechaDesde = new Date(ahora.getFullYear(), ahora.getMonth(), 1)
      .toISOString().split('T')[0];
    fechaHasta = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0)
      .toISOString().split('T')[0];
  }

  return { fechaDesde, fechaHasta };
}

// ─── acumularPorCategoria ─────────────────────────────────────────────────────
// (antes en estadoResultados.js líneas 80–93)
//
// Recorre transacciones y acumula montos por categoria_id.
// Separa ingresos/egresos sin categorizar.
//
// @param {Array<{monto_original, tipo, categoria_id}>} transacciones
// @returns {{ montosPorCategoria: object, sinCategorizarIngreso: number, sinCategorizarEgreso: number }}

function acumularPorCategoria(transacciones) {
  const montosPorCategoria = {};
  let sinCategorizarIngreso = 0;
  let sinCategorizarEgreso  = 0;

  for (const tx of transacciones) {
    const monto = Math.abs(Number(tx.monto_original));
    if (tx.categoria_id === null) {
      if (tx.tipo === 'ingreso') sinCategorizarIngreso += monto;
      else                       sinCategorizarEgreso  += monto;
    } else {
      montosPorCategoria[tx.categoria_id] = (montosPorCategoria[tx.categoria_id] || 0) + monto;
    }
  }

  return { montosPorCategoria, sinCategorizarIngreso, sinCategorizarEgreso };
}

// ─── construirSecciones ───────────────────────────────────────────────────────
// (antes en estadoResultados.js líneas 95–145)
//
// Inicializa estructura de secciones según JERARQUIA_EERR, agrupa categorías
// en sus secciones e inyecta ítems especiales de sin_categorizar.
//
// @param {Array}  categorias              - rows de categorias_eerr
// @param {object} montosPorCategoria      - { [categoria_id]: number }
// @param {number} sinCategorizarIngreso
// @param {number} sinCategorizarEgreso
// @returns {{ [seccion: string]: { label, tipo, total, categorias } }}

function construirSecciones(categorias, montosPorCategoria, sinCategorizarIngreso, sinCategorizarEgreso) {
  // 4. Construir EERR con jerarquía
  const secciones = {};
  for (const jerarquia of JERARQUIA_EERR) {
    secciones[jerarquia.seccion] = {
      label: jerarquia.label,
      tipo: jerarquia.tipo,
      total: 0,
      categorias: []
    };
  }

  // Categorías sin seccion_eerr van a otros_egresos por defecto
  for (const cat of categorias) {
    const seccion = cat.seccion_eerr || 'otros_egresos';
    const monto = montosPorCategoria[cat.id] || 0;

    if (!debeVisualizarse(cat, monto)) continue;
    if (!secciones[seccion]) continue;

    secciones[seccion].categorias.push({
      id: cat.id,
      nombre: cat.nombre,
      monto,
      es_sistema: cat.es_sistema,
      primera_vez_usada_at: cat.primera_vez_usada_at,
      ultimo_movimiento_at: cat.ultimo_movimiento_at
    });
    secciones[seccion].total += monto;
  }

  // Inyectar transacciones sin categorizar como ítem especial en su sección
  if (sinCategorizarIngreso > 0) {
    secciones['otros_ingresos'].categorias.push({
      id:              null,
      nombre:          'Otros ingresos (sin categorizar)',
      monto:           sinCategorizarIngreso,
      es_sistema:      false,
      sin_categorizar: true,
    });
    secciones['otros_ingresos'].total += sinCategorizarIngreso;
  }
  if (sinCategorizarEgreso > 0) {
    secciones['otros_egresos'].categorias.push({
      id:              null,
      nombre:          'Otros egresos (sin categorizar)',
      monto:           sinCategorizarEgreso,
      es_sistema:      false,
      sin_categorizar: true,
    });
    secciones['otros_egresos'].total += sinCategorizarEgreso;
  }

  return secciones;
}

// ─── calcularSubtotales ───────────────────────────────────────────────────────
// (antes en estadoResultados.js líneas 147–175)
//
// Calcula los 10 subtotales contables del EERR a partir del objeto secciones.
//
// @param {{ [seccion]: { total: number } }} secciones
// @returns {{ total_ingresos, costo_directo, margen_bruto, margen_bruto_pct,
//             gastos_operacionales, resultado_operacional, resultado_operacional_pct,
//             gastos_financieros, utilidad_neta, utilidad_neta_pct }}

function calcularSubtotales(secciones) {
  // 5. Calcular subtotales contables
  const totalIngresos =
    (secciones.ingreso_principal?.total  || 0) +
    (secciones.ingreso_secundario?.total || 0) +
    (secciones.otros_ingresos?.total     || 0);

  const totalCostoDirecto = secciones.costo_directo?.total || 0;
  const margenBruto = totalIngresos - totalCostoDirecto;
  const margenBrutoPct = totalIngresos > 0
    ? ((margenBruto / totalIngresos) * 100).toFixed(1)
    : 0;

  const totalGastosOp =
    (secciones.gasto_operacional?.total || 0) +
    (secciones.gasto_marketing?.total || 0);

  const resultadoOperacional = margenBruto - totalGastosOp;
  const resultadoOperacionalPct = totalIngresos > 0
    ? ((resultadoOperacional / totalIngresos) * 100).toFixed(1)
    : 0;

  const totalGastosFinancieros =
    (secciones.gasto_financiero?.total || 0) +
    (secciones.otros_egresos?.total || 0);

  const utilidadNeta = resultadoOperacional - totalGastosFinancieros;
  const utilidadNetaPct = totalIngresos > 0
    ? ((utilidadNeta / totalIngresos) * 100).toFixed(1)
    : 0;

  return {
    total_ingresos:               totalIngresos,
    costo_directo:                totalCostoDirecto,
    margen_bruto:                 margenBruto,
    margen_bruto_pct:             parseFloat(margenBrutoPct),
    gastos_operacionales:         totalGastosOp,
    resultado_operacional:        resultadoOperacional,
    resultado_operacional_pct:    parseFloat(resultadoOperacionalPct),
    gastos_financieros:           totalGastosFinancieros,
    utilidad_neta:                utilidadNeta,
    utilidad_neta_pct:            parseFloat(utilidadNetaPct),
  };
}

// ─── serializarSecciones ──────────────────────────────────────────────────────
// (antes en estadoResultados.js líneas 177–192)
//
// Filtra secciones vacías y convierte el objeto a array ordenado por JERARQUIA_EERR.
//
// @param {{ [seccion]: { label, total, categorias } }} secciones
// @returns {Array<{ nombre: string, categorias: Array, total: number }>}

function serializarSecciones(secciones) {
  // 6. Filtrar secciones vacías para respuesta limpia
  const seccionesVisibles = {};
  for (const [key, val] of Object.entries(secciones)) {
    if (val.categorias.length > 0) {
      seccionesVisibles[key] = val;
    }
  }

  // 7. Convertir secciones a array ordenado según jerarquía
  const seccionesArray = JERARQUIA_EERR
    .filter(j => seccionesVisibles[j.seccion])
    .map(j => ({
      nombre: seccionesVisibles[j.seccion].label,
      categorias: seccionesVisibles[j.seccion].categorias,
      total: seccionesVisibles[j.seccion].total
    }));

  return seccionesArray;
}

// ─── detectarCandidatasRevision ───────────────────────────────────────────────
// (antes en estadoResultados.js líneas 194–207)
//
// Detecta categorías candidatas a pregunta de Niko:
// usadas alguna vez, sin movimiento en 3+ meses, sin monto en el período actual.
//
// @param {Array}  categorias          - rows de categorias_eerr
// @param {object} montosPorCategoria  - { [categoria_id]: number }
// @returns {Array<{ id, nombre, ultimo_movimiento_at }>}

function detectarCandidatasRevision(categorias, montosPorCategoria) {
  const tresM = new Date();
  tresM.setMonth(tresM.getMonth() - 3);

  return categorias.filter(cat =>
    cat.primera_vez_usada_at &&
    cat.ultimo_movimiento_at &&
    new Date(cat.ultimo_movimiento_at) < tresM &&
    !montosPorCategoria[cat.id]
  ).map(cat => ({
    id: cat.id,
    nombre: cat.nombre,
    ultimo_movimiento_at: cat.ultimo_movimiento_at
  }));
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  JERARQUIA_EERR,
  debeVisualizarse,
  resolverPeriodo,
  acumularPorCategoria,
  construirSecciones,
  calcularSubtotales,
  serializarSecciones,
  detectarCandidatasRevision,
};
