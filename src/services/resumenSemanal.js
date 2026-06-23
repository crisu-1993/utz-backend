// src/services/resumenSemanal.js
//
// Motor del resumen semanal — genera el TEXTO del resumen (template, sin IA).
// Módulo hoja: no importa nada de routes ni de otros services.

const { consultarPeriodo } = require('../utils/periodos');

// ─── Helpers de formato ───────────────────────────────────────────────────────

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// "2026-06-08" → "lunes 8 de junio"
function formatFecha(fechaStr) {
  const [anio, mes, dia] = fechaStr.split('-').map(Number);
  const fecha    = new Date(anio, mes - 1, dia);
  const nombreDia = DIAS[fecha.getDay()];
  const nombreMes = MESES[mes - 1];
  return `${nombreDia} ${dia} de ${nombreMes}`;
}

// 1234567 → "$1.234.567"
function formatPesos(monto) {
  return '$' + Math.round(monto).toLocaleString('es-CL');
}

// ─── Generador principal ──────────────────────────────────────────────────────

/**
 * Genera el texto del resumen semanal para una empresa.
 *
 * @param {object} supabase     - Cliente Supabase (creado por el caller)
 * @param {string} empresa_id
 * @param {string} fecha_inicio - YYYY-MM-DD (inicio de la semana)
 * @param {string} fecha_fin    - YYYY-MM-DD (fin de la semana)
 * @returns {{ mensaje: string, datos: object }}
 */
async function generarResumenSemanal(supabase, empresa_id, fecha_inicio, fecha_fin) {
  // ── 1. Rango anterior: misma duración desplazada hacia atrás ───────────────
  const msInicio = new Date(fecha_inicio).getTime();
  const msFin    = new Date(fecha_fin).getTime();
  const durMs    = msFin - msInicio + 86400000;   // +1 día (rango inclusivo)
  const inicioAnt = new Date(msInicio - durMs).toISOString().split('T')[0];
  const finAnt    = new Date(msFin    - durMs).toISOString().split('T')[0];

  // ── 2. Consultas en paralelo ───────────────────────────────────────────────
  const [txActual, txAnterior, { data: empresa }] = await Promise.all([
    consultarPeriodo(supabase, empresa_id, fecha_inicio, fecha_fin),
    consultarPeriodo(supabase, empresa_id, inicioAnt, finAnt),
    supabase
      .from('empresas')
      .select('representante_nombre')
      .eq('id', empresa_id)
      .single(),
  ]);

  // ── 3. Agregar totales ─────────────────────────────────────────────────────
  let entraron = 0;
  let salieron = 0;
  for (const t of txActual) {
    const monto = Number(t.monto_original);
    if (t.tipo === 'ingreso') entraron += monto;
    else                      salieron += monto;
  }

  let entroAnt = 0;
  let salioAnt = 0;
  for (const t of txAnterior) {
    const monto = Number(t.monto_original);
    if (t.tipo === 'ingreso') entroAnt += monto;
    else                      salioAnt += monto;
  }

  entraron = Math.round(entraron);
  salieron = Math.round(salieron);
  const resultado    = Math.round(entraron - salieron);
  const resultadoAnt = Math.round(entroAnt - salioAnt);

  // ── 4. Nombre del representante (solo primer nombre) ──────────────────────
  const nombreCompleto = empresa?.representante_nombre || null;
  const primerNombre   = nombreCompleto ? nombreCompleto.trim().split(/\s+/)[0] : null;
  const saludo         = primerNombre ? `Hola ${primerNombre}` : 'Hola';

  // ── 5. Línea de resultado según signo ─────────────────────────────────────
  const lineaResultado = resultado >= 0
    ? `Te quedó libre: ${formatPesos(resultado)}`
    : `Esta semana cerraste en rojo: gastaste ${formatPesos(Math.abs(resultado))} más de lo que entró.`;

  // ── 6. Línea de comparación en pesos (solo si hay datos semana anterior) ──
  let lineaComparacion = '';
  if (txAnterior.length > 0) {
    const diferencia = resultado - resultadoAnt;
    if (diferencia > 0) {
      // Mejoró — si ambos negativos, agrega detalle de la pérdida
      const detalle = (resultado < 0 && resultadoAnt < 0)
        ? ` (la pérdida bajó de ${formatPesos(Math.abs(resultadoAnt))} a ${formatPesos(Math.abs(resultado))})`
        : '';
      lineaComparacion = `Respecto a la semana pasada, mejoraste ${formatPesos(diferencia)}${detalle}.`;
    } else if (diferencia < 0) {
      lineaComparacion = `Respecto a la semana pasada, cerraste ${formatPesos(Math.abs(diferencia))} peor.`;
    }
    // diferencia === 0 → sin línea
  }

  // ── 7. Armar mensaje ───────────────────────────────────────────────────────
  const labelInicio = formatFecha(fecha_inicio);
  const labelFin    = formatFecha(fecha_fin);

  const lineas = [
    `${saludo}, acá va tu resumen de la semana (${labelInicio} al ${labelFin}):`,
    '',
    `Ventas:  ${formatPesos(entraron)}`,
    `Costos:  ${formatPesos(salieron)}`,
    lineaResultado,
  ];

  if (lineaComparacion) {
    lineas.push('');
    lineas.push(lineaComparacion);
  }

  const mensaje = lineas.join('\n');

  return {
    mensaje,
    datos: {
      empresa_id,
      fecha_inicio,
      fecha_fin,
      entraron,
      salieron,
      resultado,
      anterior: txAnterior.length > 0
        ? { fecha_inicio: inicioAnt, fecha_fin: finAnt, entroAnt, salioAnt, resultadoAnt }
        : null,
    },
  };
}

module.exports = { generarResumenSemanal };
