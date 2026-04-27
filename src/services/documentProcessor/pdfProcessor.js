// Ver SKILL_CARTOLA.md para reglas de parsing de cartolas bancarias chilenas.
// Este archivo implementa las 6 fases y 10 reglas definidas en esa skill.

const pdfParse = require('pdf-parse');

// ─── Patrones de fecha (Fase 3.1) ────────────────────────────────────────────
// Orden de prioridad: DD/MM/YYYY > YYYY-MM-DD > DD/MM/YY
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,   // DD/MM/YYYY o DD-MM-YYYY
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,   // YYYY-MM-DD
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,   // DD/MM/YY — Regla 7: YY≤50→20XX, YY>50→19XX
];

function normalizarFecha(match, fmt) {
  if (fmt === 0) return `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  if (fmt === 1) return `${match[1]}-${match[2]}-${match[3]}`;
  if (fmt === 2) {
    const year = parseInt(match[3]) > 50 ? `19${match[3]}` : `20${match[3]}`;
    return `${year}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
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

// ─── Parseo de montos en formato chileno (Fase 3.4) ──────────────────────────
// Regla 5: 1.234 con 3 decimales = miles → 1234
// Regla 6: 1.234,56 = formato chileno → 1234.56
// Regla 8: (1.234) = notación contable → valor absoluto 1234
function parseMonto(s) {
  let str = s.trim();

  // Regla 8: notación contable con paréntesis → valor absoluto
  if (str.startsWith('(') && str.endsWith(')')) {
    str = str.slice(1, -1);
  }

  const limpio   = str.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs      = limpio.replace('-', '');

  const contienePoint = abs.includes('.');
  const contieneComa  = abs.includes(',');

  let num;
  if (contienePoint && contieneComa) {
    const lastPoint = abs.lastIndexOf('.');
    const lastComa  = abs.lastIndexOf(',');
    num = lastComa > lastPoint
      ? parseFloat(abs.replace(/\./g, '').replace(',', '.'))  // 1.234,56 → chileno
      : parseFloat(abs.replace(/,/g, ''));                     // 1,234.56 → anglosajón
  } else if (contieneComa && !contienePoint) {
    const partes = abs.split(',');
    num = (partes.length === 2 && partes[1].length <= 2)
      ? parseFloat(abs.replace(',', '.'))
      : parseFloat(abs.replace(/,/g, ''));
  } else {
    const partes = abs.split('.');
    // Regla 5: si TODOS los segmentos tras el primero tienen exactamente 3 dígitos
    // → todos los puntos son separadores de miles: 1.234.567 → 1234567, 150.000 → 150000
    // Si algún segmento ≠ 3 dígitos → el punto es decimal: 1.50 → 1.5
    const sonMiles = partes.length > 1 && partes.slice(1).every(p => p.length === 3);
    num = sonMiles ? parseFloat(abs.replace(/\./g, '')) : parseFloat(abs);
  }

  if (isNaN(num)) return null;
  return negativo ? -Math.abs(num) : Math.abs(num);
}

// Normaliza texto a minúsculas sin tildes (Fase 1.2)
function normText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Aliases de columnas por tipo (Fase 1.1) ─────────────────────────────────
const COL_CARGO = ['cargo', 'cargos', 'debito', 'debitos'];
const COL_ABONO = ['abono', 'abonos', 'credito', 'creditos'];
const COL_SALDO = ['saldo', 'balance', 'saldo final', 'saldo disponible'];
// Regla 1: Docto. NUNCA es un monto. Aliases variados según banco.
const COL_DOCTO = ['docto', 'n° doc', 'n°doc', 'nro. doc', 'nro.doc', 'documento', 'nro', 'n°', 'num doc', 'num'];

function buscarAlias(normLine, aliases) {
  for (const alias of aliases) {
    const idx = normLine.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

// ─── Detectar encabezado de tabla en el PDF (Fase 1) ─────────────────────────
function detectarEncabezado(lineas) {
  for (let i = 0; i < lineas.length; i++) {
    const norm  = normText(lineas[i]);
    const cargo = buscarAlias(norm, COL_CARGO);
    const abono = buscarAlias(norm, COL_ABONO);
    if (cargo !== -1 && abono !== -1) {
      return {
        headerIdx: i,
        cargo,
        abono,
        saldo: buscarAlias(norm, COL_SALDO),
        docto: buscarAlias(norm, COL_DOCTO),
      };
    }
  }
  return { headerIdx: -1, cargo: -1, abono: -1, saldo: -1, docto: -1 };
}

// ─── Heurística de tipo por palabras clave (Fase 6 — PDF desalineado) ────────
// Regla 2: tipo por columna es prioritario. Este fallback aplica solo cuando
// no hay encabezado detectado y el monto tampoco tiene signo.
const KW_INGRESO = ['abono', 'deposito', 'transferencia recibida', 'credito', 'remuneracion', 'sueldo', 'devolucion'];
const KW_EGRESO  = ['pago', 'cargo', 'debito', 'retiro', 'cuota', 'comision', 'impuesto', 'compra', 'giro'];

function inferirTipoPorDescripcion(descripcion) {
  const d = normText(descripcion);
  for (const kw of KW_INGRESO) { if (d.includes(kw)) return 'ingreso'; }
  for (const kw of KW_EGRESO)  { if (d.includes(kw)) return 'egreso'; }
  return 'egreso'; // default conservador (Fase 3.3)
}

// ─── Descripciones de fila que deben descartarse (Fase 6) ────────────────────
const SKIP_DESC_RE = /^(saldo anterior|saldo inicial|total |subtotal|totales|resumen)/;

// ─── Parseo línea por línea (Fases 2–4) ──────────────────────────────────────
function parsearLineas(texto) {
  const lineas = texto.split('\n');
  const transacciones = [];

  // Fase 1: detectar encabezado y posiciones de columnas
  const enc = detectarEncabezado(lineas);
  // midpoint entre Cargo y Abono para clasificar montos (Fase 3.3)
  const midpoint = (enc.cargo !== -1 && enc.abono !== -1)
    ? (enc.cargo + enc.abono) / 2
    : -1;

  // Fases 2-4: procesar cada línea con fecha
  for (let i = 0; i < lineas.length; i++) {
    if (i === enc.headerIdx) continue;

    const lineaRaw  = lineas[i];   // sin trim → preserva posiciones de chars para columnas
    const lineaTrim = lineaRaw.trim();
    if (!lineaTrim) continue;

    const fecha = extraerFecha(lineaTrim);
    if (!fecha) continue;

    // ── Fase 3.2: numero_documento ────────────────────────────────────────────
    // Regla 1: extraer desde zona Docto→Cargo como texto, nunca como monto.
    // Soporta alfanumérico (DOC-12345) además de numérico puro (Regla 3.2).
    let numeroDocumento = null;
    if (enc.docto !== -1 && enc.cargo !== -1) {
      const desde  = Math.max(0, enc.docto - 2);
      const hasta  = enc.cargo - 1;
      const zona   = lineaRaw.slice(desde, hasta);
      const mDocto = zona.match(/\w[\w\-]*/);  // captura 12345 o DOC-12345 o TRF-001
      if (mDocto) numeroDocumento = mDocto[0];
    }

    // ── Fase 3.3: montos con posición ─────────────────────────────────────────
    // Filtrar zona pre-cargo descarta: fecha, Docto. y números de la descripción.
    // Regla 9: números dentro de la descripción NO son montos.
    // Regla 8: parseMonto ya maneja notación entre paréntesis.
    const MONTO_POS_RE = /\([\d.,]+\)|[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g;
    const montosConPos = [];
    let match;
    while ((match = MONTO_POS_RE.exec(lineaRaw)) !== null) {
      const v = parseMonto(match[0]);
      if (v === null || v === 0) continue;
      // Solo aceptar montos a partir de la columna Cargo (filtra fecha, docto, desc)
      if (enc.cargo !== -1 && match.index < enc.cargo - 5) continue;
      montosConPos.push({ val: v, pos: match.index });
    }

    if (montosConPos.length === 0) continue;

    // Regla 4 (saldo = último número de la fila)
    const saldoPosterior = montosConPos.length > 1
      ? montosConPos[montosConPos.length - 1].val
      : null;

    // ── Fase 3.5: descripción ─────────────────────────────────────────────────
    // Regla 9: solo eliminar números de la zona de montos (desde columna Cargo),
    // NO de la zona de descripción. Preserva "CUOTA 3/12", "FACTURA 2026-001", etc.
    let descripcion;
    if (enc.cargo !== -1) {
      // Tomar solo hasta el inicio de la zona de montos
      const descEnd = enc.docto !== -1
        ? Math.max(0, enc.docto - 2)   // si hay docto, la desc termina ahí
        : Math.max(0, enc.cargo - 5);  // si no, la desc termina antes del cargo
      const zonaDesc = lineaRaw.slice(0, descEnd);
      descripcion = zonaDesc
        .replace(FECHA_RE[0], '').replace(FECHA_RE[1], '').replace(FECHA_RE[2], '')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // Sin info de columnas: eliminar todos los números como antes (fallback)
      descripcion = lineaTrim
        .replace(FECHA_RE[0], '').replace(FECHA_RE[1], '').replace(FECHA_RE[2], '')
        .replace(/\([\d.,]+\)|[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Regla 10: concatenar línea siguiente si no tiene fecha (descripción cortada)
    if (descripcion.length < 5 && i + 1 < lineas.length) {
      const next = lineas[i + 1].trim();
      if (next && !extraerFecha(next)) {
        descripcion = (descripcion + ' ' + next).trim();
        i++;
      }
    }

    // Fase 4: validación — descartar filas de totales/resúmenes (Fase 6)
    if (descripcion.length < 3) continue;
    if (SKIP_DESC_RE.test(normText(descripcion))) continue;

    // ── Fase 3.3 + Fase 3.6: monto y tipo ────────────────────────────────────
    // Candidatos = todos los montos excepto el saldo (último)
    const candidatos = montosConPos.length > 1
      ? montosConPos.slice(0, -1)
      : montosConPos;

    let monto = null;
    let tipo  = null;

    if (midpoint !== -1 && candidatos.length > 0) {
      // Caso principal: detectar por posición de columna (Reglas 2 y 3)
      const txn = candidatos[candidatos.length - 1];
      monto = Math.abs(txn.val);
      tipo  = txn.pos < midpoint ? 'egreso' : 'ingreso';

    } else {
      // Fallback 1: signo del valor (Fase 3.3 — caso sin columnas detectadas)
      for (let j = candidatos.length - 1; j >= 0; j--) {
        const v = candidatos[j].val;
        if (v !== 0) {
          monto = Math.abs(v);
          tipo  = v < 0 ? 'egreso' : 'ingreso';
          break;
        }
      }
      // Fallback 2: único monto sin signo → heurística por palabras clave (Fase 6)
      if (!tipo && montosConPos.length >= 1) {
        monto = Math.abs(montosConPos[0].val);
        tipo  = inferirTipoPorDescripcion(descripcion);
      }
    }

    // Fase 4: validación final
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
    throw new Error('No se encontraron transacciones en el PDF. Verifique que sea una cartola bancaria con texto seleccionable.');
  }

  return transacciones;
}

module.exports = { procesarPDF };
