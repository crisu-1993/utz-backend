const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

// ─── Middleware: valida token Supabase y adjunta empresa_id al request ─────────
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok: false,
      error: 'Token de autorización requerido (Authorization: Bearer <token>)',
    });
  }

  const token = authHeader.slice(7); // remover "Bearer "
  const supabase = getSupabase();

  try {
    // Validar token contra Supabase Auth
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    }

    // Obtener empresa_id desde la tabla empresas (owner_id = user.id)
    const { data: empresa, error: empresaError } = await supabase
      .from('empresas')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle();

    if (empresaError || !empresa || !empresa.id) {
      return res.status(401).json({
        ok: false,
        error: 'No se encontró empresa asociada a este usuario',
      });
    }

    // Adjuntar al request para uso en el controlador
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

module.exports = { authMiddleware };
