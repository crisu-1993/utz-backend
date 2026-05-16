'use strict';

// ─── Rutas /api/recordatorios ─────────────────────────────────────────────────
//
// Endpoints:
//   GET    /api/recordatorios        → listar recordatorios de la empresa
//   POST   /api/recordatorios        → crear recordatorio
//   PATCH  /api/recordatorios/:id    → actualizar recordatorio
//   DELETE /api/recordatorios/:id    → eliminar recordatorio

const express                = require('express');
const { createClient }       = require('@supabase/supabase-js');
const { authMiddleware }     = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── GET /api/recordatorios ───────────────────────────────────────────────────
// Query params opcionales:
//   ?completado=true|false
//   ?fecha_desde=YYYY-MM-DD
//   ?fecha_hasta=YYYY-MM-DD
router.get('/', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { completado, fecha_desde, fecha_hasta } = req.query;

  const supabase = getSupabase();

  try {
    let query = supabase
      .from('recordatorios')
      .select('*')
      .eq('empresa_id', empresa_id)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (completado !== undefined) {
      query = query.eq('completado', completado === 'true');
    }

    if (fecha_desde) {
      query = query.gte('fecha_vencimiento', fecha_desde);
    }

    if (fecha_hasta) {
      query = query.lte('fecha_vencimiento', fecha_hasta);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);

    return res.json({ ok: true, recordatorios: data });

  } catch (err) {
    console.error('[recordatorios] Error en GET /', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── crearRecordatorio ────────────────────────────────────────────────────────
//
// Función pura: valida y crea un recordatorio en la tabla 'recordatorios'.
// Usada internamente por el endpoint POST y por la tool de Niko.
//
// @param {object} params
//   empresa_id        {string}  UUID de la empresa
//   user_id           {string}  UUID del usuario
//   titulo            {string}  Texto del recordatorio (requerido, max 200 chars)
//   descripcion       {string?} Detalle adicional (opcional)
//   fecha_vencimiento {string?} Fecha en formato YYYY-MM-DD (opcional)
//   origen            {string?} 'manual' (default) | 'niko_a_pedido'
// @returns {object} { ok: true, recordatorio } | { ok: false, mensaje, status }

async function crearRecordatorio({ empresa_id, user_id, titulo, descripcion, fecha_vencimiento, origen }) {
  const origenFinal = origen ?? 'manual';

  if (!titulo || !String(titulo).trim()) {
    return { ok: false, mensaje: 'El campo "titulo" es requerido', status: 400 };
  }

  if (String(titulo).trim().length > 200) {
    return { ok: false, mensaje: 'El título no puede superar 200 caracteres', status: 400 };
  }

  if (fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
    return { ok: false, mensaje: 'fecha_vencimiento debe tener formato YYYY-MM-DD', status: 400 };
  }

  if (!['manual', 'niko_a_pedido'].includes(origenFinal)) {
    return { ok: false, mensaje: 'origen debe ser "manual" o "niko_a_pedido"', status: 400 };
  }

  const supabase = getSupabase();

  // Calcular titulo limpio una vez (reutilizado abajo)
  const tituloLimpio = String(titulo).trim();

  try {
    // ── Anti-duplicados (solo para niko_a_pedido) ─────────────────────────
    if (origenFinal === 'niko_a_pedido') {
      const sesentaSegundosAtras = new Date(Date.now() - 60000).toISOString();

      const { data: existente, error: errExistente } = await supabase
        .from('recordatorios')
        .select('*')
        .eq('empresa_id', empresa_id)
        .eq('titulo', tituloLimpio)
        .eq('fecha_vencimiento', fecha_vencimiento || null)
        .eq('origen', origenFinal)
        .gte('created_at', sesentaSegundosAtras)
        .maybeSingle();

      if (errExistente) {
        console.warn('[crearRecordatorio] Error verificando duplicado, continuando:', errExistente.message);
      } else if (existente) {
        console.warn('[crearRecordatorio] Duplicado detectado, devolviendo existente:', { empresa_id, titulo: tituloLimpio, fecha_vencimiento });
        return { ok: true, recordatorio: existente };
      }
    }

    const payload = {
      empresa_id,
      user_id,
      titulo:            tituloLimpio,
      descripcion:       descripcion ? String(descripcion).trim() : null,
      fecha_vencimiento: fecha_vencimiento || null,
      origen:            origenFinal,
    };

    const { data, error } = await supabase
      .from('recordatorios')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return { ok: true, recordatorio: data };

  } catch (err) {
    console.error('[recordatorios] Error en crearRecordatorio:', err.message);
    return { ok: false, mensaje: err.message, status: 500 };
  }
}

// ─── POST /api/recordatorios ──────────────────────────────────────────────────
// Body: { titulo, descripcion?, fecha_vencimiento? }
router.post('/', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { titulo, descripcion, fecha_vencimiento } = req.body || {};

  const resultado = await crearRecordatorio({
    empresa_id,
    user_id,
    titulo,
    descripcion,
    fecha_vencimiento,
    origen: 'manual',
  });

  if (!resultado.ok) {
    return res.status(resultado.status || 500).json({ ok: false, error: resultado.mensaje });
  }

  return res.status(201).json({ ok: true, recordatorio: resultado.recordatorio });
});

// ─── PATCH /api/recordatorios/:id ────────────────────────────────────────────
// Body: { titulo?, descripcion?, fecha_vencimiento?, completado? }
router.patch('/:id', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { id }         = req.params;
  const { titulo, descripcion, fecha_vencimiento, completado } = req.body || {};

  const supabase = getSupabase();

  try {
    // Verificar que el recordatorio pertenece a esta empresa
    const { data: existente, error: errBuscar } = await supabase
      .from('recordatorios')
      .select('id')
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (errBuscar) throw new Error(errBuscar.message);

    if (!existente) {
      return res.status(404).json({ ok: false, error: 'Recordatorio no encontrado' });
    }

    // Construir solo los campos que vienen en el body
    const updates = { updated_at: new Date().toISOString() };

    if (titulo !== undefined) {
      if (!String(titulo).trim()) {
        return res.status(400).json({ ok: false, error: 'El título no puede estar vacío' });
      }
      if (String(titulo).trim().length > 200) {
        return res.status(400).json({ ok: false, error: 'El título no puede superar 200 caracteres' });
      }
      updates.titulo = String(titulo).trim();
    }

    if (descripcion !== undefined) {
      updates.descripcion = descripcion ? String(descripcion).trim() : null;
    }

    if (fecha_vencimiento !== undefined) {
      if (fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
        return res.status(400).json({ ok: false, error: 'fecha_vencimiento debe tener formato YYYY-MM-DD' });
      }
      updates.fecha_vencimiento = fecha_vencimiento || null;
    }

    if (completado !== undefined) {
      updates.completado = Boolean(completado);
    }

    const { data, error } = await supabase
      .from('recordatorios')
      .update(updates)
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.json({ ok: true, recordatorio: data });

  } catch (err) {
    console.error('[recordatorios] Error en PATCH /:id', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/recordatorios/:id ───────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
  const { empresa_id } = req.auth;
  const { id }         = req.params;

  const supabase = getSupabase();

  try {
    // Verificar que pertenece a esta empresa antes de borrar
    const { data: existente, error: errBuscar } = await supabase
      .from('recordatorios')
      .select('id')
      .eq('id', id)
      .eq('empresa_id', empresa_id)
      .maybeSingle();

    if (errBuscar) throw new Error(errBuscar.message);

    if (!existente) {
      return res.status(404).json({ ok: false, error: 'Recordatorio no encontrado' });
    }

    const { error } = await supabase
      .from('recordatorios')
      .delete()
      .eq('id', id)
      .eq('empresa_id', empresa_id);

    if (error) throw new Error(error.message);

    return res.json({ ok: true, id });

  } catch (err) {
    console.error('[recordatorios] Error en DELETE /:id', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports                    = router;
module.exports.crearRecordatorio  = crearRecordatorio;
