// Ver SKILL_CARTOLA.md para reglas completas de parsing.
//
// Arquitectura: 3 fases
//   Fase 1 — Delimitar zona de movimientos (encabezado + footer)
//   Fase 2 — Mapear coordenadas exactas de cada columna
//   Fase 3 — Extraer campos usando el mapa (slice directo, sin inferencia)

const pdfParse = require('pdf-parse');

// ─── Normalización de texto ───────────────────────────────────────────────────
function normText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Parseo de montos en formato chileno (Reglas 5, 6, 8) ────────────────────
// Regla 8: (1.234.567) = notación contable → valor absoluto
// Regla 6: 1.234,56 = formato chileno → 1234.56
// Regla 5: 1.234.567 = todos los puntos con 3 dígitos → miles → 1234567
function parseMonto(s) {
  if (!s || !s.trim()) return null;
  let str = s.trim();

  // Regla 8: notación contable entre paréntesis → tratar como positivo
  if (str.startsWith('(') && str.endsWith(')')) str = str.slice(1, -1);

  const limpio   = str.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs      = limpio.replace('-', '');

  if (!abs || !/\d/.test(abs)) return null;

  const contienePoint = abs.includes('.');
  const contieneComa  = abs.includes(',');

  let num;
  if (contienePoint && contieneComa) {
    // Regla 6: determinar cuál es el separador decimal por orden de aparición
    const lastPoint = abs.lastIndexOf('.');
    const lastComa  = abs.lastIndexOf(',');
    num = lastComa > lastPoint
      ? parseFloat(abs.replace(/\./g, '').replace(',', '.'))  // 1.234,56 → chileno
      : parseFloat(abs.replace(/,/g, ''));                     // 1,234.56 → anglosajón
  } else if (contieneComa && !contienePoint) {
    const partes = abs.split(',');
    num = (partes.length === 2 && partes[1].length <= 2)
      ? parseFloat(abs.replace(',', '.'))   // 1234,56 → decimal
      : parseFloat(abs.replace(/,/g, ''));  // separador de miles
  } else {
    // Regla 5: si TODOS los segmentos tras el primero tienen exactamente 3 dígitos
    // → todos los puntos son separadores de miles (1.234.567 → 1234567)
    const partes = abs.split('.');
    const sonMiles = partes.length > 1 && partes.slice(1).every(p => p.length === 3);
    num = sonMiles ? parseFloat(abs.replace(/\./g, '')) : parseFloat(abs);
  }

  if (isNaN(num) || num < 0) return null;
  return negativo ? -Math.abs(num) : Math.abs(num);
}

// ─── Patrones de fecha (Fase 3 — Regla 7) ────────────────────────────────────
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,  // DD/MM/YYYY o DD-MM-YYYY
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,  // YYYY-MM-DD
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,  // DD/MM/YY — Regla 7: YY≤50→20XX
];

