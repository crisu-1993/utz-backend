// src/routes/insights.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const router = express.Router();
const {
  calcularRango,
  calcularRangoAnterior,
  calcularRangoMes,
  variacionPct,
  consultarPeriodo,
} = require('../utils/periodos');
const {
  evaluarDatosSuficientes,
  leerCache,
  guardarCache,
  borrarCache,
  construirContextoMes,
  generarInsightsIA,
} = require('../services/insightsIA');
const { generarDeterministico } = require('../services/insightsDeterministico');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Suma entradas y salidas de un array de transacciones
function sumarTotales(transacciones) {
  let entradas = 0, salidas = 0;
  for (const tx of transacciones) {
    const monto = Number(tx.monto_original) || 0;
    if (tx.tipo === 'ingreso') entradas += monto;
    else if (tx.tipo === 'egreso') salidas += monto;
  }
  return { entradas, salidas };
}

// ─── GET /api/insights/:empresa_id ───────────────────────────────────────────
router.get('/:empresa_id', async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { periodo, mes, anio, inicio, fin } = req.query;

    const supabase = getSupabase();

    // Determinar rango actual
    let fechaInicio, fechaFin, mesNum, anioNum;
    if (mes && anio) {
      mesNum  = parseInt(mes);
      anioNum = parseInt(anio);
      const r = calcularRangoMes(anioNum, mesNum);
      fechaInicio = r.fecha_inicio;
      fechaFin    = r.fecha_fin;
    } else if (inicio && fin) {
      fechaInicio = inicio;
      fechaFin    = fin;
    } else {
      const periodoElegido = periodo || 'mes';
      const r = calcularRango(periodoElegido);
      fechaInicio = r.fecha_inicio;
      fechaFin    = r.fecha_fin;
    }

    // ── Detección de mes corriente (zona horaria Chile) ─────────────────────
    const esMesConcreto = !!(mesNum && anioNum);
    let esMesActual = false;
    if (esMesConcreto) {
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
      esMesActual = (mesNum === ahora.getMonth() + 1 && anioNum === ahora.getFullYear());
    }

    // ── Cache: solo para meses concretos no actuales ────────────────────────
    if (esMesConcreto && !esMesActual) {
      const cached = await leerCache(empresa_id, mesNum, anioNum, supabase);
      if (cached) {
        console.log(`[/insights] Cache HIT ${empresa_id} ${mesNum}/${anioNum}`);
        return res.json({
          ok: true,
          fuente: 'cache',
          data: {
            periodo:        { inicio: fechaInicio, fin: fechaFin },
            metricas:       cached.metricas,
            comparacion:    cached.comparacion || { disponible: false },
            insights:       cached.insights,
            recomendaciones: cached.recomendaciones,
          },
        });
      }
    }

    // ── Datos frescos (determinístico base + insumo para IA) ────────────────
    const txActual = await consultarPeriodo(supabase, empresa_id, fechaInicio, fechaFin);
    const { entradas, salidas } = sumarTotales(txActual);
    const resultado_neto = entradas - salidas;
    const margen_caja    = entradas > 0 ? (resultado_neto / entradas) * 100 : 0;
    const razon_salidas  = entradas > 0 ? (salidas / entradas) * 100 : 0;

    const metricas = { entradas, salidas, resultado_neto, margen_caja, razon_salidas };

    // Período anterior
    let varEntradas = null, varSalidas = null, varResultado = null;
    let comparacion = { disponible: false };

    try {
      let rangoAnt = null;
      if (mesNum && anioNum) {
        const mesAnt  = mesNum === 1 ? 12 : mesNum - 1;
        const anioAnt = mesNum === 1 ? anioNum - 1 : anioNum;
        rangoAnt = calcularRangoMes(anioAnt, mesAnt);
      } else if (periodo) {
        rangoAnt = calcularRangoAnterior(periodo);
      }

      if (rangoAnt) {
        const txAnt    = await consultarPeriodo(supabase, empresa_id, rangoAnt.fecha_inicio, rangoAnt.fecha_fin);
        const totalAnt = sumarTotales(txAnt);
        const resultadoAnt = totalAnt.entradas - totalAnt.salidas;

        if (totalAnt.entradas > 0 || totalAnt.salidas > 0) {
          varEntradas  = variacionPct(entradas, totalAnt.entradas);
          varSalidas   = variacionPct(salidas, totalAnt.salidas);
          varResultado = variacionPct(resultado_neto, resultadoAnt);
          comparacion  = {
            disponible: true,
            var_entradas_pct:  varEntradas,
            var_salidas_pct:   varSalidas,
            var_resultado_pct: varResultado,
          };
        }
      }
    } catch (errAnt) {
      console.error('[/insights] Error consultando período anterior:', errAnt.message);
    }

    // ── Flujo IA (solo para meses concretos no actuales) ────────────────────
    if (esMesConcreto && !esMesActual) {
      const evaluacion = await evaluarDatosSuficientes(empresa_id, mesNum, anioNum, supabase);

      if (evaluacion.suficientes) {
        try {
          const contexto = await construirContextoMes(empresa_id, mesNum, anioNum, supabase);
          const resultadoIA = await generarInsightsIA({ empresa_id, mes: mesNum, anio: anioNum, contexto });

          if (resultadoIA.ok) {
            // Guardar en cache como 'ia'
            await guardarCache({
              empresa_id, mes: mesNum, anio: anioNum, tipo: 'ia',
              insights: resultadoIA.insights,
              recomendaciones: resultadoIA.recomendaciones,
              metricas: resultadoIA.metricas || metricas,
              comparacion: resultadoIA.comparacion || comparacion,
              modelo_usado: resultadoIA.modelo_usado,
              tokens_input: resultadoIA.tokens_input,
              tokens_output: resultadoIA.tokens_output,
              latencia_ms: resultadoIA.latencia_ms,
            }, supabase);

            return res.json({
              ok: true,
              fuente: 'ia',
              data: {
                periodo:        { inicio: fechaInicio, fin: fechaFin },
                metricas:       resultadoIA.metricas || metricas,
                comparacion:    resultadoIA.comparacion || comparacion,
                insights:       resultadoIA.insights,
                recomendaciones: resultadoIA.recomendaciones,
              },
            });
          }

          // IA falló → fallback determinístico
          console.warn(`[/insights] IA falló (${resultadoIA.error}), fallback determinístico`);
        } catch (errIA) {
          console.error('[/insights] Error inesperado en flujo IA:', errIA.message);
        }
      }

      // Datos insuficientes O IA falló → determinístico + cache
      const det = generarDeterministico(metricas, comparacion);
      await guardarCache({
        empresa_id, mes: mesNum, anio: anioNum, tipo: 'deterministico',
        insights: det.insights,
        recomendaciones: det.recomendaciones,
        metricas,
        comparacion,
      }, supabase);

      return res.json({
        ok: true,
        fuente: 'deterministico',
        data: {
          periodo:        { inicio: fechaInicio, fin: fechaFin },
          metricas,
          comparacion,
          insights:       det.insights,
          recomendaciones: det.recomendaciones,
        },
      });
    }

    // ── Mes actual o rango libre → siempre determinístico fresco (sin cache)
    const det = generarDeterministico(metricas, comparacion);

    return res.json({
      ok: true,
      fuente: 'deterministico',
      data: {
        periodo:        { inicio: fechaInicio, fin: fechaFin },
        metricas,
        comparacion,
        insights:       det.insights,
        recomendaciones: det.recomendaciones,
      },
    });
  } catch (err) {
    console.error('[/insights] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /api/insights/:empresa_id/:mes/:anio ────────────────────────────
router.delete('/:empresa_id/:mes/:anio', async (req, res) => {
  try {
    const supabase = getSupabase();
    const empresa_id = req.params.empresa_id;
    const mes = parseInt(req.params.mes, 10);
    const anio = parseInt(req.params.anio, 10);

    // Validaciones
    if (!empresa_id || isNaN(mes) || isNaN(anio)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }
    if (mes < 1 || mes > 12) {
      return res.status(400).json({ ok: false, error: 'mes debe estar entre 1 y 12' });
    }
    if (anio < 2020 || anio > 2100) {
      return res.status(400).json({ ok: false, error: 'anio fuera de rango' });
    }

    const resultado = await borrarCache(empresa_id, mes, anio, supabase);

    console.log(`[/insights DELETE] empresa=${empresa_id} mes=${mes}/${anio} ok=${resultado.ok}`);

    return res.json({ ok: true, borrado: resultado.ok });
  } catch (err) {
    console.error('[/insights DELETE] Error:', err.message);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

module.exports = Object.assign(router, { generarDeterministico });
