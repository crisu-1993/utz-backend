# UTZ Finance — Backend

## Qué es UTZ Finance

Plataforma financiera para PYMEs de América Latina. Permite a empresas subir documentos financieros (cartolas bancarias en Excel, CSV o PDF), procesarlos automáticamente y obtener un Estado de Resultados categorizado con IA.

- **Frontend:** Lovable (proyecto separado, ya existente)
- **Backend:** Este repositorio — Node.js + Express
- **Base de datos:** Supabase (PostgreSQL)
- **IA:** Claude (Anthropic) para categorización de transacciones

---

## Qué está construido hasta hoy (2026-04-24)

### Infraestructura
- Servidor Express en puerto 3001 con CORS habilitado
- Conexión a Supabase con `service_role` (acceso total)
- Variables de entorno via `.env`

### Base de datos (Supabase)
Dos tablas creadas con `migrations/001_create_tables.sql`:

| Tabla | Propósito |
|---|---|
| `transacciones_historicas` | Transacciones procesadas con categoría IA, monto, tipo, empresa |
| `importaciones_historicas` | Control de cada archivo subido: estado, tiempos, totales |

### Procesamiento de documentos (`src/services/documentProcessor/`)

| Archivo | Qué hace |
|---|---|
| `excelProcessor.js` | Parsea Excel/CSV de bancos chilenos. Detecta encabezados automáticamente (soporte para múltiples formatos: cargo/abono separados, monto único con signo, fechas en varios formatos) |
| `pdfProcessor.js` | Extrae texto de PDF y lo convierte a transacciones |
| `aiCategorizer.js` | Envía transacciones a Claude en lotes de 25. Clasifica en 11 categorías (3 ingresos, 8 egresos). Fallback automático si Claude falla |

### Categorías de IA disponibles
**Ingresos:** `venta_productos`, `venta_servicios`, `otros_ingresos`

**Egresos:** `remuneraciones`, `arriendo`, `marketing`, `servicios_basicos`, `proveedores`, `impuestos`, `gastos_financieros`, `otros_gastos`

### API REST (`src/routes/documents.js`)

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/` | Health check |
| `GET` | `/api/documents/test` | Verifica que el motor esté listo |
| `POST` | `/api/documents/process` | Descarga archivo de Supabase Storage, lo procesa y guarda transacciones |
| `GET` | `/api/documents/results/:empresa_id` | Devuelve transacciones agrupadas por categoría con totales (filtros: `desde`, `hasta`, `estado`) |

#### Body de `POST /api/documents/process`
```json
{
  "archivo_id": "ruta/en/storage.xlsx",
  "empresa_id": "uuid-de-la-empresa",
  "importacion_id": "uuid-opcional",
  "bucket_name": "documentos"
}
```

### Datos de prueba
- `cartola_prueba.xlsx` — cartola bancaria de ejemplo en la raíz
- `scripts/seed_test_data.js` — inserta 20 transacciones procesadas con IA
- Empresa de prueba fija: `00000000-0000-0000-0000-000000000001`

---

## Estructura del proyecto

```
utz-backend/
├── index.js                          # Entry point — Express + rutas
├── package.json
├── .env                              # Variables de entorno (no commitear)
├── .env.example                      # Plantilla de variables
├── cartola_prueba.xlsx               # Archivo de prueba
│
├── migrations/
│   └── 001_create_tables.sql         # SQL para crear tablas en Supabase
│
├── scripts/
│   └── seed_test_data.js             # Inserta 20 transacciones de prueba
│
└── src/
    ├── routes/
    │   └── documents.js              # Endpoints /api/documents/*
    ├── controllers/                  # (vacío — lógica está en routes por ahora)
    ├── services/
    │   └── documentProcessor/
    │       ├── excelProcessor.js     # Parseo de Excel/CSV
    │       ├── pdfProcessor.js       # Parseo de PDF
    │       └── aiCategorizer.js      # Categorización con Claude
    └── utils/                        # (vacío — disponible para helpers futuros)
```

---

## Variables de entorno

Crear un archivo `.env` en la raíz (copiar desde `.env.example`):

```env
SUPABASE_URL=https://gogcmpgflhcewtwmbden.supabase.co
SUPABASE_SERVICE_KEY=<service_role key de Supabase>
ANTHROPIC_API_KEY=<API key de Anthropic/Claude>
PORT=3001
```

- `SUPABASE_SERVICE_KEY`: se obtiene en Supabase → Project Settings → API → `service_role`
- `ANTHROPIC_API_KEY`: se obtiene en console.anthropic.com

---

## Cómo correr el servidor

```bash
# Instalar dependencias (solo la primera vez)
npm install

# Desarrollo (reinicia automáticamente al guardar)
npm run dev

# Producción
npm start
```

El servidor queda disponible en `http://localhost:3001`.

**Verificar que funciona:**
```bash
curl http://localhost:3001/
curl http://localhost:3001/api/documents/test
```

**Insertar datos de prueba** (requiere tablas ya creadas en Supabase):
```bash
node scripts/seed_test_data.js
```

**Consultar resultados de prueba:**
```bash
curl http://localhost:3001/api/documents/results/00000000-0000-0000-0000-000000000001
```

---

## Siguiente paso pendiente

Conectar el frontend (Lovable) con este backend:

1. **Subida de archivos:** Lovable sube el archivo a Supabase Storage y llama a `POST /api/documents/process` con el `archivo_id` y `empresa_id` del usuario autenticado.

2. **Visualización:** Lovable llama a `GET /api/documents/results/:empresa_id` para construir el Estado de Resultados con los datos categorizados.

3. **Autenticación real:** Reemplazar el `empresa_id` de prueba (`00000000-...`) por el UUID real del usuario autenticado en Supabase Auth.

4. **Revisión de transacciones:** Implementar endpoint `PATCH /api/documents/transactions/:id` para que el usuario pueda corregir la categoría sugerida por la IA (cambiar `estado` de `pendiente_revision` a `revisado`).
