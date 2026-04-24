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

// ─── Estrategia de parseo línea por línea ────────────────────────────────────
function parsearLineas(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const transacciones = [];

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const fecha = extraerFecha(linea);
    if (!fecha) continue;

    // Extraer todos los montos de la línea
    const montos = [...(linea.matchAll(MONTO_RE) || [])].map(m => m[0]);
    if (montos.length === 0) continue;

    // Intentar combinar con la línea siguiente si la descripción es corta
    let descripcion = linea
      .replace(FECHA_RE[0], '').replace(FECHA_RE[1], '').replace(FECHA_RE[2], '')
      .replace(MONTO_RE, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (descripcion.length < 5 && i + 1 < lineas.length) {
      const next = lineas[i + 1];
      if (!extraerFecha(next)) {
        descripcion = (descripcion + ' ' + next).trim();
        i++;
      }
    }

    if (descripcion.length < 3) continue;

    // Lógica para determinar tipo desde los montos disponibles
    // Generalmente: último monto = saldo, penúltimo = transacción
    let monto = null;
    let tipo  = null;

    if (montos.length >= 2) {
      // Buscar el monto de la transacción (ignorar el saldo final)
      for (let j = montos.length - 2; j >= 0; j--) {
        const v = parseMonto(montos[j]);
        if (v !== null && v !== 0) {
          monto = Math.abs(v);
          tipo  = v < 0 ? 'egreso' : 'ingreso';
          break;
        }
      }
      // Si no se determinó tipo por signo, el último monto usable define tipo
      if (!tipo && montos.length === 2) {
        const v = parseMonto(montos[0]);
        if (v !== null) {
          monto = Math.abs(v);
          // Heurística: si el saldo aumentó respecto al monto → ingreso
          const saldo = parseMonto(montos[1]);
          tipo = saldo !== null && saldo > 0 ? 'ingreso' : 'egreso';
        }
      }
    } else if (montos.length === 1) {
      const v = parseMonto(montos[0]);
      if (v !== null && v !== 0) {
        monto = Math.abs(v);
        tipo  = 'egreso'; // sin contexto, default egreso
      }
    }

    if (!monto || !tipo) continue;

    transacciones.push({
      fecha_transaccion:       fecha,
      descripcion_original:    descripcion,
      descripcion_normalizada: descripcion.toLowerCase().replace(/\s+/g, ' ').trim(),
      tipo,
      monto_original:          monto,
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
