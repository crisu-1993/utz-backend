const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ─── Categorías fijas del sistema ────────────────────────────────────────────
const CATEGORIAS_INGRESOS = [
  'venta_productos',
  'venta_servicios',
  'otros_ingresos',
];

const CATEGORIAS_EGRESOS = [
  'remuneraciones',
  'arriendo',
  'marketing',
  'servicios_basicos',
  'proveedores',
  'impuestos',
  'gastos_financieros',
  'otros_gastos',
];

// ─── Cliente Supabase ─────────────────────────────────────────────────────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Construir rango de fechas desde los query params ─────────────────────────
// ?mes=3&año=2024  → 2024-03-01 a 2024-03-31
// ?año=2024        → 2024-01-01 a 2024-12-31
// (sin params)     → sin filtro de fecha
function buildDateRange(mes, anio) {
  if (!anio) return { desde: null, hasta: null };

  const year = parseInt(anio, 10);
  if (isNaN(year)) return { desde: null, hasta: null };

  if (mes) {
    const month = parseInt(mes, 10);
    if (isNaN(month) || month < 1 || month > 12) {
      return { desde: null, hasta: null };
    }
    const desde = `${year}-${String(month).padStart(2, '0')}-01`;
    // Último día del mes: primer día del mes siguiente menos 1
    const ultimoDia = new Date(year, month, 0).getDate();
    const hasta = `${year}-${String(month).padStart(2, '0')}-${ultimoDia}`;
    return { desde, hasta };
  }

  // Solo año
  return {
    desde: `${year}-01-01`,
    hasta: `${year}-12-31`,
  };
}

// ─── Agrupar transacciones por categoría ─────────────────────────────────────
function agruparPorCategoria(transacciones, categoriasFijas) {
  const mapa = {};

  // Inicializar todas las categorías fijas en cero
  for (const cat of categoriasFijas) {
    mapa[cat] = { total: 0, cantidad_transacciones: 0, transacciones: [] };
  }

  for (const t of transacciones) {
    const cat = t.categoria_sugerida_ia;

    // Si la categoría no es una de las fijas, ignorar (no debería pasar)
    if (!mapa[cat]) continue;

    mapa[cat].total                += Number(t.monto_original);
    mapa[cat].cantidad_transacciones += 1;
    mapa[cat].transacciones.push({
      id:                    t.id,
      fecha:                 t.fecha_transaccion,
      descripcion:           t.descripcion_normalizada || t.descripcion_original,
      monto:                 Number(t.monto_original),
      confianza_deteccion:   t.confianza_deteccion !== null
        ? Math.round(Number(t.confianza_deteccion) * 100)
        : null,
      estado:                t.estado,
    });
  }

  // Redondear totales y ordenar transacciones por fecha descendente
  for (const cat of categoriasFijas) {
    mapa[cat].total = Math.round(mapa[cat].total);
    mapa[cat].transacciones.sort((a, b) => b.fecha.localeCompare(a.fecha));
  }

  return mapa;
}

// ─── GET /api/estado-resultados/:empresa_id ───────────────────────────────────
router.get('/:empresa_id', async (req, res) => {
  const { empresa_id } = req.params;
  const { mes, año: anio } = req.query;

  if (!empresa_id) {
    return res.status(400).json({ ok: false, error: 'empresa_id es requerido.' });
  }

  const { desde, hasta } = buildDateRange(mes, anio);

  // Validar que si se pasa mes se pase también año
  if (mes && !anio) {
    return res.status(400).json({
      ok: false,
      error: 'Si se filtra por mes también debe enviarse el parámetro año.',
    });
  }

  const supabase = getSupabase();

  try {
    // ── Consultar todas las transacciones del período ─────────────────────────
    let query = supabase
      .from('transacciones_historicas')
      .select(`
        id,
        fecha_transaccion,
        descripcion_original,
        descripcion_normalizada,
        tipo,
        monto_original,
        categoria_sugerida_ia,
        confianza_deteccion,
        estado
      `)
      .eq('empresa_id', empresa_id)
      .order('fecha_transaccion', { ascending: true });

    if (desde) query = query.gte('fecha_transaccion', desde);
    if (hasta) query = query.lte('fecha_transaccion', hasta);

    const { data: transacciones, error } = await query;

    if (error) throw new Error(error.message);

    // ── Separar ingresos y egresos ────────────────────────────────────────────
    const txIngresos = transacciones.filter(t => t.tipo === 'ingreso');
    const txEgresos  = transacciones.filter(t => t.tipo === 'egreso');

    // ── Calcular totales globales ─────────────────────────────────────────────
    const totalIngresos = txIngresos.reduce((s, t) => s + Number(t.monto_original), 0);
    const totalEgresos  = txEgresos.reduce((s, t) => s + Number(t.monto_original), 0);
    const resultadoNeto = totalIngresos - totalEgresos;
    const margenNeto    = totalIngresos > 0
      ? Math.round((resultadoNeto / totalIngresos) * 10000) / 100   // 2 decimales
      : 0;

    // ── Agrupar por categoría ─────────────────────────────────────────────────
    const ingresosDetalle = agruparPorCategoria(txIngresos, CATEGORIAS_INGRESOS);
    const egresosDetalle  = agruparPorCategoria(txEgresos,  CATEGORIAS_EGRESOS);

    // ── Construir período legible ─────────────────────────────────────────────
    let periodoLabel = 'Todos los períodos';
    if (desde && hasta) {
      if (mes) {
        const nombresMes = [
          '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
          'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
        ];
        periodoLabel = `${nombresMes[parseInt(mes, 10)]} ${anio}`;
      } else {
        periodoLabel = `Año ${anio}`;
      }
    }

    return res.json({
      ok: true,
      empresa_id,
      periodo: {
        label:  periodoLabel,
        desde:  desde || null,
        hasta:  hasta || null,
        mes:    mes    ? parseInt(mes, 10)  : null,
        año:    anio   ? parseInt(anio, 10) : null,
      },
      resumen: {
        total_ingresos:  Math.round(totalIngresos),
        total_egresos:   Math.round(totalEgresos),
        resultado_neto:  Math.round(resultadoNeto),
        margen_neto_pct: margenNeto,
        total_transacciones:        transacciones.length,
        transacciones_sin_categoria: transacciones.filter(
          t => !t.categoria_sugerida_ia
        ).length,
      },
      ingresos: {
        total: Math.round(totalIngresos),
        categorias: ingresosDetalle,
      },
      egresos: {
        total: Math.round(totalEgresos),
        categorias: egresosDetalle,
      },
    });

  } catch (err) {
    console.error('[estado-resultados] Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
