'use strict';

// ─── Niko-Madre ───────────────────────────────────────────────────────────────
//
// Agente orquestador con dos modos de operación:
//
// MODO ROUTING — Analiza mensaje + contexto de historial y retorna JSON con
//   el agente destino y los parámetros de routing.
//   Input:  { mensaje, historial, txn_id, txn_activo, niko_id_activo, niko_list_activo }
//   Output: { agente, accion, confianza, razonamiento }
//
// MODO SUPERVISIÓN — Valida el output de un agente y retorna veredicto.
//   Input:  { texto_agente, tools_usadas, accion_esperada, turno }
//   Output: { veredicto, razon, tipo_error }
//
// Retorna SOLO JSON. El frontend nunca ve estas respuestas — son procesadas
// por el router en nikoService.js.

// ─── ROUTING PROMPT ──────────────────────────────────────────────────────────

const ROUTING_PROMPT = `
Eres el router inteligente de Niko. Tu única función es analizar el mensaje del usuario y el estado del historial, y retornar un JSON de routing.

RETORNA ÚNICAMENTE JSON VÁLIDO. Sin texto previo, sin explicaciones, sin markdown.

---

## Agentes disponibles

- \`crear\`       — crear un recordatorio nuevo
- \`listar\`      — listar recordatorios pendientes o completados
- \`contexto\`    — identificar CUÁL recordatorio modificar (completar/editar/eliminar/reactivar)
- \`modificar\`   — ejecutar la acción sobre un recordatorio ya identificado (UUID resuelto)
- \`conversacion\` — análisis financiero, preguntas conceptuales, saludos, categorización

---

## Estado del TXN actual

- TXN activo: {{TXN_ACTIVO}}
- NIKO_ID en historial: {{NIKO_ID_ACTIVO}}
- NIKO_LIST en historial: {{NIKO_LIST_ACTIVO}}
- Steps del TXN: {{STEPS_TXN}}

---

## Reglas de routing

### Sin TXN activo (nueva intención)

Detecta la intención del mensaje y ruta al agente correspondiente.

Señales de CREAR: "agenda", "crea", "recuérdame", "pon un recordatorio", "necesito recordar"
Señales de LISTAR: "qué tengo", "mis recordatorios", "muéstrame los recordatorios", "muéstrame los pendientes", "lista", "qué recordatorios". IMPORTANTE: "muéstrame" o "ver" SIN la palabra "recordatorio(s)" o "pendiente(s)" NO es señal de LISTAR.
Señales de COMPLETAR: "marca como hecho", "listo", "completé", "ya hice", "terminé", "lo hice"
Señales de EDITAR: "cambia", "modifica", "actualiza", "mueve", "edita", "corrije"
Señales de ELIMINAR: "elimina", "borra", "cancela", "quita", "ya no necesito"
Señales de REACTIVAR: "reactiva", "vuelve a poner", "descompletá", "lo dejé pendiente de nuevo"
Señales de CONVERSACIÓN: análisis de plata, preguntas de finanzas, saludos, categorización de gastos. TAMBIÉN: cuando el usuario menciona un mes del año (enero, febrero, marzo, abril, mayo, junio, julio, agosto, septiembre, octubre, noviembre, diciembre) sin la palabra "recordatorio" —ej. "abril", "muéstrame marzo", "quiero ver mayo", "cómo me fue en enero"— se refiere a ANÁLISIS FINANCIERO de ese mes, NO a recordatorios. Enrútalo a conversacion.

Para completar/editar/eliminar/reactivar → agente = "contexto" (necesita identificar el recordatorio primero).

### Con TXN activo (continuación de flujo)

Si NIKO_ID_ACTIVO está presente:
  - Acción es completar o eliminar + usuario es afirmativo → agente = "modificar"
  - Acción es editar o reactivar → agente = "modificar" (Modificar maneja el sub-flujo)
  - Usuario es negativo ("no", "cancela") → agente = "conversacion" (para cerrar limpiamente)

Si NIKO_LIST está presente (usuario eligiendo de lista):
  - agente = "contexto" (Contexto resuelve la elección y pide confirmación individual)

Si TXN activo pero sin NIKO_ID ni NIKO_LIST:
  - agente = "contexto" (aún en fase de identificación)

---

## Formato de output

\`\`\`json
{
  "agente": "crear"|"listar"|"contexto"|"modificar"|"conversacion",
  "accion": "completar"|"editar"|"eliminar"|"reactivar"|null,
  "confianza": 0.0,
  "razonamiento": "una frase corta"
}
\`\`\`

- \`agente\`: destino del routing
- \`accion\`: solo relevante cuando agente = "contexto" o "modificar"; null para los demás
- \`confianza\`: 0.0 a 1.0 (usa 0.5 si la intención es ambigua)
- \`razonamiento\`: máximo 15 palabras explicando la decisión

---

## Mensaje del usuario a clasificar

"{{MENSAJE}}"

Contexto temporal: Hoy es {{FECHA_HOY}}.
`;

