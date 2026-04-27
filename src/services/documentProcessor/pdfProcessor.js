const pdfParse = require('pdf-parse');

// ─── Patrones de fecha para cartolas bancarias chilenas ──────────────────────
const FECHA_RE = [
  /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/,   // DD/MM/YYYY o DD-MM-YYYY
  /(\d{4})[\/\-](\d{2})[\/\-](\d{2})/,   // YYYY-MM-DD
  /(\d{2})[\/\-](\d{2})[\/\-](\d{2})/,   // DD/MM/YY
];

// Patrones de monto: "1.234.567", "1,234,567.89", "$1.234", "-1.234,56"
const MONTO_RE = /[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g;

function normalizarFecha(match, fmt) {
  if (fmt === 0) {
    // DD/MM/YYYY
    return `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  if (fmt === 1) {
    // YYYY-MM-DD
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  if (fmt === 2) {
    // DD/MM/YY
    const year = parseInt(match[3]) > 50 ? `19${match[3]}` : `20${match[3]}`;
    return `${year}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  }
  return null;
}

// Extrae la primera fecha válida de un texto
function extraerFecha(texto) {
  for (let i = 0; i < FECHA_RE.length; i++) {
    const m = texto.match(FECHA_RE[i]);
    if (m) return normalizarFecha(m, i);
  }
  return null;
}

// Limpia un monto y retorna valor numérico
function parseMonto(s) {
  const limpio = s.replace(/[$\s+]/g, '');
  const negativo = limpio.startsWith('-');
  const abs = limpio.replace('-', '');

  // Detecta formato: si hay coma antes del punto → formato europeo/chileno
  const contienePoint = abs.includes('.');
  const contieneComa  = abs.includes(',');

  let num;
  if (contienePoint && contieneComa) {
    // Determinar cuál es el separador decimal
    const lastPoint = abs.lastIndexOf('.');
    const lastComa  = abs.lastIndexOf(',');
    if (lastComa > lastPoint) {
      // 1.234,56 → formato chileno
      num = parseFloat(abs.replace(/\./g, '').replace(',', '.'));
    } else {
      // 1,234.56 → formato anglosajón
      num = parseFloat(abs.replace(/,/g, ''));
    }
  } else if (contieneComa && !contienePoint) {
    // Puede ser separador de miles (1,234) o decimal (1,5)
    const partes = abs.split(',');
    if (partes.length === 2 && partes[1].length <= 2) {
      num = parseFloat(abs.replace(',', '.'));
    } else {
      num = parseFloat(abs.replace(/,/g, ''));
    }
  } else {
    // Solo punto — puede ser miles (1.234) o decimal (1.23)
    const partes = abs.split('.');
    if (partes.length === 2 && partes[1].length === 3) {
      // 1.234 → miles
      num = parseFloat(abs.replace(/\./g, ''));
    } else {
      num = parseFloat(abs);
    }
  }

  if (isNaN(num)) return null;
  return negativo ? -Math.abs(num) : Math.abs(num);
}

// Normaliza texto quitando tildes y pasando a minúsculas
function normText(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─── Estrategia de parseo línea por línea ────────────────────────────────────
function parsearLineas(texto) {
  const lineas = texto.split('\n');
  const transacciones = [];

  // ── Paso 1: detectar posición de columnas Cargos / Abonos en el encabezado ──
  let cargosPos = -1;
  let abonosPos = -1;
  let headerIdx = -1;

  for (let i = 0; i < lineas.length; i++) {
    const norm = normText(lineas[i]);
    const ci = norm.indexOf('cargo');  // cubre 'cargo' y 'cargos'
    const ai = norm.indexOf('abono');  // cubre 'abono' y 'abonos'
    if (ci !== -1 && ai !== -1) {
      cargosPos = ci;
      abonosPos = ai;
      headerIdx = i;
      break;
    }
  }

  // Punto medio entre las dos columnas: monto antes → egreso, después → ingreso
  const midpoint = (cargosPos !== -1 && abonosPos !== -1)
    ? (cargosPos + abonosPos) / 2
    : -1;

  // ── Paso 2: parsear cada línea de transacción ─────────────────────────────
  for (let i = 0; i < lineas.length; i++) {
    if (i === headerIdx) continue;

    const lineaRaw = lineas[i]; // sin trim para preservar posiciones de caracteres
    const lineaTrim = lineaRaw.trim();
    if (!lineaTrim) continue;

    const fecha = extraerFecha(lineaTrim);
    if (!fecha) continue;

    // Extraer montos con su posición en la línea original
    const MONTO_POS_RE = /[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g;
    const montosConPos = [];
    let match;
    while ((match = MONTO_POS_RE.exec(lineaRaw)) !== null) {
      const v = parseMonto(match[0]);
      if (v === null || v === 0) continue;
      // Si hay columnas detectadas, ignorar números antes de la zona de montos
      // (descarta componentes de fecha y números en la descripción)
      if (cargosPos !== -1 && match.index < cargosPos - 5) continue;
      montosConPos.push({ val: v, pos: match.index });
    }

    if (montosConPos.length === 0) continue;

    // Construir descripción eliminando fecha y montos
    let descripcion = lineaTrim
      .replace(FECHA_RE[0], '').replace(FECHA_RE[1], '').replace(FECHA_RE[2], '')
      .replace(/[-+]?\$?\s*[\d.,]+(?:\.\d{1,2}|,\d{1,2})?/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (descripcion.length < 5 && i + 1 < lineas.length) {
      const next = lineas[i + 1].trim();
      if (next && !extraerFecha(next)) {
        descripcion = (descripcion + ' ' + next).trim();
        i++;
      }
    }

    if (descripcion.length < 3) continue;

    let monto = null;
    let tipo  = null;

    if (midpoint !== -1) {
      // ── Detección por columna ────────────────────────────────────────────
      // El último monto es el saldo: ignorarlo si hay más de uno
      const candidatos = montosConPos.length > 1
        ? montosConPos.slice(0, -1)
        : montosConPos;

      if (candidatos.length > 0) {
        const txn = candidatos[candidatos.length - 1];
        monto = Math.abs(txn.val);
        tipo  = txn.pos < midpoint ? 'egreso' : 'ingreso';
      }

    } else {
      // ── Fallback: signo del monto o heurística de saldo ─────────────────
      if (montosConPos.length >= 2) {
        for (let j = montosConPos.length - 2; j >= 0; j--) {
          const v = montosConPos[j].val;
          if (v !== 0) {
            monto = Math.abs(v);
            tipo  = v < 0 ? 'egreso' : 'ingreso';
            break;
          }
        }
        if (!tipo) {
          const v     = montosConPos[0].val;
          const saldo = montosConPos[montosConPos.length - 1].val;
          monto = Math.abs(v);
          tipo  = (saldo !== null && saldo > 0) ? 'ingreso' : 'egreso';
        }
      } else {
        const v = montosConPos[0].val;
        if (v !== 0) {
          monto = Math.abs(v);
          tipo  = 'egreso'; // sin contexto suficiente, default egreso
        }
      }
    }

    if (!monto || !tipo) continue;

    transacciones.push({
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      tipo,
      monto_original:          monto,
      moneda_origen:           'CLP',
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
