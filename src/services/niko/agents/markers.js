'use strict';

// ─── Lectura/escritura de marcadores HTML invisibles ─────────────────────────
//
// Funciones puras sin side effects. No llaman APIs, no tocan BD.
//
// Marcadores soportados:
//   <!-- NIKO_TXN:uuid-v4 -->
//   <!-- NIKO_STEP:N:descripcion -->
//   <!-- NIKO_ID:uuid-recordatorio -->
//   <!-- NIKO_LIST:1=uuid1,2=uuid2,...,N=uuidN -->
//
// El frontend filtra todos los marcadores en render (<!--[\s\S]*?-->/g),
// pero los conserva en msg.texto para que el historial los propague al backend.
//
// Diseño documentado en Fase A — Sistema Dual de Marcadores.

const crypto = require('crypto');

// ── Regex patterns ─────────────────────────────────────────────────────────────

const REGEX_TXN      = /<!--\s*NIKO_TXN:([a-f0-9-]{36})\s*-->/i;
const REGEX_STEP_G   = /<!--\s*NIKO_STEP:(\d+):([^>]+?)\s*-->/gi;
const REGEX_STEP_ONE = /<!--\s*NIKO_STEP:(\d+):([^>]+?)\s*-->/i;
const REGEX_ID       = /<!--\s*NIKO_ID:([a-f0-9-]{36})\s*-->/i;
const REGEX_LIST     = /<!--\s*NIKO_LIST:([^>]+?)\s*-->/i;
const REGEX_ANY      = /<!--[\s\S]*?-->/g;

