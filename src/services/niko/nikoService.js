'use strict';

const Anthropic             = require('@anthropic-ai/sdk');
const { createClient }      = require('@supabase/supabase-js');
const { buildSystemPrompt } = require('./systemPrompt');

const MODEL = 'claude-sonnet-4-6';

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

/**
 * Envía un mensaje a Niko y devuelve su respuesta.
 *
 * @param {string} empresa_id - UUID de la empresa activa (del authMiddleware)
 * @param {string} mensaje    - Texto enviado por el usuario
 * @param {string} user_id    - UUID del usuario autenticado (del authMiddleware)
 * @returns {{ respuesta: string, modelo_usado: string, tokens_usados: number }}
 */
async function chatWithNiko(empresa_id, mensaje, user_id) {
  const supabase = getSupabase();

  // ── 1. Cargar datos de la empresa ─────────────────────────────────────────
  const { data, error } = await supabase
    .from('empresas')
    .select('nombre, giro, representante_nombre, representante_rol, tratamiento')
    .eq('id', empresa_id)
    .single();

  if (error) {
    console.error(`[niko] Error cargando empresa ${empresa_id}:`, error.message);
    throw new Error('No se pudieron cargar los datos de la empresa');
  }

  // ── 2. Mapear datos con fallbacks seguros ─────────────────────────────────
  const nombreEmpresa  = data.nombre                 || 'tu empresa';
  const rubro          = data.giro                   || 'su rubro';
  const nombreCliente  = data.representante_nombre   || 'cliente';
  const rolCliente     = data.representante_rol      || 'dueño/a';
  const tratamiento    = data.tratamiento            || 'tu';

  // ── 3. Construir system prompt ────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt({
    nombreCliente,
    rolCliente,
    nombreEmpresa,
    rubro,
    tratamiento,
  });

  // ── 4. Llamar a Claude ────────────────────────────────────────────────────
  const anthropic = new Anthropic();

  const response = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 1500,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: mensaje }],
  });

  const respuesta     = response.content[0].text;
  const tokens_usados = response.usage.input_tokens + response.usage.output_tokens;

  return {
    respuesta,
    modelo_usado:  response.model,
    tokens_usados,
  };
}

module.exports = { chatWithNiko };
