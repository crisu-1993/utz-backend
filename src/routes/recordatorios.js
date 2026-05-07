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

// ─── POST /api/recordatorios ──────────────────────────────────────────────────
// Body: { titulo, descripcion?, fecha_vencimiento? }
router.post('/', authMiddleware, async (req, res) => {
  const { empresa_id, user_id } = req.auth;
  const { titulo, descripcion, fecha_vencimiento } = req.body || {};

  if (!titulo || !String(titulo).trim()) {
    return res.status(400).json({ ok: false, error: 'El campo "titulo" es requerido' });
  }

  if (String(titulo).trim().length > 200) {
    return res.status(400).json({ ok: false, error: 'El título no puede superar 200 caracteres' });
  }

  if (fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
    return res.status(400).json({ ok: false, error: 'fecha_vencimiento debe tener formato YYYY-MM-DD' });
  }

  const supabase = getSupabase();

  try {
    const payload = {
      empresa_id,
      user_id,
      titulo:            String(titulo).trim(),
      descripcion:       descripcion ? String(descripcion).trim() : null,
      fecha_vencimiento: fecha_vencimiento || null,
    };

    const { data, error } = await supabase
      .from('recordatorios')
      .insert(payload)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.status(201).json({ ok: true, recordatorio: data });

  } catch (err) {
    console.error('[recordatorios] Error en POST /', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
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

module.exports = router;