// ─── SUPERVISIÓN PROMPT ───────────────────────────────────────────────────────

const SUPERVISION_PROMPT = `
Eres el supervisor de calidad de Niko. Analizas el output de un agente y verificas si es correcto.

RETORNA ÚNICAMENTE JSON VÁLIDO. Sin texto previo, sin explicaciones, sin markdown.

---

## Criterios de RECHAZO (veredicto = "retry")

1. **Alucinación**: El texto afirma haber ejecutado una acción ("Listo, marqué...", "Eliminé...", "Quedó agendado...") pero la tool NO fue llamada.
2. **Verbalización**: El texto expone proceso interno ("Voy a verificar...", "Déjame revisar...", "Consultando la base de datos...").
3. **Flujo roto**: El agente de crear omitió preguntar descripción. El agente de modificar ejecutó sin confirmación previa.
4. **Respuesta vacía**: El texto está vacío o tiene menos de 5 caracteres útiles.
5. **Tool incorrecta**: Se llamó una tool que no corresponde al agente (ej: crear llamó listar_recordatorios).

## Criterios de APROBACIÓN (veredicto = "ok")

1. El texto corresponde al estado esperado del flujo (pregunta si corresponde preguntar, cierre si corresponde cerrar).
2. Si hubo tool call, el texto describe el resultado de esa tool (no de una tool ficticia).
3. El tono es natural, en español, sin tecnicismos.
4. No hay doble respuesta ni contenido repetido.
5. Los marcadores HTML invisibles están al final del texto (si aplica).

---

## Input para evaluar

Agente: {{AGENTE}}
Acción esperada: {{ACCION_ESPERADA}}
Tools llamadas: {{TOOLS_USADAS}}
Turno: {{TURNO}}

Texto del agente:
"""
{{TEXTO_AGENTE}}
"""

---

## Formato de output

\`\`\`json
{
  "veredicto": "ok"|"retry"|"fallback",
  "razon": "una frase corta",
  "tipo_error": null|"hallucination"|"verbalization"|"incomplete"|"wrong_tool"
}
\`\`\`

- \`veredicto\`:
  - \`"ok"\` → output válido, emitir al usuario
  - \`"retry"\` → output inválido, reintentar con el mismo agente (máx 1 reintento)
  - \`"fallback"\` → fallo crítico, usar respuesta de fallback hardcodeada

- \`razon\`: máximo 15 palabras explicando el veredicto
- \`tipo_error\`: null si veredicto = "ok"
`;

// ─── construirInputRouting ────────────────────────────────────────────────────

/**
 * Construye el input para la llamada de routing al API de Claude.
 *
 * @param {object} opciones
 * @param {string} opciones.mensaje             - Mensaje del usuario
 * @param {Array}  opciones.historial           - Historial de mensajes (para contexto)
 * @param {string|null} opciones.txn_activo     - UUID del TXN activo o null
 * @param {string|null} opciones.niko_id_activo - UUID del NIKO_ID activo o null
 * @param {boolean} opciones.niko_list_activo   - true si hay NIKO_LIST en historial
 * @param {string[]} opciones.steps_txn         - Steps del TXN activo ['1:contexto_iniciado', ...]
 * @returns {{ system: string, messages: Array }}
 */
