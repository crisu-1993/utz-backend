'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// insightsDeterministico.js — Fuente canónica de generación determinística
// ─────────────────────────────────────────────────────────────────────────────
// Extraído textualmente de src/routes/insights.js (versión de producción).
// No importa nada de insights.js ni de insightsIA.js — módulo hoja puro.
// Consumidores: src/routes/insights.js y src/services/insightsIA.js.
// ─────────────────────────────────────────────────────────────────────────────

// Formateador de pesos chilenos para textos
function formatCLP(n) {
  const abs = Math.abs(Math.round(n));
  return `$${abs.toLocaleString('es-CL')}`;
}

// Tono según resultado neto
function tonoResultado(resultado_neto, entradas) {
  if (resultado_neto < 0) return 'negativo';
  if (entradas === 0) return 'neutro';
  const margen = (resultado_neto / entradas) * 100;
  if (margen >= 5) return 'positivo';
  if (margen >= 0) return 'neutro';
  return 'negativo';
}

// Tono según presión de salidas
function tonoPresion(razon) {
  if (razon < 70) return 'positivo';
  if (razon < 85) return 'neutro';
  if (razon < 100) return 'atencion';
  return 'negativo';
}

// Insight 1: Resultado del mes
function insightResultado(metricas) {
  const { entradas, salidas, resultado_neto, margen_caja } = metricas;
  const tono = tonoResultado(resultado_neto, entradas);

  let texto;
  if (entradas === 0 && salidas === 0) {
    texto = 'En este período no hay movimientos registrados.';
  } else if (resultado_neto < 0) {
    texto = `Entraron ${formatCLP(entradas)} y salieron ${formatCLP(salidas)}. El resultado neto de caja fue negativo en ${formatCLP(Math.abs(resultado_neto))}: las salidas superaron a las entradas del período.`;
  } else if (entradas > 0 && resultado_neto > 0 && margen_caja < 2) {
    texto = `Entraron ${formatCLP(entradas)} y salieron ${formatCLP(salidas)}. El mes cerró casi en equilibrio, con un resultado neto positivo de ${formatCLP(resultado_neto)}.`;
  } else if (entradas > 0) {
    texto = `Entraron ${formatCLP(entradas)} y salieron ${formatCLP(salidas)}. El resultado neto de caja fue positivo en ${formatCLP(resultado_neto)}, equivalente a un margen de caja del ${margen_caja.toFixed(0)}%.`;
  } else {
    texto = `En este período no hubo entradas registradas. Las salidas fueron de ${formatCLP(salidas)}.`;
  }

  return {
    id: 'resultado_mes',
    titulo: 'Resultado del mes',
    texto,
    tono,
  };
}

// Insight 2: Presión de salidas
function insightPresion(metricas) {
  const { entradas, razon_salidas } = metricas;
  if (entradas === 0) return null;

  const por100 = Math.round(razon_salidas);
  const tono = tonoPresion(razon_salidas);

  let texto;
  if (razon_salidas < 70) {
    texto = `Por cada $100 que entraron, salieron $${por100}. Con los datos cargados, el negocio mantuvo una buena holgura de caja durante el período.`;
  } else if (razon_salidas < 85) {
    texto = `Por cada $100 que entraron, salieron $${por100}. La operación se mantiene positiva, aunque una parte relevante de las entradas se usó para cubrir salidas.`;
  } else if (razon_salidas < 100) {
    texto = `Por cada $100 que entraron, salieron $${por100}. La caja quedó ajustada: hubo resultado positivo, pero con poco espacio de maniobra.`;
  } else {
    texto = `Por cada $100 que entraron, salieron $${por100}. En este período, las salidas superaron a las entradas.`;
  }

  return {
    id: 'presion_salidas',
    titulo: 'Presión de salidas',
    texto,
    tono,
  };
}

