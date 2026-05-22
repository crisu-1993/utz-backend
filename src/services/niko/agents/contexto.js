'use strict';

// ─── Niko-Contexto ────────────────────────────────────────────────────────────
//
// Agente especializado en resolver QUÉ recordatorio quiere modificar el usuario.
// Maneja el flujo de identificación: lista recordatorios, presenta opciones,
// y emite NIKO_ID/NIKO_LIST para que el router lo pase a Niko-Modificar.
//
// Input:  { mensaje, historial, txn_id, empresa_context, accion }
//   accion: 'completar' | 'editar' | 'eliminar' | 'reactivar'
//
// Output: pregunta de identificación + NIKO_ID o NIKO_LIST en marcadores
// Tools:  listar_recordatorios

// ─── Configuración por acción ─────────────────────────────────────────────────

const ACCION_CONFIG = {
  completar: {
    texto:               'COMPLETAR (marcar como hecho)',
    listar_completado:   false,
    sin_items:           'No encuentro recordatorios pendientes para marcar como hecho.',
    pregunta_un_item:    '¿Te refieres a **[título]** del **DD/MM/AAAA** a las **HH:MM**? ¿Confirmas que lo marco como hecho?',
    pregunta_lista:      '¿Cuál quieres marcar como hecho?',
    pregunta_eleccion:   '¿Confirmas que marco **[título]** del **DD/MM/AAAA** a las **HH:MM** como hecho?',
  },
  editar: {
    texto:               'EDITAR (modificar contenido)',
    listar_completado:   false,  // genera listar_recordatorios() sin arg → route devuelve TODOS (pending + completed)
    sin_items:           'No encuentro recordatorios para editar.',
    pregunta_un_item:    '¿Te refieres a **[título]** del **DD/MM/AAAA** a las **HH:MM**? ¿Confirmas que es ese el que quieres editar?',
    pregunta_un_item_completado: 'Ese recordatorio (**[título]** del **DD/MM/AAAA** a las **HH:MM**) ya está completado. ¿Es este el que quieres editar?',
    pregunta_lista:      '¿Cuál quieres editar?',
    pregunta_eleccion:   '¿Confirmas que es **[título]** del **DD/MM/AAAA** a las **HH:MM** el que quieres editar?',
  },
  eliminar: {
    texto:               'ELIMINAR (acción irreversible)',
    listar_completado:   false,
    sin_items:           'No encuentro recordatorios pendientes para eliminar.',
    pregunta_un_item:    '¿Te refieres a **[título]** del **DD/MM/AAAA** a las **HH:MM**? ¿Confirmas que lo elimino?',
    pregunta_lista:      '¿Cuál quieres eliminar?',
    pregunta_eleccion:   '¿Confirmas que elimino **[título]** del **DD/MM/AAAA** a las **HH:MM**?',
  },
  reactivar: {
    texto:               'REACTIVAR (completado → pendiente)',
    listar_completado:   true,
    sin_items:           'No encuentro recordatorios completados para reactivar.',
    pregunta_un_item:    'Encontré **[título]** completado, del **DD/MM/AAAA** a las **HH:MM**. ¿Quieres reactivarlo tal cual o editar algo antes?',
    pregunta_lista:      '¿Cuál quieres reactivar?',
    pregunta_eleccion:   'Encontré **[título]** completado del **DD/MM/AAAA** a las **HH:MM**. ¿Quieres reactivarlo tal cual o editar algo antes?',
  },
};

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
# Identidad: Niko-Contexto

Eres Niko, CFO con IA que trabaja para {{NOMBRE_CLIENTE}}, {{ROL_CLIENTE}} de {{NOMBRE_EMPRESA}}, empresa del rubro {{RUBRO}} en Chile. En este turno tu única responsabilidad es identificar el recordatorio correcto y pedir confirmación al usuario.

Trátalo/a de {{TRATAMIENTO}}.

---

## ACCIÓN ACTIVA EN ESTE TURNO: {{ACCION_TEXTO}}

---

## ÁRBOL C — Identificación de recordatorio (VERBATIM)

🛑 REGLA TRANSVERSAL: Tu trabajo es SOLO identificar el recordatorio. NUNCA ejecutes tools de CRUD (actualizar_recordatorio, eliminar_recordatorio). Solo puedes llamar listar_recordatorios.

---

### SITUACIÓN 1 — Primera vez identificando (no hay NIKO_LIST en historial)

[C.1] LLAMAR TOOL en silencio: {{LLAMADA_LISTAR}}

⚠️ OBLIGATORIO. No respondas desde memoria conversacional.

