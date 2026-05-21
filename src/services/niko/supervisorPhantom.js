'use strict';

// ─── Supervisor Anti-Phantom — funciones puras de detección ──────────────────
// Sin I/O. Sin llamadas al modelo. Sin estado. Solo análisis de strings/arrays.
// NO se conecta a chatWithNikoStream en este bloque — se valida en aislamiento.

const WRITE_TOOLS = ['crear_recordatorio', 'actualizar_recordatorio', 'eliminar_recordatorio'];

// Afirmación de éxito de escritura (lo que Niko dice cuando phantomea).
const WRITE_AFFIRMATION_REGEX = /listo[,\s]+(marqué|eliminé|reactivé|quedó\s+agendado|agendé|cambié|lo\s+eliminé)|hecho[,\s]+(lo\s+eliminé|cambié|marqué)|^eliminado[.,!]?\s*$/im;

// Pregunta de confirmación FINAL (no intermedia).
const PREGUNTA_FINAL_REGEX = /¿(lo\s+marco|confirmas?\s+(que\s+lo\s+)?|lo\s+reactivo\s+con|lo\s+elim|elimin)/i;

// Confirmación estricta del usuario (no selección tipo "el 1").
const CONFIRMACION_ESTRICTA_REGEX = /^(sí|si|dale|ok|listo|confirma|perfecto|bueno|ya|correcto|sí\s+po|sipo|claro)[.,!]?\s*$/i;

// Declinar la nota en flujo crear.
const DECLINA_NOTA_REGEX = /^(nada|no|sin\s+(descripción|descripcion|nota)|igual|así\s+está|asi\s+esta|sin\s+más|sin\s+mas)[.,!]?\s*$/i;

// Intención de crear + fecha exacta en el mensaje actual (Condición 3).
const INTENT_CREAR_REGEX = /\b(agéndame|agendame|créame|creame|crea\s+un|anótame|anotame|recuérdame|recuerdame|anota|registra)\b/i;
const FECHA_EXACTA_REGEX = /\b(\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?|\d{1,2}\s+de\s+[a-záéíóúñ]+)\b/i;

// Marcador de id.
const NIKO_ID_REGEX = /<!--\s*NIKO_ID:([0-9a-f\-]{36})\s*-->/i;

// ── Extrae el NIKO_ID activo del ÚLTIMO mensaje assistant + infiere la tool esperada ──
function extraerNikoIdActivo(historial) {
  if (!Array.isArray(historial)) return null;
  let ultimoAssistant = null;
  for (let i = historial.length - 1; i >= 0; i--) {
    if (historial[i] && historial[i].role === 'assistant') { ultimoAssistant = historial[i]; break; }
  }
  if (!ultimoAssistant) return null;
  const texto = typeof ultimoAssistant.content === 'string' ? ultimoAssistant.content : '';
  const match = texto.match(NIKO_ID_REGEX);
  if (!match) return null;
  const uuid = match[1];

  // Inferir la tool esperada desde el texto del último assistant.
  let toolEsperada = null;
  if (/¿(lo\s+marco|confirmas?.*completar|marco.*completad)/i.test(texto)) toolEsperada = 'actualizar_recordatorio';
  else if (/confirmas?\s+(que\s+)?lo\s+elimin|¿lo\s+elimin/i.test(texto)) toolEsperada = 'eliminar_recordatorio';
  else if (/reactiv/i.test(texto)) toolEsperada = 'actualizar_recordatorio';
  else toolEsperada = 'actualizar_recordatorio'; // default seguro para acciones con NIKO_ID

  return { uuid, toolEsperada };
}

function esPreguntaConfirmacionFinal(texto) {
  if (typeof texto !== 'string') return false;
  return PREGUNTA_FINAL_REGEX.test(texto);
}

function esRespuestaConfirmatoria(mensaje) {
  if (typeof mensaje !== 'string') return false;
  return CONFIRMACION_ESTRICTA_REGEX.test(mensaje.trim());
}

