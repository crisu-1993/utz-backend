// src/services/recordatoriosFeriados.js
// Motor de avisos de feriados (semana corta).
// Cada vez que corre, mira la semana siguiente (lunes a domingo) y genera
// un recordatorio por empresa si hay al menos un feriado en esa ventana.

const { crearRecordatorio } = require('../routes/recordatorios');
const {
  feriadosEntre,
  esFinDeSemana,
  nombreDiaSemana,
  ventanaSemanaSiguiente,
} = require('../utils/feriados');

// ─── hoyChile ───────────────────────────────────────────────────────────────

/**
 * Retorna 'YYYY-MM-DD' del día de hoy en zona America/Santiago.
 */
function hoyChile() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// ─── Clasificación y armado de texto ────────────────────────────────────────

/**
 * Separa feriados en hábiles y fin de semana, agregando nombre del día.
 * @param {Array<{fecha: string, nombre: string}>} feriados
 * @returns {{ habiles: Array<{fecha, nombre, dia}>, finde: Array<{fecha, nombre, dia}> }}
 */
function clasificarFeriados(feriados) {
  const habiles = [];
  const finde = [];
  for (const f of feriados) {
    const item = { fecha: f.fecha, nombre: f.nombre, dia: nombreDiaSemana(f.fecha) };
    if (esFinDeSemana(f.fecha)) {
      finde.push(item);
    } else {
      habiles.push(item);
    }
  }
  return { habiles, finde };
}

/**
 * Convierte 'YYYY-MM-DD' a 'DD/MM/YYYY' (formato chileno).
 * Parsea por partes — timezone-safe, sin new Date(string).
 */
function formatearFechaCL(fechaStr) {
  const [anio, mes, dia] = fechaStr.split('-');
  return `${dia}/${mes}/${anio}`;
}

/**
 * Lista legible: "Año Nuevo que cae jueves 01/01/2026" o
 * "Año Nuevo que cae jueves 01/01/2026, y Reyes que cae viernes 06/01/2026".
 */
function listaFeriados(arr) {
  const items = arr.map(f => `${f.nombre} que cae ${f.dia} ${formatearFechaCL(f.fecha)}`);
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ', y ' + items[items.length - 1];
}

/**
 * Nota corta para descripción: "Año Nuevo (jueves 01/01/2026)" o
 * "Año Nuevo (jueves 01/01/2026), Reyes (viernes 06/01/2026)".
 */
function notaFeriados(arr) {
  return arr.map(f => `${f.nombre} (${f.dia} ${formatearFechaCL(f.fecha)})`).join(', ');
}

/**
 * Arma título, descripción y mensaje de Niko según la combinación de feriados.
 * @param {Array} habiles  feriados en día hábil (con .nombre, .dia)
 * @param {Array} finde    feriados en fin de semana (con .nombre, .dia)
 * @returns {{ titulo: string, descripcion: string, mensaje_chat: string }}
 */
function armarMensaje(habiles, finde) {
  const todos = [...habiles, ...finde];
  const etiqueta = todos.length === 1 ? 'Feriado' : 'Feriados';

  // TIPO 1: solo hábiles
  if (habiles.length > 0 && finde.length === 0) {
    return {
      titulo: 'Semana corta',
      descripcion: `${etiqueta}: ${notaFeriados(habiles)}`,
      mensaje_chat: habiles.length === 1
        ? `Jefe, la próxima semana es más corta: es feriado ${listaFeriados(habiles)}. Te aviso ahora para que te programes en caso de que necesites adelantar algo.`
        : `Jefe, la próxima semana es más corta: son feriados ${listaFeriados(habiles)}. Te aviso ahora para que te programes en caso de que necesites adelantar algo.`,
    };
  }

  // TIPO 2: solo fin de semana
  if (habiles.length === 0 && finde.length > 0) {
    return {
      titulo: 'Feriado el fin de semana',
      descripcion: `${etiqueta}: ${notaFeriados(finde)}`,
      mensaje_chat: finde.length === 1
        ? `Jefe, quizás te sea útil saber que ${listaFeriados(finde)} es feriado. Sé que cae en el fin de semana, pero prefiero adelantarme por cualquier cosa.`
        : `Jefe, quizás te sea útil saber que ${listaFeriados(finde)} son feriados. Sé que caen en el fin de semana, pero prefiero adelantarme por cualquier cosa.`,
    };
  }

  // TIPO 3: ambos
  const parteHabil = habiles.length === 1
    ? `es feriado ${listaFeriados(habiles)}`
    : `son feriados ${listaFeriados(habiles)}`;
  const parteFinde = finde.length === 1
    ? `${listaFeriados(finde)} es feriado también`
    : `${listaFeriados(finde)} son feriados también`;

  return {
    titulo: 'Semana corta',
    descripcion: `Feriados: ${notaFeriados(todos)}`,
    mensaje_chat: `Jefe, la próxima semana es más corta: ${parteHabil}. Y de paso, ojo que ${parteFinde}. Te aviso ahora para que te programes.`,
  };
}

