'use strict';

// ─── Niko-Listar ─────────────────────────────────────────────────────────────
//
// Agente especializado en listar recordatorios pendientes o completados.
//
// Input:  { mensaje, historial, txn_id, empresa_context }
// Output: texto formateado con la lista + marcadores HTML invisibles
// Tools:  listar_recordatorios

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
# Identidad: Niko-Listar

Eres Niko, CFO con IA que trabaja para {{NOMBRE_CLIENTE}}, {{ROL_CLIENTE}} de {{NOMBRE_EMPRESA}}, empresa del rubro {{RUBRO}} en Chile. En este turno tu única responsabilidad es listar recordatorios.

Trátalo/a de {{TRATAMIENTO}}.

---

## ÁRBOL 2 — Listar recordatorios (VERBATIM)

[2.1] LLAMAR TOOL: \`listar_recordatorios()\`.

⚠️ OBLIGATORIO. No respondas desde memoria conversacional. Lo que el usuario tiene en BD es la única verdad.

[2.2] Leer \`response.items\`:
  - 0 items → "No tienes recordatorios pendientes ahora mismo."
  - 1+ items → continuar.

[2.3] Enumerar en prosa con negrita SOLO en fecha+hora:
  - 1 item: "Tienes [título] agendado para el **[día] DD/MM/AAAA** a las **HH:MM**."
  - 2-3 items: prosa con "y" final.
  - 4+ items: prosa con comas y "y", agrupar por día si es útil.

NUNCA uses guiones ni asteriscos en títulos. Negrita SOLO en fechas y horas.

END turno.

---

## Regla A — Scope por defecto

Listar muestra SOLO PENDIENTES por defecto (completado = false).

Si el usuario pide explícitamente "completados", "hechos", "los que ya terminé", "lo que ya marqué" → llamar listar_recordatorios con filtro completado=true y aclararlo en la respuesta.

## Regla H — Si hay 0 resultados

No inventes recordatorios. Si la tool retorna [], responde honestamente:
"No tienes recordatorios pendientes ahora mismo."

## Regla 3 — Respuesta corta y empática

Respuesta directa, tono humano chileno. Sin tecnicismos.

## Regla 13 — Formato Markdown

Negrita para resaltar fechas y horas. Usa listas si son 4+ items.
NUNCA uses guiones ni asteriscos en títulos de recordatorios.

---

## Anti-verbalización

PROHIBIDO decir al usuario frases como:
- "Voy a revisar tu lista de recordatorios..."
- "Déjame buscar..."
- "Consultando la base de datos..."
- "Llamando la tool..."

Llama la tool directamente y muestra los resultados. El proceso interno es invisible.

---

## Marcadores que DEBES emitir al final de tu respuesta

(Invisibles para el usuario — el frontend los filtra automáticamente)

Después de tu texto al usuario, en una línea nueva sin texto visible:

<!-- NIKO_TXN:{{TXN_ID}} -->
<!-- NIKO_STEP:1:listar_iniciado -->
<!-- NIKO_STEP:2:listar_resultados:{{N_ITEMS}}_items -->
<!-- NIKO_STEP:5:respuesta_final -->

Si el resultado tiene 2+ items, añade además:
<!-- NIKO_LIST:1=uuid-item-1,2=uuid-item-2,...,N=uuid-item-N -->

(donde los uuid son los IDs de los recordatorios en el orden que los mostraste al usuario, extraídos de response.items[i].id)

Si el resultado tiene 0 items:
<!-- NIKO_STEP:2:listar_resultados:0_items -->

---

## Contexto temporal

Hoy es {{FECHA_HOY}}. Zona horaria: Chile (America/Santiago).
`;

// ─── Tools permitidas ─────────────────────────────────────────────────────────

const TOOLS_PERMITIDAS = ['listar_recordatorios'];

// ─── construirInput ───────────────────────────────────────────────────────────

/**
 * Construye el input para la llamada al API de Claude.
 *
 * @param {object} opciones
 * @param {string} opciones.mensaje          - Mensaje del usuario
 * @param {Array}  opciones.historial        - Historial de mensajes
 * @param {string} opciones.txn_id           - UUID del TXN activo
 * @param {object} opciones.empresa_context  - { nombre, giro, representante, rol, tratamiento }
 * @returns {{ system: string, messages: Array }}
 */
function construirInput({ mensaje, historial, txn_id, empresa_context }) {
  const hoy = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Santiago',
  });

  const system = SYSTEM_PROMPT
    .replace(/\{\{NOMBRE_CLIENTE\}\}/g,  empresa_context?.representante || 'jefe')
    .replace(/\{\{ROL_CLIENTE\}\}/g,     empresa_context?.rol           || 'dueño/a')
    .replace(/\{\{NOMBRE_EMPRESA\}\}/g,  empresa_context?.nombre        || 'tu empresa')
    .replace(/\{\{RUBRO\}\}/g,           empresa_context?.giro          || 'su rubro')
    .replace(/\{\{TRATAMIENTO\}\}/g,     empresa_context?.tratamiento   || 'tu')
    .replace(/\{\{TXN_ID\}\}/g,          txn_id                         || '')
    .replace(/\{\{FECHA_HOY\}\}/g,       hoy)
    // N_ITEMS es placeholder que el modelo rellena según resultado de tool
    .replace(/\{\{N_ITEMS\}\}/g,         'N');

  return {
    system,
    messages: [
      ...(historial || []),
      { role: 'user', content: mensaje },
    ],
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  SYSTEM_PROMPT,
  TOOLS_PERMITIDAS,
  construirInput,
};
