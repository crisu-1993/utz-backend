// ─────────────────────────────────────────────────────────────────────────
// Middleware de idempotencia para endpoints sensibles
//
// Previene procesamiento duplicado cuando el cliente envía la misma request
// dos veces (double-submit, retry de red, proxy de Railway, etc).
//
// Funcionamiento:
// - Cliente envía request_id (en body) único por intento.
// - Si el ID ya está en cache → marca como duplicado (caller decide qué hacer).
// - Si NO está → marca como "procesando" y deja seguir.
// - Expira en 30 segundos.
// ─────────────────────────────────────────────────────────────────────────

'use strict';

const cache  = new Map();
const TTL_MS = 30000;

// Limpieza periódica de entradas expiradas
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of cache.entries()) {
    if (now - entry.timestamp > TTL_MS) {
      cache.delete(id);
    }
  }
}, 60000);

function obtenerRequestId(req) {
  return req.headers['x-request-id'] ||
         req.body?.request_id        ||
         null;
}

// Verifica si un request_id ya está en proceso o procesado.
// Si es nuevo, lo marca como en proceso.
// Retorna: { duplicado: boolean, enCurso: boolean }
function verificarOMarcar(requestId) {
  if (!requestId) return { duplicado: false, enCurso: false };

  const existente = cache.get(requestId);
  if (existente) {
    return { duplicado: true, enCurso: existente.estado === 'procesando' };
  }

  cache.set(requestId, {
    timestamp: Date.now(),
    estado:    'procesando',
  });
  return { duplicado: false, enCurso: false };
}

// Marca un request_id como finalizado (mantiene en cache para evitar reintentos).
function marcarFinalizado(requestId) {
  if (!requestId) return;
  const entry = cache.get(requestId);
  if (entry) {
    entry.estado    = 'finalizado';
    entry.timestamp = Date.now();
  }
}

// Limpia entrada en caso de error grave (permite retry legítimo).
function limpiarEntrada(requestId) {
  if (!requestId) return;
  cache.delete(requestId);
}

module.exports = {
  obtenerRequestId,
  verificarOMarcar,
  marcarFinalizado,
  limpiarEntrada,
};