function normalizarFecha(m, fmt) {
  if (fmt === 0) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (fmt === 1) return `${m[1]}-${m[2]}-${m[3]}`;
  if (fmt === 2) {
    const y = parseInt(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return null;
}

function extraerFecha(texto) {
  for (let i = 0; i < FECHA_RE.length; i++) {
    const m = texto.match(FECHA_RE[i]);
    if (m) return normalizarFecha(m, i);
  }
  return null;
}

// ─── Aliases de columnas por tipo (Fase 1.1 de la skill) ─────────────────────
const COL_ALIASES = {
  fecha:       ['fecha'],
  descripcion: ['descripcion', 'glosa', 'concepto', 'detalle', 'movimiento'],
  docto:       ['docto', 'n° doc', 'n°doc', 'nro. doc', 'nro.doc', 'documento', 'nro', 'n°', 'num'],
  cargos:      ['cargo', 'cargos', 'debito', 'debitos'],
  abonos:      ['abono', 'abonos', 'credito', 'creditos'],
  saldo:       ['saldo', 'balance', 'saldo final', 'saldo disponible'],
};

// ─── Marcadores de fin de zona de movimientos (Fase 1) ───────────────────────
// Líneas que aparecen en el footer del PDF luego de las transacciones
const FOOTER_RE = /\b(mensaje|imprimir|p[aá]gina siguiente|pie de p[aá]gina|total cargos|total abonos|saldo final al|saldo al \d)\b/;

// ─── Filas a descartar aunque tengan fecha (Fase 6 de la skill) ──────────────
const SKIP_DESC_RE = /^(saldo anterior|saldo inicial|total |subtotal|totales|resumen)\b/;

// ─── Heurística de tipo por descripción (fallback Fase 6) ────────────────────
const KW_INGRESO = ['abono', 'deposito', 'transferencia recibida', 'credito', 'remuneracion', 'sueldo', 'devolucion'];
const KW_EGRESO  = ['pago', 'cargo', 'debito', 'retiro', 'cuota', 'comision', 'impuesto', 'compra', 'giro'];

function inferirTipo(desc) {
  const d = normText(desc);
  for (const kw of KW_INGRESO) { if (d.includes(kw)) return 'ingreso'; }
  for (const kw of KW_EGRESO)  { if (d.includes(kw)) return 'egreso'; }
  return 'egreso'; // default conservador
}

// ─── FASE 1: Detectar encabezado y límites de la zona de movimientos ─────────
function detectarZona(lineas) {
  let headerIdx = -1;
  let colMap    = {};

  for (let i = 0; i < lineas.length; i++) {
    const norm = normText(lineas[i]);
    const mapa = {};

    for (const [key, aliases] of Object.entries(COL_ALIASES)) {
      for (const alias of aliases) {
        const idx = norm.indexOf(alias);
        if (idx !== -1) { mapa[key] = idx; break; }
      }
    }

    // Mínimo requerido: fecha + cargos + abonos en la misma línea
    if (mapa.fecha !== undefined && mapa.cargos !== undefined && mapa.abonos !== undefined) {
      headerIdx = i;
      colMap    = mapa;
      break;
    }
  }

  if (headerIdx === -1) return null;

  // Buscar línea de footer para delimitar el fin de la zona de datos
  let footerIdx = lineas.length;
  for (let i = headerIdx + 1; i < lineas.length; i++) {
    if (FOOTER_RE.test(normText(lineas[i]))) { footerIdx = i; break; }
  }

  return { headerIdx, footerIdx, colMap };
}

// ─── FASE 2: Crear zonas de columnas con midpoints ────────────────────────────
// Cada zona va desde el midpoint con la columna anterior hasta el midpoint
// con la siguiente. Esto tolera que los datos estén levemente desalineados
// respecto al encabezado.
function crearZonas(colMap) {
  const sorted = Object.entries(colMap).sort(([, a], [, b]) => a - b);
  const zonas  = {};

  for (let i = 0; i < sorted.length; i++) {
    const [key, pos] = sorted[i];
    const prevPos = i > 0 ? sorted[i - 1][1] : 0;
    const nextPos = i < sorted.length - 1 ? sorted[i + 1][1] : Infinity;

    zonas[key] = {
      start: i === 0 ? 0 : Math.floor((prevPos + pos) / 2),
      end:   nextPos === Infinity ? Infinity : Math.floor((pos + nextPos) / 2),
    };
  }

  return zonas;
}

// Extrae y limpia el texto de una zona en la línea original (sin trim global)
function sliceZona(lineaRaw, zona) {
  const end = zona.end === Infinity ? lineaRaw.length : Math.min(zona.end, lineaRaw.length);
  return lineaRaw.slice(zona.start, end).trim();
}

// ─── FASE 3: Extraer transacciones usando el mapa de coordenadas ──────────────
function parsearLineas(texto) {
  const lineas = texto.split('\n');
  const transacciones = [];

  // Fase 1: delimitar zona
  const zona = detectarZona(lineas);
  if (!zona) return transacciones; // sin encabezado → vacío (error en procesarPDF)

  // Fase 2: mapear coordenadas
  const zonas = crearZonas(zona.colMap);

  // Fase 3: iterar solo las líneas dentro de la zona de movimientos
  for (let i = zona.headerIdx + 1; i < zona.footerIdx; i++) {
    const lineaRaw  = lineas[i];
    const lineaTrim = lineaRaw.trim();
    if (!lineaTrim) continue;

    // ── Fecha ─────────────────────────────────────────────────────────────────
    // Leer desde la zona de fecha; si no hay zona detectada, los primeros 12 chars
    const textoFecha = zonas.fecha
      ? sliceZona(lineaRaw, zonas.fecha)
      : lineaTrim.slice(0, 12);
    const fecha = extraerFecha(textoFecha);
    if (!fecha) continue;  // línea sin fecha → saltar

    // ── Numero de documento (Regla 1: NUNCA es monto, extraer como texto) ─────
    let numeroDocumento = null;
    if (zonas.docto) {
      const textoDocto = sliceZona(lineaRaw, zonas.docto);
      // Captura numérico puro (12345) o alfanumérico con prefijo (DOC-12345, TRF-001)
      const m = textoDocto.match(/\w[\w\-]*/);
      if (m) numeroDocumento = m[0];
    }

    // ── Descripción (Regla 9: no eliminar números de la zona de descripción) ──
    let descripcion = zonas.descripcion
      ? sliceZona(lineaRaw, zonas.descripcion)
      : '';

    // Regla 10: concatenar línea siguiente si continúa la descripción (sin fecha)
    if (i + 1 < zona.footerIdx) {
      const nextRaw  = lineas[i + 1];
      const nextFecha = zonas.fecha
        ? extraerFecha(sliceZona(nextRaw, zonas.fecha))
        : extraerFecha(nextRaw.trim().slice(0, 12));
      if (!nextFecha && nextRaw.trim()) {
        // La línea siguiente no tiene fecha → es continuación de descripción
        const nextDesc = zonas.descripcion
          ? sliceZona(nextRaw, zonas.descripcion)
          : nextRaw.trim();
        if (nextDesc) { descripcion = (descripcion + ' ' + nextDesc).trim(); i++; }
      }
    }

    if (descripcion.length < 3) continue;
    if (SKIP_DESC_RE.test(normText(descripcion))) continue;

    // ── Cargo → egreso (Regla 2) ──────────────────────────────────────────────
    let monto = null;
    let tipo  = null;

    if (zonas.cargos) {
      const v = parseMonto(sliceZona(lineaRaw, zonas.cargos));
      if (v && v > 0) { monto = v; tipo = 'egreso'; }
    }

    // ── Abono → ingreso (Regla 3) ─────────────────────────────────────────────
    if (!monto && zonas.abonos) {
      const v = parseMonto(sliceZona(lineaRaw, zonas.abonos));
      if (v && v > 0) { monto = v; tipo = 'ingreso'; }
    }

    // ── Fallback: si la zona estaba desalineada, buscar cualquier número numérico
    // en la zona conjunta cargos+abonos e inferir tipo por descripción
    if (!monto && zonas.cargos && zonas.abonos) {
      const zonaMontos = {
        start: zonas.cargos.start,
        end:   zonas.abonos.end,
      };
      const textoMontos = sliceZona(lineaRaw, zonaMontos);
      const v = parseMonto(textoMontos.replace(/\s+/g, '').split(/\s/)[0] || '');
      if (v && v > 0) { monto = v; tipo = inferirTipo(descripcion); }
    }

    // ── Saldo posterior (Regla 4) ─────────────────────────────────────────────
    let saldoPosterior = null;
    if (zonas.saldo) {
      saldoPosterior = parseMonto(sliceZona(lineaRaw, zonas.saldo));
    }

    // ── Validación final (Fase 4) ─────────────────────────────────────────────
    if (!monto || !tipo) continue;

    transacciones.push({
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      numero_documento:        numeroDocumento,
      tipo,
      monto_original:          monto,
      saldo_posterior:         saldoPosterior,
      moneda_original:         'CLP',
      fuente:                  'cartola_banco',
    });
  }

  return transacciones;
}

// ─── Exportación principal ───────────────────────────────────────────────────
async function procesarPDF(buffer) {
  let data;
  try {
    data = await pdfParse(buffer);
  } catch (err) {
    throw new Error(`No se pudo leer el PDF: ${err.message}`);
  }

  const texto = data.text;
  if (!texto || texto.trim().length < 50) {
    throw new Error('El PDF no contiene texto extraíble (puede ser una imagen escaneada).');
  }

  const transacciones = parsearLineas(texto);

  if (transacciones.length === 0) {
    throw new Error(
      'No se encontraron transacciones en el PDF. ' +
      'Verifique que sea una cartola bancaria chilena con texto seleccionable ' +
      'y que contenga columnas Fecha, Cargos y Abonos.'
    );
  }

  return transacciones;
}

module.exports = { procesarPDF };