function esContextoNotaSkip(historial, mensajeActual) {
  if (!Array.isArray(historial) || typeof mensajeActual !== 'string') return false;
  let ultimoAssistant = null;
  for (let i = historial.length - 1; i >= 0; i--) {
    if (historial[i] && historial[i].role === 'assistant') { ultimoAssistant = historial[i]; break; }
  }
  if (!ultimoAssistant) return false;
  const texto = typeof ultimoAssistant.content === 'string' ? ultimoAssistant.content : '';
  const preguntoNota = /¿le\s+agregamos|descripción|descripcion|alguna\s+nota/i.test(texto);
  return preguntoNota && DECLINA_NOTA_REGEX.test(mensajeActual.trim());
}

function esContextoCrearDirecto(mensajeActual) {
  if (typeof mensajeActual !== 'string') return false;
  return INTENT_CREAR_REGEX.test(mensajeActual) && FECHA_EXACTA_REGEX.test(mensajeActual);
}

// Regex de verbos de acción INEQUÍVOCOS sobre recordatorios existentes.
// Excluye actualiza/modifica/cambia (ambiguos: aplican a empresa, datos, etc.).
const INTENT_MODIFICAR_REGEX = /\b(elimina|elimíname|eliminame|borra|bórrame|borrame|completa|complétame|completame|marca\s+como|reactiva|reactívame|reactivame)\b/i;

// ¿El usuario pide una acción sobre un recordatorio existente Y todavía NO hay
// NIKO_ID en el historial? Entonces es el TURNO DE IDENTIFICACIÓN: hay que forzar
// listar_recordatorios para que el UUID venga de la DB (no de memoria/alucinación).
function esIntentModificarSinId(historial, mensajeActual) {
  if (typeof mensajeActual !== 'string') return false;
  const tieneIntent = INTENT_MODIFICAR_REGEX.test(mensajeActual);
  if (!tieneIntent) return false;
  // Solo aplica si NO hay NIKO_ID activo (si ya hay, estamos en turno 2, no identificación).
  const tieneNikoId = extraerNikoIdActivo(historial) !== null;
  return !tieneNikoId;
}

// Detecta si el último mensaje de Niko preguntó por la nota (independiente de la respuesta del usuario).
function preguntoNota(historial) {
  if (!Array.isArray(historial)) return false;
  let ultimoAssistant = null;
  for (let i = historial.length - 1; i >= 0; i--) {
    if (historial[i] && historial[i].role === 'assistant') { ultimoAssistant = historial[i]; break; }
  }
  if (!ultimoAssistant) return false;
  const texto = typeof ultimoAssistant.content === 'string' ? ultimoAssistant.content : '';
  return /¿le\s+agregamos|descripción|descripcion|alguna\s+nota/i.test(texto);
}

// Criterio amplio para activar el buffer de streaming (cualquier posible escritura).
// Incluye: NIKO_ID activo, pregunta de nota (declive O contenido), o crear directo.
function esContextoDeEscritura(historial, mensajeActual) {
  const tieneNikoId = extraerNikoIdActivo(historial) !== null;
  return tieneNikoId || preguntoNota(historial) || esContextoCrearDirecto(mensajeActual);
}

// Detección de phantom: afirmó éxito de escritura PERO no hubo tool de escritura.
function esPhantomDeEscritura(texto, toolsUsadas) {
  if (typeof texto !== 'string' || !Array.isArray(toolsUsadas)) return false;
  const noHuboEscritura = toolsUsadas.every(t => !WRITE_TOOLS.includes(t));
  return noHuboEscritura && WRITE_AFFIRMATION_REGEX.test(texto);
}

module.exports = {
  WRITE_TOOLS,
  extraerNikoIdActivo,
  esPreguntaConfirmacionFinal,
  esRespuestaConfirmatoria,
  esContextoNotaSkip,
  preguntoNota,
  esContextoCrearDirecto,
  esIntentModificarSinId,
  esContextoDeEscritura,
  esPhantomDeEscritura,
};
