'use strict';

// ─── Rutas /api/empresas ──────────────────────────────────────────────────────
//
// Usa authSoloMiddleware (no authMiddleware) porque estos endpoints no requieren
// que el usuario ya tenga empresa. Por ejemplo, un usuario recién registrado
// puede llamar a GET / y recibir una lista vacía sin error.
//
// Endpoints:
//   GET  /api/empresas → lista todas las empresas del usuario autenticado
//   POST /api/empresas → crea empresa + consentimientos (onboarding Ley 21.719)

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { authSoloMiddleware } = require('../middleware/auth');

const router = express.Router();

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── GET /api/empresas ────────────────────────────────────────────────────────
// Lista todas las empresas cuyo owner_id coincide con el user del JWT.
// Ordenadas de más antigua a más nueva (misma lógica que el fallback del authMiddleware).
// Si el usuario no tiene empresas devuelve lista vacía (no error).
router.get('/', authSoloMiddleware, async (req, res) => {
  const { user_id } = req.auth;
  const supabase    = getSupabase();

  try {
    const { data, error } = await supabase
      .from('empresas')
      .select('id, nombre, created_at, eerr_ampliado_revelado')
      .eq('owner_id', user_id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[empresas] Error consultando empresas:', error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok:   true,
      data: data || [],
    });

  } catch (err) {
    console.error('[empresas] Error inesperado:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Normaliza RUT chileno: elimina puntos, trim, convierte todo a mayúsculas
// Ej: "76.123.456-7" → "76123456-7" | "12345678-k" → "12345678-K"
function normalizarRut(rut) {
  if (!rut) return rut;
  return rut.replace(/\./g, '').toUpperCase().trim();
}

// ─── POST /api/empresas ───────────────────────────────────────────────────────
// Crea empresa + registro de consentimientos atómicamente (rollback manual).
// Cumple Ley 21.719 de protección de datos personales (Chile).
//
// Body esperado:
//   { empresa, representante, consentimientos }
//
// Rollback: si falla la inserción de consentimientos, se borra la empresa
// recién creada para no dejar registros huérfanos.
router.post('/', authSoloMiddleware, async (req, res) => {
  const { user_id } = req.auth;
  const supabase    = getSupabase();

  console.log(`[empresas] POST creando empresa para user ${user_id}`);

  // ── 1. Extraer y desestructurar body ──────────────────────────────────────
  const {
    empresa:        empresaBody       = {},
    representante:  representanteBody = {},
    consentimientos: consBody         = {},
  } = req.body || {};

  // ── 2. Validaciones ───────────────────────────────────────────────────────

  if (!empresaBody.nombre || !String(empresaBody.nombre).trim()) {
    return res.status(400).json({ ok: false, error: 'El nombre de la empresa es requerido' });
  }
  if (!empresaBody.rut || !String(empresaBody.rut).trim()) {
    return res.status(400).json({ ok: false, error: 'El RUT de la empresa es requerido' });
  }
  if (!representanteBody.nombre || !String(representanteBody.nombre).trim()) {
    return res.status(400).json({ ok: false, error: 'El nombre del representante es requerido' });
  }
  if (!representanteBody.rut || !String(representanteBody.rut).trim()) {
    return res.status(400).json({ ok: false, error: 'El RUT del representante es requerido' });
  }
  if (consBody.acepto_terminos !== true) {
    return res.status(400).json({ ok: false, error: 'Debes aceptar los Términos y Condiciones' });
  }
  if (consBody.acepto_privacidad !== true) {
    return res.status(400).json({ ok: false, error: 'Debes aceptar la Política de Privacidad' });
  }
  if (consBody.acepto_facultades !== true) {
    return res.status(400).json({ ok: false, error: 'Debes confirmar que tienes facultades para representar la empresa' });
  }

  // Validar pais: si viene, debe ser exactamente 2 caracteres
  const pais = empresaBody.pais ? String(empresaBody.pais).trim() : 'CL';
  if (pais.length !== 2) {
    return res.status(400).json({ ok: false, error: 'El campo pais debe tener exactamente 2 caracteres (ej: CL, US)' });
  }

  // ── 3. Normalizar RUTs ────────────────────────────────────────────────────
  const rutEmpresa       = normalizarRut(empresaBody.rut);
  const rutRepresentante = normalizarRut(representanteBody.rut);

  // ── 4. Capturar IP y User-Agent para los consentimientos ──────────────────
  const ip        = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
  const userAgent = req.headers['user-agent'] || null;

  try {
    // ── 5. Insertar empresa ────────────────────────────────────────────────
    const { data: empresaData, error: empresaError } = await supabase
      .from('empresas')
      .insert({
        owner_id:             user_id,
        nombre:               String(empresaBody.nombre).trim(),
        rut:                  rutEmpresa,
        giro:                 empresaBody.giro ? String(empresaBody.giro).trim() : null,
        pais,
        representante_nombre: String(representanteBody.nombre).trim(),
        representante_rut:    rutRepresentante,
        representante_rol:    representanteBody.rol ? String(representanteBody.rol).trim() : null,
      })
      .select('id, nombre, rut, giro, pais, representante_nombre, representante_rut, representante_rol, created_at')
      .single();

    if (empresaError) {
      console.error('[empresas] Error insertando empresa:', empresaError.message);
      return res.status(500).json({ ok: false, error: 'Error al crear la empresa' });
    }

    // ── 6. Insertar consentimientos ────────────────────────────────────────
    const { data: consentimientoData, error: consError } = await supabase
      .from('consentimientos')
      .insert({
        empresa_id:           empresaData.id,
        user_id,
        acepto_terminos:      true,
        acepto_privacidad:    true,
        acepto_facultades:    true,
        acepto_marketing:     consBody.acepto_marketing     ?? false,
        acepto_mejora_modelos: consBody.acepto_mejora_modelos ?? false,
        version_terminos:     consBody.version_terminos     ?? '1.0',
        version_privacidad:   consBody.version_privacidad   ?? '1.0',
        ip_address:           ip,
        user_agent:           userAgent,
      })
      .select('id, acepto_terminos, acepto_privacidad, acepto_facultades, acepto_marketing, acepto_mejora_modelos, created_at')
      .single();

    if (consError) {
      // ── ROLLBACK MANUAL: borrar empresa creada ─────────────────────────
      console.error('[empresas] Error insertando consentimientos — iniciando rollback:', consError.message);

      const { error: rollbackError } = await supabase
        .from('empresas')
        .delete()
        .eq('id', empresaData.id);

      if (rollbackError) {
        console.error(`[empresas][rollback-fallido] No se pudo borrar empresa ${empresaData.id}:`, rollbackError.message);
      } else {
        console.log(`[empresas] Rollback ok — empresa ${empresaData.id} eliminada`);
      }

      return res.status(500).json({ ok: false, error: 'Error al registrar los consentimientos' });
    }

    // ── 7. Éxito ──────────────────────────────────────────────────────────
    console.log(`[empresas] ✓ Empresa ${empresaData.id} creada con consentimiento ${consentimientoData.id}`);

    return res.status(201).json({
      ok: true,
      data: {
        empresa: empresaData,
        consentimiento: {
          id:          consentimientoData.id,
          aceptado_at: consentimientoData.created_at,
        },
      },
    });

  } catch (err) {
    console.error('[empresas] Error inesperado en POST /:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

module.exports = router;
