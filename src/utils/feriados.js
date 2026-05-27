// src/utils/feriados.js
// Utilidades de días hábiles y feriados chilenos.
// Todas las fechas se manejan como strings 'YYYY-MM-DD' y se parsean con
// el constructor new Date(año, mes-1, dia) para evitar el corrimiento de
// timezone que produce new Date('YYYY-MM-DD') (interpretado como UTC).

// ─── Helpers internos ────────────────────────────────────────────────────────

/**
 * Parsea 'YYYY-MM-DD' a { año, mes, dia } numéricos.
 * Lanza si el formato es inválido.
 */
function parsearFecha(fecha) {
  const str = typeof fecha === 'string' ? fecha : formatear(fecha);
  const partes = str.split('-');
  if (partes.length !== 3) throw new Error(`Formato de fecha inválido: ${str}`);
  const año = Number(partes[0]);
  const mes = Number(partes[1]);
  const dia = Number(partes[2]);
  if (!año || !mes || !dia) throw new Error(`Fecha con componentes inválidos: ${str}`);
  return { año, mes, dia };
}

/**
 * Convierte { año, mes, dia } a string 'YYYY-MM-DD'.
 */
function formatearPartes({ año, mes, dia }) {
  return `${año}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Convierte un Date a 'YYYY-MM-DD' usando fecha LOCAL (no UTC).
 */
function formatear(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Crea un Date LOCAL a partir de componentes. Evita el bug de timezone
 * porque new Date(año, mes-1, dia) construye en hora local, no UTC.
 */
function crearDateLocal({ año, mes, dia }) {
  return new Date(año, mes - 1, dia);
}

/**
 * Avanza un día sobre las partes { año, mes, dia } y retorna nuevas partes.
 * Usa Date local para el acarreo de mes/año.
 */
function avanzarUnDia({ año, mes, dia }) {
  const d = crearDateLocal({ año, mes, dia });
  d.setDate(d.getDate() + 1);
  return { año: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() };
}

// ─── Funciones públicas ──────────────────────────────────────────────────────

/**
 * ¿La fecha cae en un feriado registrado en la BD?
 * @param {string|Date} fecha  'YYYY-MM-DD' o Date
 * @param {object}      supabase  cliente Supabase ya creado
 * @returns {Promise<boolean>}
 */
async function esFeriado(fecha, supabase) {
  const str = typeof fecha === 'string' ? fecha : formatear(fecha);
  const { data, error } = await supabase
    .from('feriados')
    .select('id')
    .eq('fecha', str)
    .limit(1);
  if (error) throw new Error(`Error consultando feriados: ${error.message}`);
  return data.length > 0;
}

/**
 * ¿La fecha cae sábado (6) o domingo (0)?
 * Parsea el string a partes y construye un Date local para obtener getDay()
 * de forma segura, sin el corrimiento UTC.
 * @param {string|Date} fecha  'YYYY-MM-DD' o Date
 * @returns {boolean}
 */
function esFinDeSemana(fecha) {
  const p = parsearFecha(fecha);
  const dow = crearDateLocal(p).getDay(); // 0=dom, 6=sáb
  return dow === 0 || dow === 6;
}

/**
 * ¿La fecha es inhábil? (fin de semana O feriado)
 * @param {string|Date} fecha
 * @param {object}      supabase
 * @returns {Promise<boolean>}
 */
async function esDiaInhabil(fecha, supabase) {
  if (esFinDeSemana(fecha)) return true;
  return esFeriado(fecha, supabase);
}

/**
 * Retorna la misma fecha si es hábil, o la primera fecha hábil siguiente.
 *
 * Optimización: trae de la BD todos los feriados del rango relevante en UNA
 * query (el mes de la fecha + el mes siguiente) y evalúa en memoria, evitando
 * N queries en el loop de avance.
 *
 * @param {string|Date} fecha
 * @param {object}      supabase
 * @returns {Promise<string>} 'YYYY-MM-DD'
 */
async function siguienteDiaHabil(fecha, supabase) {
  let partes = parsearFecha(fecha);

  // Traer feriados de los dos meses relevantes (el actual y el siguiente)
  // para no hacer una query por cada día del loop.
  const desdeStr = formatearPartes(partes);
  const hastaPartes = siguienteMesFin(partes);
  const hastaStr = formatearPartes(hastaPartes);

  const { data: feriadosData, error } = await supabase
    .from('feriados')
    .select('fecha')
    .gte('fecha', desdeStr)
    .lte('fecha', hastaStr);
  if (error) throw new Error(`Error consultando feriados: ${error.message}`);

  const setFeriados = new Set(feriadosData.map(f => f.fecha));

  // Avanzar día por día hasta encontrar un hábil (máx 15 iteraciones razonables)
  const MAX_ITER = 15;
  for (let i = 0; i < MAX_ITER; i++) {
    const str = formatearPartes(partes);
    const dow = crearDateLocal(partes).getDay();
    const esFinde = dow === 0 || dow === 6;
    const esFer = setFeriados.has(str);
    if (!esFinde && !esFer) return str;
    partes = avanzarUnDia(partes);
  }

  // Fallback defensivo: si en 15 días no encontró hábil, algo está muy mal.
  throw new Error(`No se encontró día hábil en 15 días desde ${formatearPartes(parsearFecha(fecha))}`);
}

/**
 * Retorna el último día del mes siguiente al de las partes dadas.
 * Esto define el rango de la query de feriados en siguienteDiaHabil.
 */
function siguienteMesFin({ año, mes }) {
  let mesSig = mes + 1;
  let añoSig = año;
  if (mesSig > 12) { mesSig = 1; añoSig++; }
  // Último día del mesSig: día 0 del mes siguiente al siguiente
  const d = new Date(añoSig, mesSig, 0); // mes es 1-based, pero Date(y,m,0) = último día de m-1... usamos mesSig directamente
  return { año: añoSig, mes: mesSig, dia: d.getDate() };
}

// ─── Días de la semana en español (0=domingo … 6=sábado) ────────────────────
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Nombre del día de la semana en español, en minúscula.
 * Mismo patrón timezone-safe que esFinDeSemana.
 * @param {string|Date} fecha  'YYYY-MM-DD' o Date
 * @returns {string} 'lunes', 'martes', 'miércoles', etc.
 */
function nombreDiaSemana(fecha) {
  const p = parsearFecha(fecha);
  const dow = crearDateLocal(p).getDay(); // 0=dom, 6=sáb
  return DIAS_SEMANA[dow];
}

/**
 * Calcula la ventana lunes–domingo de la SEMANA SIGUIENTE a la de hoyStr.
 * "Semana siguiente" = semana calendario (lun–dom) que viene después de la
 * semana actual, sin importar en qué día de la semana estemos.
 *
 * Algoritmo:
 *   1. dow = getDay() de hoy (0=dom … 6=sáb)
 *   2. lunesEstaSemana = hoy − (dow===0 ? 6 : dow−1) días
 *   3. lunesSiguiente  = lunesEstaSemana + 7
 *   4. domingoSiguiente = lunesSiguiente + 6
 *
 * @param {string} hoyStr  'YYYY-MM-DD' (hoy en Chile)
 * @returns {{ lunes: string, domingo: string }}
 */
function ventanaSemanaSiguiente(hoyStr) {
  const p = parsearFecha(hoyStr);
  const hoyDate = crearDateLocal(p);
  const dow = hoyDate.getDay(); // 0=dom, 6=sáb

  // Retroceder al lunes de esta semana
  const diasHastaLunes = dow === 0 ? 6 : dow - 1;
  const lunesEstaSemana = new Date(hoyDate);
  lunesEstaSemana.setDate(hoyDate.getDate() - diasHastaLunes);

  // Avanzar 7 días → lunes de la semana siguiente
  const lunesSig = new Date(lunesEstaSemana);
  lunesSig.setDate(lunesEstaSemana.getDate() + 7);

  // +6 días → domingo de la semana siguiente
  const domingoSig = new Date(lunesSig);
  domingoSig.setDate(lunesSig.getDate() + 6);

  return {
    lunes:   formatearPartes({ año: lunesSig.getFullYear(),   mes: lunesSig.getMonth() + 1,   dia: lunesSig.getDate() }),
    domingo: formatearPartes({ año: domingoSig.getFullYear(), mes: domingoSig.getMonth() + 1, dia: domingoSig.getDate() }),
  };
}

/**
 * Retorna los feriados entre dos fechas (inclusive), útil para avisos de
 * "semana corta" o listados.
 * @param {string} fechaInicio  'YYYY-MM-DD'
 * @param {string} fechaFin     'YYYY-MM-DD'
 * @param {object} supabase
 * @returns {Promise<Array<{fecha: string, nombre: string}>>}
 */
async function feriadosEntre(fechaInicio, fechaFin, supabase) {
  const { data, error } = await supabase
    .from('feriados')
    .select('fecha, nombre')
    .gte('fecha', fechaInicio)
    .lte('fecha', fechaFin)
    .order('fecha', { ascending: true });
  if (error) throw new Error(`Error consultando feriados: ${error.message}`);
  return data;
}

module.exports = {
  esFeriado,
  esFinDeSemana,
  esDiaInhabil,
  siguienteDiaHabil,
  nombreDiaSemana,
  ventanaSemanaSiguiente,
  feriadosEntre,
};
