const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Middleware completo: valida JWT + resuelve empresa activa ─────────────────
//
// Soporta multi-empresa: el frontend puede enviar el header "x-empresa-id"
// para especificar qué empresa quiere operar.
//
//   CON header x-empresa-id:
//     Verifica que user.id sea owner de esa empresa específica.
//     Si no lo es → 403 (no 401: el token es válido, pero sin permisos).
//
//   SIN header x-empresa-id (fallback para compatibilidad):
//     Toma la empresa más antigua del usuario (ORDER BY created_at ASC LIMIT 1).
//     Esto mantiene el comportamiento anterior para usuarios con 1 sola empresa.
//
//   Adjunta al request: req.auth = { user_id, email, empresa_id }
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'Token de autorización requerido (Authorization: Bearer <token>)',
    });
  }

  const token    = authHeader.slice(7); // remover "Bearer "
  const supabase = getSupabase();

  try {
    // 1. Validar JWT contra Supabase Auth
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    }

    // 2. Resolver empresa activa según header o fallback
    const headerEmpresaId = req.headers['x-empresa-id'];
    let empresa;

    if (headerEmpresaId) {
      // El frontend especificó una empresa concreta — verificar que le pertenece al user
      const { data, error } = await supabase
        .from('empresas')
        .select('id')
        .eq('owner_id', user.id)
        .eq('id', headerEmpresaId)
        .maybeSingle();

      if (error) {
        console.error('[auth] Error consultando empresa por header:', error.message);
        return res.status(500).json({ ok: false, error: 'Error al validar empresa' });
      }

      if (!data) {
        // El token es válido pero el user no es owner de esa empresa
        console.warn(`[auth] User ${user.id} intentó acceder a empresa ${headerEmpresaId} sin permisos`);
        return res.status(403).json({
          ok: false,
          error: 'Sin permisos sobre esa empresa',
        });
      }

      empresa = data;

    } else {
      // Sin header: tomar la empresa más antigua del usuario (compatibilidad con mono-empresa)
      // Usar .limit(1) en vez de .maybeSingle() para evitar el error cuando hay múltiples empresas
      const { data, error } = await supabase
        .from('empresas')
        .select('id')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error('[auth] Error consultando empresa por fallback:', error.message);
        return res.status(500).json({ ok: false, error: 'Error al resolver empresa' });
      }

      if (!data) {
        return res.status(401).json({
          ok: false,
          error: 'No se encontró empresa asociada a este usuario',
        });
      }

      empresa = data;
    }

    // 3. Adjuntar contexto al request para uso en los controladores
    req.auth = {
      user_id:    user.id,
      email:      user.email,
      empresa_id: empresa.id,
    };

    next();

  } catch (err) {
    console.error('[auth] Error validando token:', err.message);
    return res.status(401).json({ ok: false, error: 'Error al validar token' });
  }
}

// ─── Middleware liviano: solo valida JWT, sin resolver empresa ─────────────────
//
// Usar en endpoints que no requieren empresa_id, como GET /api/empresas.
// Adjunta al request: req.auth = { user_id, email }
// (sin empresa_id — el controlador es responsable de consultar empresas si las necesita)
async function authSoloMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'Token de autorización requerido (Authorization: Bearer <token>)',
    });
  }

  const token    = authHeader.slice(7);
  const supabase = getSupabase();

  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    }

    req.auth = {
      user_id: user.id,
      email:   user.email,
    };

    next();

  } catch (err) {
    console.error('[auth] Error validando token (solo):', err.message);
    return res.status(401).json({ ok: false, error: 'Error al validar token' });
  }
}

module.exports = { authMiddleware, authSoloMiddleware };