// ─── UUID válido ───────────────────────────────────────────────────────────────

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function esUuidValido(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Extrae el contenido textual de un mensaje del historial.
 * Normaliza tanto string como content-array (Anthropic API).
 */
function textoDelMensaje(msg) {
  if (!msg || !msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('');
  }
  return '';
}

// ── (1) generarTxnId ──────────────────────────────────────────────────────────

/**
 * Genera un nuevo UUID v4 para identificar un flujo (transacción).
 * @returns {string} UUID v4
 */
function generarTxnId() {
  return crypto.randomUUID();
}

// ── (2) extraerTxnActivo ──────────────────────────────────────────────────────

/**
 * Busca en el historial si hay un TXN activo (sin STEP:5:respuesta_final).
 *
 * Estrategia:
 *  - Recorre los mensajes de más reciente a más antiguo.
 *  - Extrae el último TXN encontrado.
 *  - Si ese TXN tiene STEP:5 → está cerrado → retorna null.
 *  - Si no tiene STEP:5 → está activo → retorna el txnId.
 *
 * @param {Array<{role: string, content: string|Array}>} historial
 * @returns {string|null}
 */
function extraerTxnActivo(historial) {
  if (!Array.isArray(historial) || historial.length === 0) return null;

  // Buscar el TXN más reciente (de atrás hacia adelante)
  let txnId = null;
  for (let i = historial.length - 1; i >= 0; i--) {
    const texto = textoDelMensaje(historial[i]);
    const m = REGEX_TXN.exec(texto);
    if (m && esUuidValido(m[1])) {
      txnId = m[1];
      break;
    }
  }
  if (!txnId) return null;

  // Verificar si ese TXN está cerrado (tiene STEP:5 en cualquier mensaje posterior)
  if (txnEstaCerrado(historial, txnId)) return null;

  return txnId;
}

// ── (3) extraerStepsDelTxn ────────────────────────────────────────────────────

/**
 * Extrae todos los STEP markers de un TXN en orden cronológico.
 *
 * @param {Array} historial
 * @param {string} txnId
 * @returns {string[]} Ej: ['1:listar_iniciado', '2:listar_resultados:1_item', ...]
 */
function extraerStepsDelTxn(historial, txnId) {
  if (!Array.isArray(historial) || !txnId) return [];

  const steps = [];
  // Solo considerar mensajes que contengan este TXN o que sean posteriores
  // al primer mensaje que lo mencione
  let txnEncontrado = false;

  for (const msg of historial) {
    const texto = textoDelMensaje(msg);
    if (!txnEncontrado && texto.includes(txnId)) {
      txnEncontrado = true;
    }
    if (!txnEncontrado) continue;

    // Extraer todos los STEP de este mensaje
    const reStep = new RegExp(REGEX_STEP_G.source, 'gi');
    let match;
    while ((match = reStep.exec(texto)) !== null) {
      steps.push(`${match[1]}:${match[2].trim()}`);
    }
  }

  return steps;
}

// ── (4) extraerNikoIdUltimo ───────────────────────────────────────────────────

/**
 * Busca el último NIKO_ID en los mensajes del TXN activo.
 *
 * @param {Array} historial
 * @param {string} txnId
 * @returns {string|null} UUID del recordatorio o null
 */
function extraerNikoIdUltimo(historial, txnId) {
  if (!Array.isArray(historial) || !txnId) return null;

  let resultado = null;
  let txnEncontrado = false;

  for (const msg of historial) {
    const texto = textoDelMensaje(msg);
    if (!txnEncontrado && texto.includes(txnId)) {
      txnEncontrado = true;
    }
    if (!txnEncontrado) continue;

    const m = REGEX_ID.exec(texto);
    if (m && esUuidValido(m[1])) {
      resultado = m[1]; // sobreescribir: queda el último
    }
  }

  return resultado;
}

// ── (5) extraerNikoListUltimo ─────────────────────────────────────────────────

/**
 * Busca el último NIKO_LIST en los mensajes del TXN activo.
 *
 * @param {Array} historial
 * @param {string} txnId
 * @returns {Object|null} Ej: { '1': 'uuid1', '2': 'uuid2' } o null
 */
function extraerNikoListUltimo(historial, txnId) {
  if (!Array.isArray(historial) || !txnId) return null;

  let resultado = null;
  let txnEncontrado = false;

  for (const msg of historial) {
    const texto = textoDelMensaje(msg);
    if (!txnEncontrado && texto.includes(txnId)) {
      txnEncontrado = true;
    }
    if (!txnEncontrado) continue;

    const m = REGEX_LIST.exec(texto);
    if (m) {
      const mapa = {};
      const pares = m[1].split(',');
      for (const par of pares) {
        const [pos, uuid] = par.trim().split('=');
        if (pos && uuid && esUuidValido(uuid)) {
          mapa[pos.trim()] = uuid.trim();
        }
      }
      if (Object.keys(mapa).length > 0) {
        resultado = mapa; // sobreescribir: queda el último
      }
    }
  }

  return resultado;
}

// ── (6) resolverEleccionDeLista ───────────────────────────────────────────────

/**
 * Dado un NIKO_LIST activo y el mensaje del usuario, resuelve
 * "el 1", "el primero", "2", etc. al UUID correspondiente.
 *
 * @param {Array} historial
 * @param {string} txnId
 * @param {string} mensajeUsuario
 * @returns {string|null} UUID o null si no se puede resolver
 */
function resolverEleccionDeLista(historial, txnId, mensajeUsuario) {
  const lista = extraerNikoListUltimo(historial, txnId);
  if (!lista) return null;

  const msg = mensajeUsuario.toLowerCase().trim();

  // Mapas de palabras ordinales a posición
  const ORDINALES = {
    'primero': '1', 'primera': '1', 'el primero': '1', 'la primera': '1',
    'segundo': '2', 'segunda': '2', 'el segundo': '2', 'la segunda': '2',
    'tercero': '3', 'tercera': '3', 'el tercero': '3', 'la tercera': '3',
    'cuarto':  '4', 'cuarta': '4',  'el cuarto': '4',  'la cuarta': '4',
    'quinto':  '5', 'quinta': '5',  'el quinto': '5',  'la quinta': '5',
  };

  // Buscar ordinal en el mensaje
  for (const [palabra, pos] of Object.entries(ORDINALES)) {
    if (msg.includes(palabra)) {
      return lista[pos] || null;
    }
  }

  // Buscar "el N" o simplemente un número
  const matchNumerico = msg.match(/\bel\s+(\d+)\b|\b(\d+)\b/);
  if (matchNumerico) {
    const pos = matchNumerico[1] || matchNumerico[2];
    return lista[pos] || null;
  }

  return null;
}

// ── (7) construirMarcadores ───────────────────────────────────────────────────

/**
 * Construye el bloque de marcadores HTML para concatenar al final del texto
 * del agente.
 *
 * @param {object} opciones
 * @param {string} opciones.txnId          - UUID del TXN
 * @param {Array}  opciones.steps          - [{numero: 1, descripcion: 'listar_iniciado'}, ...]
 * @param {string} [opciones.nikoId]       - UUID de recordatorio (1 resultado)
 * @param {Object} [opciones.nikoList]     - Mapa {'1': uuid1, '2': uuid2} (N resultados)
 * @returns {string}
 */
function construirMarcadores({ txnId, steps = [], nikoId, nikoList } = {}) {
  const partes = [];

  if (txnId) {
    partes.push(`<!-- NIKO_TXN:${txnId} -->`);
  }

  for (const s of steps) {
    partes.push(`<!-- NIKO_STEP:${s.numero}:${s.descripcion} -->`);
  }

  if (nikoId) {
    partes.push(`<!-- NIKO_ID:${nikoId} -->`);
  }

  if (nikoList && typeof nikoList === 'object' && Object.keys(nikoList).length > 0) {
    const pares = Object.entries(nikoList)
      .map(([pos, uuid]) => `${pos}=${uuid}`)
      .join(',');
    partes.push(`<!-- NIKO_LIST:${pares} -->`);
  }

  if (partes.length === 0) return '';
  return '\n\n' + partes.join('\n');
}

// ── (8) limpiarMarcadoresDeTexto ──────────────────────────────────────────────

/**
 * Elimina todos los marcadores HTML invisibles del texto.
 * Útil para logs, persistencia en BD, o validaciones de contenido.
 *
 * @param {string} texto
 * @returns {string}
 */
function limpiarMarcadoresDeTexto(texto) {
  if (!texto || typeof texto !== 'string') return texto || '';
  return texto.replace(REGEX_ANY, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ── (9) esMensajeAfirmativo ───────────────────────────────────────────────────

/**
 * Detecta si el mensaje del usuario es una confirmación afirmativa.
 * Permisivo: insensible a mayúsculas, tildes, espacios extra.
 *
 * @param {string} mensaje
 * @returns {boolean}
 */
function esMensajeAfirmativo(mensaje) {
  if (!mensaje || typeof mensaje !== 'string') return false;

  const msg = mensaje.toLowerCase()
    .normalize('NFD')                     // descomponer tildes
    .replace(/[\u0300-\u036f]/g, '')      // eliminar diacríticos
    .trim();

  const AFIRMATIVOS = [
    /^\s*si\b/,           // "sí", "si", "si gracias"
    /^\s*dale\b/,         // "dale"
    /^\s*ok\b/,           // "ok", "ok gracias"
    /^\s*perfecto\b/,     // "perfecto"
    /^\s*confirm[ao]\b/,  // "confirmo", "confirma"
    /^\s*yes\b/,          // "yes"
    /^\s*obvio\b/,        // "obvio"
    /^\s*claro\b/,        // "claro", "claro que sí"
    /^\s*por\s+supuesto/, // "por supuesto"
    /^\s*adelante\b/,     // "adelante"
    /^\s*listo\b/,        // "listo"
    /^\s*bueno\b/,        // "bueno"
    /^\s*ya\b/,           // "ya"
    /^\s*hagalo\b/,       // "hágalo"
    /^\s*hazlo\b/,        // "hazlo"
  ];

  return AFIRMATIVOS.some(re => re.test(msg));
}

// ── (10) txnEstaCerrado ───────────────────────────────────────────────────────

/**
 * Verifica si un TXN ya fue cerrado con STEP:5:respuesta_final.
 *
 * @param {Array} historial
 * @param {string} txnId
 * @returns {boolean}
 */
function txnEstaCerrado(historial, txnId) {
  if (!Array.isArray(historial) || !txnId) return false;

  let txnEncontrado = false;

  for (const msg of historial) {
    const texto = textoDelMensaje(msg);
    if (!txnEncontrado && texto.includes(txnId)) {
      txnEncontrado = true;
    }
    if (!txnEncontrado) continue;

    // Buscar STEP:5 en cualquier variante de descripción
    if (/<!--\s*NIKO_STEP:5:[^>]*-->/i.test(texto)) {
      return true;
    }
  }

  return false;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generarTxnId,
  extraerTxnActivo,
  extraerStepsDelTxn,
  extraerNikoIdUltimo,
  extraerNikoListUltimo,
  resolverEleccionDeLista,
  construirMarcadores,
  limpiarMarcadoresDeTexto,
  esMensajeAfirmativo,
  txnEstaCerrado,
};