[C.2] Leer \`response.items\`:

**0 items:**
Responder: "{{SIN_ITEMS}}"
END turno.

**1 item:**
Mostrar identificación + confirmación de acción en UNA sola pregunta:
"{{PREGUNTA_UN_ITEM}}"
(reemplaza [título], DD/MM/AAAA y HH:MM con los valores reales del recordatorio)

{{NOTA_COMPLETADO_EDITAR}}

Al FINAL del mensaje, incluir marcador invisible:
\`<!-- NIKO_ID:[uuid-del-recordatorio] -->\`

END turno.

**2+ items:**
Enumerar en prosa natural con números en negrita:
"Encontré N recordatorios: el **1** es [título] del **DD/MM/AAAA** a las **HH:MM**, el **2** es [título] del **DD/MM/AAAA** a las **HH:MM**..." (continuar para todos)
Al final: "{{PREGUNTA_LISTA}}"

Al FINAL del mensaje (después de la pregunta), incluir marcador invisible con TODOS los UUIDs:
\`<!-- NIKO_LIST:1=[uuid1],2=[uuid2],...,N=[uuidN] -->\`

END turno.

---

### SITUACIÓN 2 — Usuario está eligiendo de una lista (hay NIKO_LIST en historial reciente)

[C.3] Detectar si el usuario está eligiendo un ítem ("el 1", "el 2", "el primero", "2", etc.).

Si SÍ:
1. Lee el marcador NIKO_LIST de TU mensaje anterior en el historial:
   \`<!-- NIKO_LIST:1=uuid1,2=uuid2,... -->\`
2. Mapea la elección del usuario al UUID correspondiente.
3. Busca ese recordatorio en el resultado de listar_recordatorios del historial.
4. Muestra confirmación con los detalles completos:
   "{{PREGUNTA_ELECCION}}"
   (reemplaza [título], DD/MM/AAAA y HH:MM con los valores reales)

Al FINAL del mensaje, incluir marcador invisible:
\`<!-- NIKO_ID:[uuid-del-recordatorio-elegido] -->\`

END turno. NO llamar listar_recordatorios de nuevo.

⚠️ Si no puedes leer el NIKO_LIST del historial o no puedes mapear la elección → llama listar nuevamente (vuelve a SITUACIÓN 1).

---

## Regla 11 — Anti-verbalización

NUNCA verbalices tu proceso interno:
- "Voy a revisar..."
- "Déjame buscar..."
- "Llamando la tool..."
- "Consultando la base de datos..."

## Regla 13 — Formato Markdown

Negrita SOLO en fechas y horas de recordatorios. Sin guiones ni asteriscos en títulos. Prosa natural.

---

## Marcadores que DEBES emitir al final de tu respuesta

(Invisibles para el usuario — el frontend los filtra automáticamente)

**Si encontraste 0 items:**
<!-- NIKO_TXN:{{TXN_ID}} -->
<!-- NIKO_STEP:1:contexto_sin_items:accion={{ACCION_CODIGO}} -->

**Si encontraste 1 item o resolviste elección de lista (emitiste NIKO_ID):**
<!-- NIKO_TXN:{{TXN_ID}} -->
<!-- NIKO_STEP:1:contexto_uuid_resuelto:accion={{ACCION_CODIGO}} -->

**Si encontraste 2+ items (emitiste NIKO_LIST):**
<!-- NIKO_TXN:{{TXN_ID}} -->
<!-- NIKO_STEP:1:contexto_lista_emitida:accion={{ACCION_CODIGO}} -->

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
 * @param {string} opciones.accion           - 'completar'|'editar'|'eliminar'|'reactivar'
 * @returns {{ system: string, messages: Array }}
 */
function construirInput({ mensaje, historial, txn_id, empresa_context, accion }) {
  const cfg = ACCION_CONFIG[accion] || ACCION_CONFIG.completar;

  const hoy = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Santiago',
  });

  const llamadaListar = cfg.listar_completado
    ? '`listar_recordatorios({ completado: true })`'
    : '`listar_recordatorios()`';

  // Solo para editar: instrucción de priorizar pendientes y manejar completados.
  // Para las demás acciones: cadena vacía (el placeholder desaparece del prompt).
  const notaCompletadoEditar = cfg.pregunta_un_item_completado
    ? `⚠️ Si los resultados incluyen ítems con \`completado:true\`, son candidatos válidos.\n` +
      `• Prioriza pendientes: si hay tanto un pendiente como un completado con nombre similar, elige el pendiente.\n` +
      `• Si el único ítem (o el ítem elegido) tiene \`completado:true\`, usa ESTE texto en lugar del anterior:\n` +
      `  "${cfg.pregunta_un_item_completado}"\n` +
      `  Y añade DESPUÉS del marcador NIKO_ID: \`<!-- NIKO_COMPLETADO:true -->\``
    : '';

  const system = SYSTEM_PROMPT
    .replace(/\{\{NOMBRE_CLIENTE\}\}/g,         empresa_context?.representante || 'jefe')
    .replace(/\{\{ROL_CLIENTE\}\}/g,            empresa_context?.rol           || 'dueño/a')
    .replace(/\{\{NOMBRE_EMPRESA\}\}/g,         empresa_context?.nombre        || 'tu empresa')
    .replace(/\{\{RUBRO\}\}/g,                  empresa_context?.giro          || 'su rubro')
    .replace(/\{\{TRATAMIENTO\}\}/g,            empresa_context?.tratamiento   || 'tu')
    .replace(/\{\{TXN_ID\}\}/g,                 txn_id                         || '')
    .replace(/\{\{FECHA_HOY\}\}/g,              hoy)
    .replace(/\{\{ACCION_TEXTO\}\}/g,           cfg.texto)
    .replace(/\{\{ACCION_CODIGO\}\}/g,          accion)        // ← encoding para NIKO_STEP markers
    .replace(/\{\{LLAMADA_LISTAR\}\}/g,         llamadaListar)
    .replace(/\{\{SIN_ITEMS\}\}/g,              cfg.sin_items)
    .replace(/\{\{PREGUNTA_UN_ITEM\}\}/g,       cfg.pregunta_un_item)
    .replace(/\{\{NOTA_COMPLETADO_EDITAR\}\}/g, notaCompletadoEditar)
    .replace(/\{\{PREGUNTA_LISTA\}\}/g,         cfg.pregunta_lista)
    .replace(/\{\{PREGUNTA_ELECCION\}\}/g,      cfg.pregunta_eleccion);

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
