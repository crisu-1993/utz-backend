'use strict';

// ─── System Prompt de Niko ────────────────────────────────────────────────────
//
// Placeholders disponibles:
//   {{NOMBRE_CLIENTE}}  → representante_nombre de la empresa
//   {{ROL_CLIENTE}}     → representante_rol (ej: "gerente general", "dueño/a")
//   {{NOMBRE_EMPRESA}}  → nombre de la empresa
//   {{RUBRO}}           → giro de la empresa
//   {{TRATAMIENTO}}     → 'tu' o 'usted' según preferencia del cliente
//
// Para actualizar el texto de Niko, solo editá SYSTEM_PROMPT_TEMPLATE.
// buildSystemPrompt() reemplaza todos los placeholders automáticamente.

const SYSTEM_PROMPT_TEMPLATE = `Sos Niko, el CFO con IA de UTZ Finance trabajando para {{NOMBRE_CLIENTE}}, {{ROL_CLIENTE}} de {{NOMBRE_EMPRESA}}, empresa del rubro {{RUBRO}}.

Tratá al cliente de {{TRATAMIENTO}}.`;

/**
 * Construye el system prompt final reemplazando todos los placeholders.
 *
 * @param {object} datos
 * @param {string} datos.nombreCliente  - Nombre del representante legal
 * @param {string} datos.rolCliente     - Rol del representante (ej: "dueño/a")
 * @param {string} datos.nombreEmpresa  - Nombre de la empresa
 * @param {string} datos.rubro          - Giro / rubro de la empresa
 * @param {string} datos.tratamiento    - 'tu' o 'usted'
 * @returns {string} System prompt con variables reemplazadas
 */
function buildSystemPrompt({ nombreCliente, rolCliente, nombreEmpresa, rubro, tratamiento }) {
  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{NOMBRE_CLIENTE\}\}/g,  nombreCliente)
    .replace(/\{\{ROL_CLIENTE\}\}/g,     rolCliente)
    .replace(/\{\{NOMBRE_EMPRESA\}\}/g,  nombreEmpresa)
    .replace(/\{\{RUBRO\}\}/g,           rubro)
    .replace(/\{\{TRATAMIENTO\}\}/g,     tratamiento);
}

module.exports = { buildSystemPrompt, SYSTEM_PROMPT_TEMPLATE };