// ─── Generación por empresa ─────────────────────────────────────────────────

/**
 * Genera el recordatorio de feriados de la semana siguiente para UNA empresa.
 * Si no hay feriados, no crea nada.
 *
 * @param {string} empresa_id  UUID
 * @param {string} user_id     UUID (owner_id)
 * @param {string} hoyStr      'YYYY-MM-DD' (hoy en Chile)
 * @param {object} supabase    cliente Supabase (para feriadosEntre)
 * @returns {Promise<{nuevos: number, idempotentes: number}>}
 */
async function generarParaEmpresa(empresa_id, user_id, hoyStr, supabase) {
  const ventana = ventanaSemanaSiguiente(hoyStr);
  const feriados = await feriadosEntre(ventana.lunes, ventana.domingo, supabase);

  if (feriados.length === 0) {
    return { nuevos: 0, idempotentes: 0 };
  }

  const { habiles, finde } = clasificarFeriados(feriados);
  const texto = armarMensaje(habiles, finde);

  const res = await crearRecordatorio({
    empresa_id,
    user_id,
    titulo:             texto.titulo,
    descripcion:        texto.descripcion,
    mensaje_chat:       texto.mensaje_chat,
    fecha_vencimiento:  hoyStr,
    hora_vencimiento:   '08:00:00',
    origen:             'feriado_auto',
    clave_idempotencia: `FERIADO-${empresa_id}-${ventana.lunes}`,
  });

  if (res.ok && res.idempotente) {
    console.log(`  [feriados] Semana ${ventana.lunes} ya existía (empresa ${empresa_id})`);
    return { nuevos: 0, idempotentes: 1 };
  }
  if (res.ok) {
    console.log(`  [feriados] Semana ${ventana.lunes} creado (empresa ${empresa_id})`);
    return { nuevos: 1, idempotentes: 0 };
  }
  console.error(`  [feriados] Semana ${ventana.lunes} ERROR: ${res.mensaje} (empresa ${empresa_id})`);
  return { nuevos: 0, idempotentes: 0 };
}

// ─── Orquestador principal ──────────────────────────────────────────────────

/**
 * Genera recordatorios de feriados para TODAS las empresas.
 * Será invocado por el cron (Pieza 4).
 *
 * @param {object} supabase  cliente Supabase con permisos de servicio
 */
async function generarRecordatoriosFeriados(supabase) {
  const hoyStr = hoyChile();
  console.log(`[feriados] Inicio generación — hoy: ${hoyStr}`);

  const ventana = ventanaSemanaSiguiente(hoyStr);
  console.log(`[feriados] Ventana semana siguiente: ${ventana.lunes} a ${ventana.domingo}`);

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id, owner_id');

  if (error) {
    console.error('[feriados] Error listando empresas:', error.message);
    return;
  }

  console.log(`[feriados] Empresas encontradas: ${empresas.length}`);

  let totalNuevos = 0;
  let totalIdempotentes = 0;

  for (const empresa of empresas) {
    try {
      const { nuevos, idempotentes } = await generarParaEmpresa(
        empresa.id,
        empresa.owner_id,
        hoyStr,
        supabase
      );
      totalNuevos += nuevos;
      totalIdempotentes += idempotentes;
    } catch (err) {
      console.error(`[feriados] Error en empresa ${empresa.id}:`, err.message);
    }
  }

  console.log(`[feriados] Fin — nuevos: ${totalNuevos}, idempotentes: ${totalIdempotentes}`);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  hoyChile,
  clasificarFeriados,
  listaFeriados,
  notaFeriados,
  armarMensaje,
  generarParaEmpresa,
  generarRecordatoriosFeriados,
};