// Insight 3: Evolución vs período anterior
function insightEvolucion(varEntradas, varSalidas, varResultado) {
  if (varEntradas == null || varSalidas == null) return null;

  let texto, tono;

  if (varEntradas > 0 && varResultado > 0 && varSalidas <= varEntradas) {
    texto = `Las entradas subieron ${Math.abs(varEntradas)}% y las salidas aumentaron ${Math.abs(varSalidas)}%. El resultado neto mejoró, porque las entradas crecieron más rápido que las salidas.`;
    tono = 'positivo';
  } else if (varEntradas > 0 && varSalidas > varEntradas) {
    texto = `Las entradas subieron ${Math.abs(varEntradas)}%, pero las salidas aumentaron ${Math.abs(varSalidas)}%. El negocio movió más dinero, pero no logró convertir ese crecimiento en un mejor resultado neto.`;
    tono = 'atencion';
  } else if (varEntradas < 0 && Math.abs(varSalidas) < Math.abs(varEntradas)) {
    texto = `Las entradas bajaron ${Math.abs(varEntradas)}%, mientras las salidas solo bajaron ${Math.abs(varSalidas)}%. Esto redujo el resultado neto y dejó la caja más ajustada que el mes anterior.`;
    tono = 'atencion';
  } else if (varEntradas < 0 && Math.abs(varSalidas) >= Math.abs(varEntradas)) {
    texto = `Las entradas bajaron ${Math.abs(varEntradas)}% y las salidas también se redujeron ${Math.abs(varSalidas)}%. El resultado neto se mantiene relativamente estable.`;
    tono = 'neutro';
  } else {
    texto = `Frente al período anterior, las entradas variaron ${varEntradas >= 0 ? '+' : ''}${varEntradas}% y las salidas ${varSalidas >= 0 ? '+' : ''}${varSalidas}%.`;
    tono = 'neutro';
  }

  return {
    id: 'evolucion',
    titulo: 'Evolución frente al período anterior',
    texto,
    tono,
  };
}

// Recomendación 1: Revisar salidas
function recRevisarSalidas(metricas, varSalidas, varEntradas) {
  const condicion1 = metricas.razon_salidas > 85;
  const condicion2 = (varSalidas != null && varEntradas != null && varSalidas > varEntradas && varEntradas >= 0);

  if (!condicion1 && !condicion2) return null;

  return {
    id: 'revisar_salidas',
    titulo: 'Antes de enfocarte solo en vender más',
    texto: 'Revisa las principales salidas del período. Si las salidas siguen consumiendo una parte alta de las entradas, mayores ventas podrían no traducirse en mejor caja.',
    tono: 'atencion',
  };
}

// Recomendación 2: Recuperar entradas
function recRecuperarEntradas(metricas, varEntradas) {
  const margenBajo = metricas.margen_caja >= 0 && metricas.margen_caja <= 10;
  const razonControlada = metricas.razon_salidas < 85;
  const entradasCayeron = varEntradas != null && varEntradas < 0;

  if (!(margenBajo && razonControlada && entradasCayeron)) return null;

  return {
    id: 'recuperar_entradas',
    titulo: 'El foco está en recuperar ventas',
    texto: 'Tus salidas están relativamente controladas, pero el nivel de entradas del período deja poco espacio para resultado positivo. Lo que el negocio necesita ahora es recuperar volumen de ingresos.',
    tono: 'neutro',
  };
}

// ─── Wrapper determinístico ──────────────────────────────────────────────────

function generarDeterministico(metricas, comparacion) {
  const varEntradas  = comparacion.disponible ? comparacion.var_entradas_pct  : null;
  const varSalidas   = comparacion.disponible ? comparacion.var_salidas_pct   : null;
  const varResultado = comparacion.disponible ? comparacion.var_resultado_pct : null;

  const insights = [];
  const i1 = insightResultado(metricas);
  if (i1) insights.push(i1);
  const i2 = insightPresion(metricas);
  if (i2) insights.push(i2);
  const i3 = insightEvolucion(varEntradas, varSalidas, varResultado);
  if (i3) insights.push(i3);

  const recomendaciones = [];
  const r1 = recRevisarSalidas(metricas, varSalidas, varEntradas);
  if (r1) recomendaciones.push(r1);
  const r2 = recRecuperarEntradas(metricas, varEntradas);
  if (r2) recomendaciones.push(r2);

  return { insights, recomendaciones };
}

module.exports = { generarDeterministico };
