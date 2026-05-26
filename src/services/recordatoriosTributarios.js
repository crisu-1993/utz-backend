// src/services/recordatoriosTributarios.js
// Motor tributario – Pieza 3b: cálculo de fechas + generación de recordatorios.
// Las fechas tributarias (12/20 del F29, 13 de Previred) van fijas en el texto;
// las fechas del recordatorio (creación / campanita) son orientativas tempranas.

const { crearRecordatorio } = require('../routes/recordatorios');

// ─── Helpers internos ───────────────────────────────────────────────────────

/**
 * Formatea (año, mes, dia) → 'YYYY-MM-DD' sin pasar por Date ni toISOString.
 */
function formatearFecha(anio, mes, dia) {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Retorna nombre del mes en español (1-based: 1 → 'enero').
 */
function nombreMes(mes) {
  return MESES_ES[mes - 1];
}

// ─── hoyChile ───────────────────────────────────────────────────────────────

/**
 * Retorna 'YYYY-MM-DD' del día de hoy en zona America/Santiago.
 */
function hoyChile() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// ─── Cálculo de fechas ─────────────────────────────────────────────────────

/**
 * F29 (mensual): se crea día 2, campanita día 5.
 * Las fechas tributarias reales (12 presencial / 20 online) van en el texto fijo.
 */
function calcularFechasF29(anio, mes) {
  return {
    creacion:    formatearFecha(anio, mes, 2),
    fecha_aviso: formatearFecha(anio, mes, 5),
    periodo:     `${anio}-${String(mes).padStart(2, '0')}`,
  };
}

/**
 * Previred (mensual): se crea día 3, campanita día 6.
 * Vencimiento real (13) va en el texto con mes dinámico.
 */
function calcularFechasPrevired(anio, mes) {
  return {
    creacion:    formatearFecha(anio, mes, 3),
    fecha_aviso: formatearFecha(anio, mes, 6),
    periodo:     `${anio}-${String(mes).padStart(2, '0')}`,
  };
}

/**
 * F22 (anual): aviso informativo el 2 de abril.
 */
function calcularFechaF22(anio) {
  return {
    fecha:   formatearFecha(anio, 4, 2),
    periodo: String(anio),
  };
}

// ─── Plantillas de texto ────────────────────────────────────────────────────

function plantillaF29() {
  return {
    titulo: 'F29 (IVA) — plazos 12 y 20',
    descripcion: 'Jefe, te recuerdo que hay hasta el 12 para el F29 si lo haces presencial en bancos, si lo haces onlines, hay más holgura, hasta el 20, te aviso desde ya para que trabajemos con tiempo.',
  };
}

function plantillaPrevired(mes) {
  return {
    titulo: 'Previred — cotizaciones',
    descripcion: `Jefe, te aviso con tiempo: las cotizaciones (Previred) cierran el 13 de ${nombreMes(mes)}. Si no tienes trabajadores, puedes ignorar este recordatorio.`,
  };
}

function plantillaF22() {
  return {
    titulo: 'Operación Renta (F22)',
    descripcion: 'Jefe, arrancó la Operación Renta. El F22 se declara durante abril y suele cerrar a fin de mes. Confirma la fecha exacta en el SII y prepara tu declaración con tiempo.',
  };
}

// ─── Generación por empresa ─────────────────────────────────────────────────

/**
 * Genera los recordatorios tributarios del mes actual para UNA empresa.
 * Usa clave_idempotencia para evitar duplicados — si ya existe, retorna sin error.
 *
 * @param {string} empresa_id  UUID
 * @param {string} user_id     UUID (owner_id de la empresa)
 * @param {string} hoyStr      'YYYY-MM-DD' (hoy en Chile)
 * @param {object} supabase    cliente Supabase (no se usa directo, crearRecordatorio usa el suyo)
 * @returns {Promise<{nuevos: number, idempotentes: number}>}
 */
async function generarParaEmpresa(empresa_id, user_id, hoyStr) {
  const partes = hoyStr.split('-');
  const anio = Number(partes[0]);
  const mes  = Number(partes[1]);

  let nuevos = 0;
  let idempotentes = 0;

  // ── F29 ──────────────────────────────────────────────────────────────────
  const f29 = calcularFechasF29(anio, mes);
  if (hoyStr >= f29.creacion) {
    const texto = plantillaF29();
    const res = await crearRecordatorio({
      empresa_id,
      user_id,
      titulo:             texto.titulo,
      descripcion:        texto.descripcion,
      fecha_vencimiento:  f29.fecha_aviso,
      hora_vencimiento:   '09:00:00',
      origen:             'tributario_auto',
      clave_idempotencia: `F29-${empresa_id}-${f29.periodo}`,
    });
    if (res.ok && res.idempotente) {
      idempotentes++;
      console.log(`  [tributario] F29 ${f29.periodo} ya existía (empresa ${empresa_id})`);
    } else if (res.ok) {
      nuevos++;
      console.log(`  [tributario] F29 ${f29.periodo} creado (empresa ${empresa_id})`);
    } else {
      console.error(`  [tributario] F29 ${f29.periodo} ERROR: ${res.mensaje} (empresa ${empresa_id})`);
    }
  }

  // ── Previred ─────────────────────────────────────────────────────────────
  const prev = calcularFechasPrevired(anio, mes);
  if (hoyStr >= prev.creacion) {
    const texto = plantillaPrevired(mes);
    const res = await crearRecordatorio({
      empresa_id,
      user_id,
      titulo:             texto.titulo,
      descripcion:        texto.descripcion,
      fecha_vencimiento:  prev.fecha_aviso,
      hora_vencimiento:   '09:00:00',
      origen:             'tributario_auto',
      clave_idempotencia: `PREVIRED-${empresa_id}-${prev.periodo}`,
    });
    if (res.ok && res.idempotente) {
      idempotentes++;
      console.log(`  [tributario] Previred ${prev.periodo} ya existía (empresa ${empresa_id})`);
    } else if (res.ok) {
      nuevos++;
      console.log(`  [tributario] Previred ${prev.periodo} creado (empresa ${empresa_id})`);
    } else {
      console.error(`  [tributario] Previred ${prev.periodo} ERROR: ${res.mensaje} (empresa ${empresa_id})`);
    }
  }

  // ── F22 (solo en abril) ──────────────────────────────────────────────────
  if (mes === 4) {
    const f22 = calcularFechaF22(anio);
    if (hoyStr >= f22.fecha) {
      const texto = plantillaF22();
      const res = await crearRecordatorio({
        empresa_id,
        user_id,
        titulo:             texto.titulo,
        descripcion:        texto.descripcion,
        fecha_vencimiento:  f22.fecha,
        hora_vencimiento:   '09:00:00',
        origen:             'tributario_auto',
        clave_idempotencia: `F22-${empresa_id}-${f22.periodo}`,
      });
      if (res.ok && res.idempotente) {
        idempotentes++;
        console.log(`  [tributario] F22 ${f22.periodo} ya existía (empresa ${empresa_id})`);
      } else if (res.ok) {
        nuevos++;
        console.log(`  [tributario] F22 ${f22.periodo} creado (empresa ${empresa_id})`);
      } else {
        console.error(`  [tributario] F22 ${f22.periodo} ERROR: ${res.mensaje} (empresa ${empresa_id})`);
      }
    }
  }

  return { nuevos, idempotentes };
}

// ─── Orquestador principal ──────────────────────────────────────────────────

/**
 * Genera recordatorios tributarios para TODAS las empresas.
 * Será invocado por el cron diario (Pieza 4).
 *
 * @param {object} supabase  cliente Supabase con permisos de servicio
 */
async function generarRecordatoriosTributarios(supabase) {
  const hoyStr = hoyChile();
  console.log(`[tributario] Inicio generación — hoy: ${hoyStr}`);

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, owner_id');

  if (error) {
    console.error('[tributario] Error listando empresas:', error.message);
    return;
  }

  console.log(`[tributario] Empresas encontradas: ${empresas.length}`);

  let totalNuevos = 0;
  let totalIdempotentes = 0;

  for (const empresa of empresas) {
    try {
      const { nuevos, idempotentes } = await generarParaEmpresa(
        empresa.id,
        empresa.owner_id,
        hoyStr
      );
      totalNuevos += nuevos;
      totalIdempotentes += idempotentes;
    } catch (err) {
      console.error(`[tributario] Error en empresa ${empresa.id}:`, err.message);
    }
  }

  console.log(`[tributario] Fin — nuevos: ${totalNuevos}, idempotentes: ${totalIdempotentes}`);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  hoyChile,
  calcularFechasF29,
  calcularFechasPrevired,
  calcularFechaF22,
  formatearFecha,
  nombreMes,
  generarParaEmpresa,
  generarRecordatoriosTributarios,
};
