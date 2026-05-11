const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { authMiddleware } = require('../middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Jerarquía del EERR Ampliado
const JERARQUIA_EERR = [
  { seccion: 'ingreso_principal',  label: 'Ingresos',              tipo: 'ingreso' },
  { seccion: 'ingreso_secundario', label: 'Otros ingresos',        tipo: 'ingreso' },
  { seccion: 'costo_directo',      label: 'Costos directos',       tipo: 'egreso'  },
  { seccion: 'gasto_operacional',  label: 'Gastos operacionales',  tipo: 'egreso'  },
  { seccion: 'gasto_marketing',    label: 'Marketing',             tipo: 'egreso'  },
  { seccion: 'gasto_financiero',   label: 'Gastos financieros',    tipo: 'egreso'  },
  { seccion: 'otros_egresos',      label: 'Otros egresos',         tipo: 'egreso'  },
];

// Helper: calcular si categoría debe mostrarse
function debeVisualizarse(cat, totalMonto) {
  // Nunca usada → no mostrar
  if (!cat.primera_vez_usada_at) return false;
  // Tiene monto este período → mostrar siempre
  if (totalMonto > 0) return true;
  // Fue usada alguna vez → mostrar (lógica de 3 meses la maneja Niko)
  return true;
}

// GET /api/estado-resultados/:empresa_id?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/:empresa_id', authMiddleware, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { desde, hasta, mes, anio } = req.query;

    // Período por defecto y conversión de mes/anio a fechas
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

    // 1. Obtener categorías de la empresa con sus secciones
    const { data: categorias, error: errCat } = await supabase
      .from('categorias_eerr')
      .select('id, nombre, tipo, seccion_eerr, es_sistema, primera_vez_usada_at, ultimo_movimiento_at')
      .eq('empresa_id', empresa_id)
      .eq('activa', true);

    if (errCat) throw errCat;

    // 2. Obtener transacciones del período con categoria_id
    const { data: transacciones, error: errTx } = await supabase
      .from('transacciones_historicas')
      .select('monto, tipo, categoria_id')
      .eq('empresa_id', empresa_id)
      .gte('fecha', fechaDesde)
      .lte('fecha', fechaHasta)
      .not('categoria_id', 'is', null);

    if (errTx) throw errTx;

    // 3. Sumar montos por categoria_id
    const montosPorCategoria = {};
    for (const tx of transacciones) {
      if (!montosPorCategoria[tx.categoria_id]) {
        montosPorCategoria[tx.categoria_id] = 0;
      }
      montosPorCategoria[tx.categoria_id] += Math.abs(tx.monto);
    }

    // 4. Construir EERR con jerarquía
    const secciones = {};
    for (const jerarquia of JERARQUIA_EERR) {
      secciones[jerarquia.seccion] = {
        label: jerarquia.tipo,
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

    // 5. Calcular subtotales contables
    const totalIngresos =
      (secciones.ingreso_principal?.total || 0) +
      (secciones.ingreso_secundario?.total || 0);

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

    // 8. Detectar categorías candidatas a pregunta de Niko
    // (usadas alguna vez, sin movimiento en 3+ meses)
    const tresM = new Date();
    tresM.setMonth(tresM.getMonth() - 3);
    const candidatasRevision = categorias.filter(cat =>
      cat.primera_vez_usada_at &&
      cat.ultimo_movimiento_at &&
      new Date(cat.ultimo_movimiento_at) < tresM &&
      !montosPorCategoria[cat.id]
    ).map(cat => ({
      id: cat.id,
      nombre: cat.nombre,
      ultimo_movimiento_at: cat.ultimo_movimiento_at
    }));

    res.json({
      ok: true,
      empresa_id,
      periodo: {
        desde: fechaDesde,
        hasta: fechaHasta
      },
      eerr: {
        secciones: seccionesArray,
        subtotales: {
          total_ingresos: totalIngresos,
          costo_directo: totalCostoDirecto,
          margen_bruto: margenBruto,
          margen_bruto_pct: parseFloat(margenBrutoPct),
          gastos_operacionales: totalGastosOp,
          resultado_operacional: resultadoOperacional,
          resultado_operacional_pct: parseFloat(resultadoOperacionalPct),
          gastos_financieros: totalGastosFinancieros,
          utilidad_neta: utilidadNeta,
          utilidad_neta_pct: parseFloat(utilidadNetaPct)
        }
      },
      niko_revision: candidatasRevision
    });

  } catch (err) {
    console.error('EERR error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
