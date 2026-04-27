const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Taxonomía de categorías ─────────────────────────────────────────────────
const CATEGORIAS = {
  ingresos: [
    'venta_productos',
    'venta_servicios',
    'otros_ingresos',
  ],
  egresos: [
    'remuneraciones',
    'arriendo',
    'marketing',
    'servicios_basicos',
    'proveedores',
    'impuestos',
    'gastos_financieros',
    'otros_gastos',
  ],
};

const TODAS_CATEGORIAS = [...CATEGORIAS.ingresos, ...CATEGORIAS.egresos];

const SISTEMA_PROMPT = `Eres un experto en contabilidad para PYMEs de América Latina, especializado en clasificar transacciones bancarias de empresas chilenas.

Tu tarea: clasificar transacciones en las siguientes categorías exactas.

INGRESOS:
- venta_productos: Ventas de bienes físicos, mercaderías
- venta_servicios: Pagos por servicios prestados, honorarios recibidos
- otros_ingresos: Intereses ganados, arriendos cobrados, otros ingresos no clasificados

EGRESOS:
- remuneraciones: Sueldos, salarios, gratificaciones, cotizaciones previsionales
- arriendo: Pago de arriendos de oficinas, bodegas, locales
- marketing: Publicidad, diseño, redes sociales, marketing digital
- servicios_basicos: Electricidad, agua, internet, telefonía, gas
- proveedores: Compra de materiales, insumos, mercadería, servicios de terceros
- impuestos: SII, IVA, PPM, contribuciones, impuestos municipales
- gastos_financieros: Comisiones bancarias, intereses préstamos, cuotas leasing
- otros_gastos: Gastos que no encajan en las categorías anteriores

IMPORTANTE:
- Los registros en columna 'Cargos' son egresos (tipo: 'egreso', monto positivo).
- Los registros en columna 'Abonos' son ingresos (tipo: 'ingreso', monto positivo).
- NUNCA uses el campo Docto. como monto. La columna 'Docto.' o 'Nro. Documento' es un identificador interno, no un monto.

Responde SIEMPRE con un JSON válido en el formato especificado. No agregues explicaciones fuera del JSON.`;

// Envía un lote de transacciones a Claude y retorna las categorizadas
async function categorizarLote(transacciones) {
  const listaTexto = transacciones.map((t, i) =>
    `${i + 1}. [${t.tipo.toUpperCase()}] ${t.fecha_transaccion} | ${t.descripcion_original} | $${t.monto_original.toLocaleString('es-CL')}`
  ).join('\n');

  const respuesta = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: SISTEMA_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Clasifica estas ${transacciones.length} transacciones bancarias de una empresa chilena.

TRANSACCIONES:
${listaTexto}

Responde con este JSON exacto (un objeto por transacción, en el mismo orden):
{
  "resultados": [
    {
      "indice": 1,
      "categoria": "<categoría_exacta>",
      "confianza": <número entre 0 y 1>,
      "razon": "<explicación breve en español>"
    }
  ]
}`,
      },
    ],
  });

  // Extraer y parsear el JSON de la respuesta
  const textContent = respuesta.content.find(b => b.type === 'text');
  if (!textContent) throw new Error('Claude no retornó texto.');

  const texto = textContent.text.trim();

  // Extraer JSON aunque venga envuelto en markdown
  const jsonMatch = texto.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude no retornó JSON válido.');

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Error al parsear JSON de Claude: ${e.message}`);
  }

  if (!parsed.resultados || !Array.isArray(parsed.resultados)) {
    throw new Error('Formato de respuesta inesperado de Claude.');
  }

  return parsed.resultados;
}

// ─── Exportación principal ───────────────────────────────────────────────────
async function categorizarTransacciones(transacciones, opciones = {}) {
  const TAMANO_LOTE = opciones.tamanoLote || 25;
  const transaccionesConCategoria = [...transacciones];

  // Procesar en lotes para evitar prompts demasiado grandes
  for (let i = 0; i < transacciones.length; i += TAMANO_LOTE) {
    const lote = transacciones.slice(i, i + TAMANO_LOTE);
    const indiceBase = i;

    let resultados;
    try {
      resultados = await categorizarLote(lote);
    } catch (err) {
      console.error(`Error al categorizar lote ${i}-${i + TAMANO_LOTE}:`, err.message);
      // En caso de error, asignar categoría por defecto según tipo
      resultados = lote.map((t, j) => ({
        indice: j + 1,
        categoria: t.tipo === 'ingreso' ? 'otros_ingresos' : 'otros_gastos',
        confianza: 0.3,
        razon: 'Categorizado por defecto debido a error en IA',
      }));
    }

    // Aplicar resultados al array principal
    resultados.forEach(r => {
      const idx = indiceBase + r.indice - 1;
      if (idx >= 0 && idx < transaccionesConCategoria.length) {
        const categoriaValida = TODAS_CATEGORIAS.includes(r.categoria);
        transaccionesConCategoria[idx] = {
          ...transaccionesConCategoria[idx],
          categoria_sugerida_ia: categoriaValida
            ? r.categoria
            : (transacciones[idx].tipo === 'ingreso' ? 'otros_ingresos' : 'otros_gastos'),
          confianza_deteccion: typeof r.confianza === 'number'
            ? Math.min(1, Math.max(0, r.confianza))
            : 0.5,
          razon_categoria: r.razon || '',
        };
      }
    });

    // Pausa breve entre lotes si hay más por procesar
    if (i + TAMANO_LOTE < transacciones.length) {
      await new Promise(res => setTimeout(res, 300));
    }
  }

  return transaccionesConCategoria;
}

module.exports = { categorizarTransacciones };