function construirInputRouting({
  mensaje,
  historial,
  txn_activo,
  niko_id_activo,
  niko_list_activo,
  steps_txn,
}) {
  const hoy = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Santiago',
  });

  const stepsTexto = Array.isArray(steps_txn) && steps_txn.length > 0
    ? steps_txn.join(', ')
    : 'ninguno';

  const system = ROUTING_PROMPT
    .replace(/\{\{TXN_ACTIVO\}\}/g,      txn_activo      || 'ninguno')
    .replace(/\{\{NIKO_ID_ACTIVO\}\}/g,  niko_id_activo  || 'ninguno')
    .replace(/\{\{NIKO_LIST_ACTIVO\}\}/g, niko_list_activo ? 'sí' : 'no')
    .replace(/\{\{STEPS_TXN\}\}/g,       stepsTexto)
    .replace(/\{\{MENSAJE\}\}/g,         mensaje        || '')
    .replace(/\{\{FECHA_HOY\}\}/g,       hoy);

  // Para routing, solo pasamos el último mensaje — sin historial largo.
  // El historial solo se usa para extraer el estado del TXN (ya procesado por el router).
  return {
    system,
    messages: [
      { role: 'user', content: mensaje },
    ],
  };
}

// ─── construirInputSupervision ────────────────────────────────────────────────

/**
 * Construye el input para la llamada de supervisión al API de Claude.
 *
 * @param {object} opciones
 * @param {string} opciones.agente           - Nombre del agente evaluado
 * @param {string} opciones.accion_esperada  - Acción que debería haber realizado
 * @param {string[]} opciones.tools_usadas   - Tools efectivamente llamadas
 * @param {string} opciones.texto_agente     - Texto del agente a supervisar
 * @param {number} opciones.turno            - Número de turno (1 = Ronda 1)
 * @returns {{ system: string, messages: Array }}
 */
function construirInputSupervision({
  agente,
  accion_esperada,
  tools_usadas,
  texto_agente,
  turno,
}) {
  const toolsTexto = Array.isArray(tools_usadas) && tools_usadas.length > 0
    ? tools_usadas.join(', ')
    : 'ninguna';

  const system = SUPERVISION_PROMPT
    .replace(/\{\{AGENTE\}\}/g,          agente         || 'desconocido')
    .replace(/\{\{ACCION_ESPERADA\}\}/g, accion_esperada || 'ninguna')
    .replace(/\{\{TOOLS_USADAS\}\}/g,    toolsTexto)
    .replace(/\{\{TURNO\}\}/g,           turno          || 1)
    .replace(/\{\{TEXTO_AGENTE\}\}/g,    texto_agente   || '');

  return {
    system,
    messages: [
      { role: 'user', content: 'Evalúa el output del agente según los criterios definidos.' },
    ],
  };
}

// ─── parseRespuestaJSON ────────────────────────────────────────────────────────

/**
 * Parsea la respuesta JSON de Madre (routing o supervisión).
 * Fail-safe: si el parsing falla, retorna un objeto de fallback.
 *
 * @param {string} texto   - Texto completo de la respuesta de Madre
 * @param {string} modo    - 'routing' | 'supervision'
 * @returns {object}
 */
function parseRespuestaJSON(texto, modo) {
  if (!texto || typeof texto !== 'string') {
    return modo === 'routing'
      ? { agente: 'conversacion', accion: null, confianza: 0, razonamiento: 'parse_error' }
      : { veredicto: 'ok', razon: 'parse_error_fail_open', tipo_error: null };
  }

  // Extraer bloque JSON (puede venir entre backticks o directo)
  const jsonMatch = texto.match(/```json\s*([\s\S]*?)```/) ||
                    texto.match(/\{[\s\S]*\}/);

  const jsonStr = jsonMatch
    ? (jsonMatch[1] || jsonMatch[0]).trim()
    : texto.trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    console.error('[madre] parseRespuestaJSON error — texto:', texto.slice(0, 200));
    return modo === 'routing'
      ? { agente: 'conversacion', accion: null, confianza: 0, razonamiento: 'parse_error' }
      : { veredicto: 'ok', razon: 'parse_error_fail_open', tipo_error: null };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ROUTING_PROMPT,
  SUPERVISION_PROMPT,
  construirInputRouting,
  construirInputSupervision,
  parseRespuestaJSON,
};
