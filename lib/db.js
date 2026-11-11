const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// En Vercel Serverless el único directorio escribible en tiempo de ejecución es /tmp
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'sistema-asistencias-data')
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'asistencias.db');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH);

// Optimización SQLite para aprovechar todos los recursos del equipo
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;
`);

// Esquema de tablas iniciales
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS campos_catalogo (
    codigo TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    icono TEXT DEFAULT '📋',
    descripcion TEXT DEFAULT '',
    es_sistema INTEGER NOT NULL DEFAULT 0,
    orden INTEGER NOT NULL DEFAULT 100,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalogos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categoria TEXT NOT NULL,
    nombre TEXT NOT NULL,
    codigo TEXT DEFAULT '',
    activo INTEGER NOT NULL DEFAULT 1,
    orden INTEGER NOT NULL DEFAULT 100,
    creado_en TEXT NOT NULL,
    UNIQUE(categoria, nombre)
  );

  CREATE TABLE IF NOT EXISTS eventos (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    tema TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    direccion_organiza TEXT DEFAULT '',
    unidades_invitadas TEXT DEFAULT '[]',
    lugar TEXT DEFAULT '',
    tipo TEXT DEFAULT 'Presencial',
    proceso_iso TEXT DEFAULT '',
    planificacion TEXT DEFAULT '',
    organizador TEXT DEFAULT '',
    descripcion TEXT DEFAULT '',
    duracion_ventana_min INTEGER NOT NULL DEFAULT 30,
    estado_manual TEXT NOT NULL DEFAULT 'AUTO',
    logo_izquierdo_custom TEXT DEFAULT '',
    logo_derecho_custom TEXT DEFAULT '',
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asistencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evento_id TEXT NOT NULL,
    unidad TEXT NOT NULL,
    cargo TEXT DEFAULT '',
    sexo TEXT DEFAULT '',
    tema TEXT NOT NULL,
    nombre TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    firma_base64 TEXT NOT NULL,
    ip_dispositivo TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    registrado_en TEXT NOT NULL,
    FOREIGN KEY (evento_id) REFERENCES eventos(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_catalogos_cat ON catalogos(categoria, activo);
  CREATE INDEX IF NOT EXISTS idx_eventos_token ON eventos(token);
  CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos(fecha, hora);
  CREATE INDEX IF NOT EXISTS idx_asistencias_evento ON asistencias(evento_id);
  CREATE INDEX IF NOT EXISTS idx_asistencias_unidad ON asistencias(unidad);
  CREATE INDEX IF NOT EXISTS idx_asistencias_fecha ON asistencias(fecha);
`);

// Migración segura de columnas nuevas si la base de datos ya existía
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('eventos', 'direccion_organiza', "TEXT DEFAULT ''");
ensureColumn('eventos', 'unidades_invitadas', "TEXT DEFAULT '[]'");
ensureColumn('eventos', 'tipo', "TEXT DEFAULT 'Presencial'");
ensureColumn('eventos', 'proceso_iso', "TEXT DEFAULT ''");
ensureColumn('eventos', 'planificacion', "TEXT DEFAULT ''");
ensureColumn('eventos', 'eliminado', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('eventos', 'eliminado_en', 'TEXT DEFAULT NULL');
ensureColumn('eventos', 'actualizado_en', "TEXT DEFAULT ''");

ensureColumn('asistencias', 'cargo', "TEXT DEFAULT ''");
ensureColumn('asistencias', 'sexo', "TEXT DEFAULT ''");
ensureColumn('asistencias', 'eliminado', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('asistencias', 'eliminado_en', 'TEXT DEFAULT NULL');
ensureColumn('asistencias', 'actualizado_en', "TEXT DEFAULT ''");

function getNowISO() {
  return new Date().toISOString();
}

// Zona horaria institucional por defecto: América Central / Nicaragua (UTC-6, sin horario de verano)
const APP_TZ_OFFSET = process.env.APP_TZ_OFFSET || '-06:00';
const APP_TZ_OFFSET_MINUTES = -360;

function toLocalShiftedDate(date = new Date()) {
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return new Date(ms + APP_TZ_OFFSET_MINUTES * 60 * 1000);
}

function getLocalDateStr(date = new Date()) {
  const d = toLocalShiftedDate(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalTimeStr(date = new Date()) {
  const d = toLocalShiftedDate(date);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

function parseEventStartDate(fechaStr, horaStr) {
  const [year, month, day] = String(fechaStr || '').split('-').map(Number);
  const [hour, minute] = String(horaStr || '').split(':').map(Number);
  const y = String(year || 2026).padStart(4, '0');
  const m = String(month || 1).padStart(2, '0');
  const d = String(day || 1).padStart(2, '0');
  const hh = String(hour || 0).padStart(2, '0');
  const mm = String(minute || 0).padStart(2, '0');
  const parsed = new Date(`${y}-${m}-${d}T${hh}:${mm}:00${APP_TZ_OFFSET}`);
  if (!isNaN(parsed.getTime())) return parsed;
  return new Date(year || 2026, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);
}


// Categorías base del sistema en la pestaña "Configuración"
const BASE_CATALOG_CAMPOS = [
  { codigo: 'UNIDAD', nombre: 'Unidad', icono: '🏢', es_sistema: 1, orden: 1 },
  { codigo: 'CARGO', nombre: 'Cargo', icono: '👔', es_sistema: 1, orden: 2 },
  { codigo: 'TIPO', nombre: 'Tipo (Modalidad)', icono: '💻', es_sistema: 1, orden: 3 },
  { codigo: 'SEXO', nombre: 'Sexo', icono: '👤', es_sistema: 1, orden: 4 },
  { codigo: 'PROCESO_ISO', nombre: 'Proceso ISO', icono: '📋', es_sistema: 1, orden: 5 },
  { codigo: 'PLANIFICACION', nombre: 'Planificación', icono: '🗓️', es_sistema: 1, orden: 6 },
];

function seedInitialData() {
  const now = getNowISO();

  // Semilla de Campos / Categorías del Catálogo
  const insertCampo = db.prepare(`
    INSERT OR IGNORE INTO campos_catalogo (codigo, nombre, icono, descripcion, es_sistema, orden, creado_en)
    VALUES (?, ?, ?, '', ?, ?, ?)
  `);
  for (const c of BASE_CATALOG_CAMPOS) {
    insertCampo.run(c.codigo, c.nombre, c.icono, c.es_sistema, c.orden, now);
  }

  const defaultConfigs = {
    titulo_header: 'ASISTENCIA DE PARTICIPACIÓN',
    subtitulo_header: 'Registro Oficial de Participación y Firmas',
    logo_izquierdo: '/image/uamh.png',
    logo_derecho: '/image/Jaguar34.png',
    mensaje_gracias_titulo: '¡Gracias por llenar esta asistencia!',
    mensaje_gracias_cuerpo:
      'Su participación y firma digital han sido registradas correctamente en la base de datos institucional.',
    minutos_expiracion: '30',
    base_url: '',
  };

  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO config (clave, valor, actualizado_en)
    VALUES (?, ?, ?)
  `);
  for (const [k, v] of Object.entries(defaultConfigs)) {
    insertConfig.run(k, v, now);
  }

  // Semilla de los 6 Catálogos Desplegables en "Configuración"
  const initialCatalogs = {
    UNIDAD: [
      ['Dirección Producción AudioVisual', 'DPA'],
      ['Dirección Relaciones Públicas', 'DRRPP'],
      ['Dirección Admisión y Mercadeo', 'DAME'],
      ['Dirección Registro Académico', 'DRAC'],
      ['Dirección Innovación y Emprendimiento', 'DIEM'],
      ['Dirección Planificación y Gestión de Calidad', 'DPGC'],
      ['Dirección Administrativa', 'DADM'],
      ['Dirección Financiera', 'DFIN'],
      ['Dirección Gestión del Talento y Recursos Humanos', 'DGTRH'],
      ['Dirección Investigación y Extensión', 'DIEX'],
      ['Dirección Gestión Ambiental y Energética', 'DIGAE'],
      ['Rectoría', 'RECT'],
      ['Gerencia General', 'GCIA'],
      ['Dirección Internacional e Internacionalización', 'DRII'],
      ['Dirección Vida Estudiantil', 'DVES'],
      ['Dirección Académica', 'DACA'],
      ['Dirección Posgrados y Educación Continua', 'DPEC'],
      ['Secretaría General', 'SGEN'],
      ['Dirección de Deportes', 'DEPOR'],
      ['Dirección de Inteligencia Artificial', 'DIAR'],
      ['Facultad Ciencias Administrativas y Económicas', 'FCAE'],
      ['Facultad Ciencias Médicas', 'FCMED'],
      ['Facultad Odontología', 'FODO'],
      ['Facultad Ciencias Jurídicas, Humanidades y Relaciones Internacionales', 'FCJHRI'],
      ['Facultad Marketing, Diseño y Ciencias de la Comunicación', 'FMDCC'],
      ['Facultad UAM College', 'UAMC'],
      ['Language Center', 'LNCT'],
      ['Facultad Ingeniería y Arquitectura', 'FIA'],
      ['Coordinación Atención al Cliente', 'CATC'],
      ['Biblioteca', 'BIBL'],
      ['Coordinación de Riesgos', 'CRI'],
    ],
    CARGO: [
      ['Presidente', 'PRE'],
      ['VicePresidente', 'VPRE'],
      ['Rector', 'RECT'],
      ['Gerente', 'GCIA'],
      ['Secretaria General', 'SGEN'],
      ['Director', 'DIR'],
      ['Decano', 'DECA'],
      ['Coordinador Académico/Administrativo', 'COOR'],
      ['Especialista/Responsable', 'ESP/RESP'],
      ['Analista', 'ANA'],
      ['Oficial/Secretario Académico', 'OSA'],
      ['Asistente Administrativo', 'AA'],
      ['Consultor Interno', 'CINT'],
      ['Consultor Externo', 'CEXT'],
      ['Invitado', 'INVT'],
    ],
    TIPO: [
      ['Presencial', 'PRES'],
      ['Virtual', 'VIRT'],
      ['Ambos', 'AMB'],
    ],
    SEXO: [
      ['Mujer', 'M'],
      ['Varón', 'V'],
    ],
    PROCESO_ISO: [
      ['No Aplica', 'NA'],
      ['Proceso Gestión Estratégica', 'GEIN'],
      ['Proceso Gestión de la Legalidad Institucional, Admisión y Registro Académico', 'GLAR'],
      ['Proceso Gestión de la Calidad', 'GCAL'],
      ['Proceso Gestión del Talento Humano', 'GTHU'],
      ['Proceso Gestión de la Internacionalización', 'GINT'],
      ['Proceso Gestión de Docencia', 'GDOC'],
      ['Proceso Gestión de Extensión y Proyección Social', 'GEPS'],
      ['Proceso Gestión de la Investigación y Generación del Conocimiento', 'GIGC'],
      ['Proceso Gestión de la Innovación y Emprendimiento', 'GIEM'],
      ['Proceso Gestión Financiera', 'GFIN'],
      ['Proceso Gestión Administrativa', 'GADM'],
      ['Proceso Gestión de Servicios Estudiantiles', 'GSES'],
      ['Proceso Gestión de Tecnología de la Información y Comunicación', 'GTIC'],
      ['Proceso Gestión de la Comunicación Institucional', 'GCIN'],
    ],
    PLANIFICACION: [
      ['No Aplica', 'NA'],
      ['Planificada (POA / Calendario Anual)', 'POA'],
      ['Seguimiento de Auditoría / Mejora Continua', 'AUD'],
      ['Sesión de Comité / Consejo Institucional', 'COM'],
      ['Capacitación / Formación Continua', 'CAP'],
      ['Extraordinaria / Emergente', 'EXT'],
    ],
  };

  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO catalogos (categoria, nombre, codigo, activo, orden, creado_en)
    VALUES (?, ?, ?, 1, ?, ?)
  `);

  for (const [categoria, items] of Object.entries(initialCatalogs)) {
    const existingCount = db
      .prepare('SELECT COUNT(*) as c FROM catalogos WHERE categoria = ?')
      .get(categoria).c;
    if (existingCount === 0) {
      items.forEach(([nombre, codigo], idx) => {
        insertCat.run(categoria, nombre, codigo, idx + 1, now);
      });
    }
  }

  // Sincronización oficial obligatoria de UNIDAD y PROCESO_ISO requeridos por el usuario (ejecuta una sola vez por BD)
  try {
    const alreadySynced = db
      .prepare("SELECT valor FROM config WHERE clave = 'catalogo_oficial_uam_2026_v2'")
      .get();
    if (!alreadySynced || alreadySynced.valor !== '1') {
      const syncItem = db.prepare(`
        INSERT INTO catalogos (categoria, nombre, codigo, activo, orden, creado_en)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(categoria, nombre) DO UPDATE SET codigo = excluded.codigo, activo = 1, orden = excluded.orden
      `);

      initialCatalogs.UNIDAD.forEach(([nombre, codigo], idx) => {
        syncItem.run('UNIDAD', nombre, codigo, idx + 1, now);
      });

      initialCatalogs.PROCESO_ISO.forEach(([nombre, codigo], idx) => {
        syncItem.run('PROCESO_ISO', nombre, codigo, idx, now);
      });

      // Eliminar opciones obsoletas de UNIDAD que no formen parte de la lista oficial requerida
      const validUnidades = initialCatalogs.UNIDAD.map((u) => u[0]);
      const placeholdersU = validUnidades.map(() => '?').join(',');
      db.prepare(`DELETE FROM catalogos WHERE categoria = 'UNIDAD' AND nombre NOT IN (${placeholdersU})`).run(...validUnidades);

      // Eliminar opciones obsoletas de PROCESO_ISO que no formen parte de la lista oficial requerida
      const validProcesos = initialCatalogs.PROCESO_ISO.map((p) => p[0]);
      const placeholdersP = validProcesos.map(() => '?').join(',');
      db.prepare(`DELETE FROM catalogos WHERE categoria = 'PROCESO_ISO' AND nombre NOT IN (${placeholdersP})`).run(...validProcesos);

      db.prepare(`
        INSERT INTO config (clave, valor, actualizado_en)
        VALUES ('catalogo_oficial_uam_2026_v2', '1', ?)
        ON CONFLICT(clave) DO UPDATE SET valor = '1', actualizado_en = excluded.actualizado_en
      `).run(now);
    }
  } catch (err) {
    console.error('Error sincronizando listas requeridas de Unidad y Proceso ISO:', err);
  }

  // Sincronización oficial de CARGO (ejecuta una sola vez por BD)
  try {
    const alreadySyncedCargo = db
      .prepare("SELECT valor FROM config WHERE clave = 'catalogo_oficial_cargo_2026_v1'")
      .get();
    if (!alreadySyncedCargo || alreadySyncedCargo.valor !== '1') {
      const syncCargoItem = db.prepare(`
        INSERT INTO catalogos (categoria, nombre, codigo, activo, orden, creado_en)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(categoria, nombre) DO UPDATE SET codigo = excluded.codigo, activo = 1, orden = excluded.orden
      `);

      initialCatalogs.CARGO.forEach(([nombre, codigo], idx) => {
        syncCargoItem.run('CARGO', nombre, codigo, idx + 1, now);
      });

      const validCargos = initialCatalogs.CARGO.map((c) => c[0]);
      const placeholdersC = validCargos.map(() => '?').join(',');
      db.prepare(`DELETE FROM catalogos WHERE categoria = 'CARGO' AND nombre NOT IN (${placeholdersC})`).run(...validCargos);

      db.prepare(`
        INSERT INTO config (clave, valor, actualizado_en)
        VALUES ('catalogo_oficial_cargo_2026_v1', '1', ?)
        ON CONFLICT(clave) DO UPDATE SET valor = '1', actualizado_en = excluded.actualizado_en
      `).run(now);
    }
  } catch (err) {
    console.error('Error sincronizando lista oficial de Cargo:', err);
  }

  // Garantizar que logo izquierdo base sea uamh.png, logo derecho sea Jaguar34.png y actualizar SEXO (Mujer / Varón)
  try {
    db.prepare(`
      UPDATE config SET valor = '/image/uamh.png'
      WHERE clave = 'logo_izquierdo'
        AND (valor LIKE '%logo-left%' OR valor = '' OR valor LIKE '%default%' OR valor LIKE '%uverde%')
    `).run();
    db.prepare(`
      UPDATE config SET valor = '/image/Jaguar34.png'
      WHERE clave = 'logo_derecho'
        AND (valor = '' OR valor LIKE '%uverde%' OR valor = '/image/uamh.png' OR valor LIKE '%logo-right%' OR valor LIKE '%default%')
    `).run();
    db.prepare(`
      UPDATE eventos SET logo_derecho_custom = ''
      WHERE logo_derecho_custom LIKE '%uverde%'
    `).run();
    db.prepare(`
      UPDATE eventos SET logo_izquierdo_custom = ''
      WHERE logo_izquierdo_custom LIKE '%uverde%'
    `).run();

    // Migrar opciones de SEXO: Femenino -> Mujer, Masculino -> Varón
    const hasMujer = db
      .prepare("SELECT id FROM catalogos WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) = 'mujer'")
      .get();
    if (hasMujer) {
      db.prepare("DELETE FROM catalogos WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) = 'femenino'").run();
    } else {
      db.prepare(
        "UPDATE catalogos SET nombre = 'Mujer', codigo = 'M' WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) = 'femenino'"
      ).run();
    }

    const hasVaron = db
      .prepare("SELECT id FROM catalogos WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) IN ('varón', 'varon')")
      .get();
    if (hasVaron) {
      db.prepare("DELETE FROM catalogos WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) = 'masculino'").run();
    } else {
      db.prepare(
        "UPDATE catalogos SET nombre = 'Varón', codigo = 'V' WHERE categoria = 'SEXO' AND LOWER(TRIM(nombre)) = 'masculino'"
      ).run();
    }

    db.prepare(
      "UPDATE asistencias SET sexo = 'Mujer' WHERE LOWER(TRIM(sexo)) IN ('femenino', 'f')"
    ).run();
    db.prepare(
      "UPDATE asistencias SET sexo = 'Varón' WHERE LOWER(TRIM(sexo)) IN ('masculino', 'm', 'varon')"
    ).run();
  } catch (err) {
    console.error('Error aplicando updates de inicialización:', err);
  }

  // Purgar de forma permanente únicamente los 3 eventos demo antiguos si existieran
  try {
    const demoTokens = ['calidad-iso-2026', 'coordinacion-academica', 'indash-seguridad-ti'];
    const placeholders = demoTokens.map(() => '?').join(',');
    const demoEvs = db.prepare(`SELECT id FROM eventos WHERE token IN (${placeholders})`).all(...demoTokens);
    if (demoEvs.length > 0) {
      const demoIds = demoEvs.map((e) => e.id);
      const evPlaceholders = demoIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM asistencias WHERE evento_id IN (${evPlaceholders})`).run(...demoIds);
      db.prepare(`DELETE FROM eventos WHERE id IN (${evPlaceholders})`).run(...demoIds);
    }
  } catch (err) {
    console.error('Error limpiando datos de prueba:', err);
  }
}

seedInitialData();

function parseUnidadesInvitadas(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [String(raw)];
  } catch {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

function computeEventStatus(evento) {
  if (!evento) return null;

  const startDate = parseEventStartDate(evento.fecha, evento.hora);
  const createdMs = evento.creado_en ? new Date(evento.creado_en).getTime() : 0;
  const effectiveStartMs =
    !isNaN(createdMs) && createdMs > startDate.getTime() ? createdMs : startDate.getTime();

  const rawVentana =
    evento.duracion_ventana_min !== undefined && evento.duracion_ventana_min !== null
      ? Number(evento.duracion_ventana_min)
      : 30;
  const ventanaMin = isNaN(rawVentana) ? 30 : rawVentana;
  const sinLimiteTiempo = evento.estado_manual === 'FORZAR_ABIERTA' || ventanaMin <= 0;

  const expirationDate = new Date(
    effectiveStartMs + Math.max(ventanaMin, 30) * 60 * 1000
  );
  const now = new Date();

  const horaCierreStr = sinLimiteTiempo ? 'Sin límite' : getLocalTimeStr(expirationDate);
  const fechaCierreStr = sinLimiteTiempo ? 'Permanente' : getLocalDateStr(expirationDate);

  let activa = true;
  let codigoEstado = 'EN_CURSO';
  let etiquetaEstado = 'Activa';
  let mensajeEstado = `Lista habilitada. Se desactivará automáticamente a las ${horaCierreStr}.`;

  if (evento.estado_manual === 'FORZAR_CERRADA') {
    activa = false;
    codigoEstado = 'CERRADA_MANUAL';
    etiquetaEstado = 'Desactivada (Manual)';
    mensajeEstado = 'Este formulario de asistencia fue desactivado manualmente por el administrador.';
  } else if (sinLimiteTiempo) {
    activa = true;
    codigoEstado = 'ABIERTA_MANUAL';
    etiquetaEstado = 'Activa (Sin límite)';
    mensajeEstado = 'Formulario de asistencia habilitado permanentemente por el administrador.';
  } else {
    if (now.getTime() > expirationDate.getTime()) {
      activa = false;
      codigoEstado = 'EXPIRADA';
      etiquetaEstado = 'Desactivada (+30 min)';
      mensajeEstado = `Esta lista de asistencia se desactivó automáticamente a las ${formatHoraAmPm(horaCierreStr)} del ${fechaCierreStr}.`;
    } else if (now.getTime() >= startDate.getTime()) {
      activa = true;
      codigoEstado = 'EN_CURSO';
      etiquetaEstado = 'En Curso (Activa)';
      mensajeEstado = `Reunión en curso. El formulario permanecerá activo hasta las ${horaCierreStr}.`;
    } else {
      activa = true;
      codigoEstado = 'PROGRAMADA';
      etiquetaEstado = 'Programada (Activa)';
      mensajeEstado = `Reunión programada para ${evento.fecha} a las ${evento.hora}. Se desactivará automáticamente a las ${horaCierreStr}.`;
    }
  }

  const segundosParaExpirar = sinLimiteTiempo
    ? 999999
    : Math.max(0, Math.floor((expirationDate.getTime() - now.getTime()) / 1000));
  const segundosParaIniciar = Math.max(0, Math.floor((startDate.getTime() - now.getTime()) / 1000));

  return {
    ...evento,
    unidades_invitadas_lista: parseUnidadesInvitadas(evento.unidades_invitadas),
    inicio_iso: startDate.toISOString(),
    expiracion_iso: expirationDate.toISOString(),
    hora_cierre: horaCierreStr,
    fecha_cierre: fechaCierreStr,
    sin_limite_tiempo: sinLimiteTiempo,
    activa,
    codigo_estado: codigoEstado,
    etiqueta_estado: etiquetaEstado,
    mensaje_estado: mensajeEstado,
    segundos_para_expirar: segundosParaExpirar,
    segundos_para_iniciar: segundosParaIniciar,
  };
}

function getAllConfigs() {
  const rows = db.prepare('SELECT clave, valor FROM config').all();
  const map = {};
  for (const r of rows) {
    map[r.clave] = r.valor;
  }
  return map;
}

function updateConfigs(updates) {
  const now = getNowISO();
  const stmt = db.prepare(`
    INSERT INTO config (clave, valor, actualizado_en)
    VALUES (?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
  `);
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) {
      stmt.run(k, String(v), now);
    }
  }
  return getAllConfigs();
}

function getCamposCatalogo() {
  return db
    .prepare('SELECT * FROM campos_catalogo ORDER BY es_sistema DESC, orden ASC, nombre ASC')
    .all();
}

function addCampoCatalogo({ nombre, icono = '📋', descripcion = '' }) {
  const norm = String(nombre || '').trim();
  if (!norm) throw new Error('El nombre del campo es obligatorio.');

  const codigo = norm
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);

  if (!codigo) throw new Error('Nombre de campo inválido.');

  const existing = db.prepare('SELECT * FROM campos_catalogo WHERE codigo = ?').get(codigo);
  if (existing) {
    throw new Error(`El campo o lista "${existing.nombre}" ya existe en Configuración.`);
  }

  const maxRow = db.prepare('SELECT MAX(orden) as m FROM campos_catalogo').get();
  const nextOrden = (maxRow && maxRow.m ? maxRow.m : 0) + 1;

  db.prepare(`
    INSERT INTO campos_catalogo (codigo, nombre, icono, descripcion, es_sistema, orden, creado_en)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(codigo, norm, icono || '📋', descripcion || '', nextOrden, getNowISO());

  return db.prepare('SELECT * FROM campos_catalogo WHERE codigo = ?').get(codigo);
}

function deleteCampoCatalogo(codigo) {
  const campo = db.prepare('SELECT * FROM campos_catalogo WHERE codigo = ?').get(codigo);
  if (!campo) throw new Error('Campo no encontrado.');
  if (campo.es_sistema === 1) {
    throw new Error('Los campos base del sistema no pueden ser eliminados.');
  }

  db.prepare('DELETE FROM catalogos WHERE categoria = ?').run(codigo);
  db.prepare('DELETE FROM campos_catalogo WHERE codigo = ?').run(codigo);
  return { ok: true };
}

function getCatalogos({ soloActivos = false, categoria = '' } = {}) {
  const campos = getCamposCatalogo();
  let clauses = [];
  let params = [];
  if (soloActivos) {
    clauses.push('activo = 1');
  }
  if (categoria) {
    clauses.push('categoria = ?');
    params.push(categoria.toUpperCase());
  }
  const whereSQL = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM catalogos ${whereSQL} ORDER BY categoria ASC, orden ASC, nombre ASC`)
    .all(...params);

  const grouped = {};
  for (const c of campos) {
    grouped[c.codigo] = [];
  }
  for (const r of rows) {
    if (!grouped[r.categoria]) grouped[r.categoria] = [];
    grouped[r.categoria].push(r);
  }
  return { items: rows, grouped, campos };
}

function syncClientDataToDb(payload = {}) {
  if (!payload || typeof payload !== 'object') return;
  const now = getNowISO();

  const purgedEventIds = Array.isArray(payload.purgedEventIds)
    ? payload.purgedEventIds.map(String).filter(Boolean)
    : [];
  const purgedAsistenciaIds = Array.isArray(payload.purgedAsistenciaIds)
    ? payload.purgedAsistenciaIds.map(Number).filter((n) => !isNaN(n) && n > 0)
    : [];

  db.exec('BEGIN IMMEDIATE');
  try {
    if (purgedEventIds.length > 0) {
      const ph = purgedEventIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM asistencias WHERE evento_id IN (${ph})`).run(...purgedEventIds);
      db.prepare(`DELETE FROM eventos WHERE id IN (${ph})`).run(...purgedEventIds);
    }

    if (purgedAsistenciaIds.length > 0) {
      const ph = purgedAsistenciaIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM asistencias WHERE id IN (${ph})`).run(...purgedAsistenciaIds);
    }

    const purgedEvSet = new Set(purgedEventIds);
    const purgedAsisSet = new Set(purgedAsistenciaIds);

    if (Array.isArray(payload.eventos)) {
      const getEvStmt = db.prepare('SELECT * FROM eventos WHERE id = ? OR token = ?');
      const insertEvStmt = db.prepare(`
        INSERT INTO eventos (
          id, token, tema, fecha, hora, direccion_organiza, unidades_invitadas,
          lugar, tipo, proceso_iso, planificacion, organizador, descripcion,
          duracion_ventana_min, estado_manual, logo_izquierdo_custom, logo_derecho_custom,
          creado_en, eliminado, eliminado_en, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateEvStmt = db.prepare(`
        UPDATE eventos
        SET tema = ?, fecha = ?, hora = ?, direccion_organiza = ?, unidades_invitadas = ?,
            lugar = ?, tipo = ?, proceso_iso = ?, planificacion = ?,
            duracion_ventana_min = ?, estado_manual = ?,
            eliminado = ?, eliminado_en = ?, actualizado_en = ?
        WHERE id = ?
      `);

      for (const ev of payload.eventos) {
        if (!ev || !ev.id || !ev.token || !ev.tema || !ev.fecha || !ev.hora) continue;
        if (purgedEvSet.has(String(ev.id))) continue;

        const unidadesStr = Array.isArray(ev.unidades_invitadas_lista)
          ? JSON.stringify(ev.unidades_invitadas_lista)
          : typeof ev.unidades_invitadas === 'string' && ev.unidades_invitadas.startsWith('[')
          ? ev.unidades_invitadas
          : JSON.stringify(parseUnidadesInvitadas(ev.unidades_invitadas));

        const existing = getEvStmt.get(String(ev.id), String(ev.token));
        const evUpdated = String(ev.actualizado_en || ev.eliminado_en || ev.creado_en || '');

        if (!existing) {
          insertEvStmt.run(
            String(ev.id),
            String(ev.token),
            String(ev.tema),
            String(ev.fecha),
            String(ev.hora),
            String(ev.direccion_organiza || ''),
            unidadesStr,
            String(ev.lugar || ''),
            String(ev.tipo || 'Presencial'),
            String(ev.proceso_iso || 'No Aplica'),
            String(ev.planificacion || 'No Aplica'),
            String(ev.organizador || ev.direccion_organiza || ''),
            String(ev.descripcion || ''),
            ev.duracion_ventana_min !== undefined && ev.duracion_ventana_min !== null
              ? Number(ev.duracion_ventana_min)
              : 30,
            String(ev.estado_manual || 'AUTO'),
            String(ev.logo_izquierdo_custom || ''),
            String(ev.logo_derecho_custom || ''),
            String(ev.creado_en || now),
            ev.eliminado ? 1 : 0,
            ev.eliminado_en || null,
            evUpdated || now
          );
        } else {
          const dbUpdated = String(existing.actualizado_en || existing.eliminado_en || existing.creado_en || '');
          if (evUpdated > dbUpdated) {
            updateEvStmt.run(
              String(ev.tema),
              String(ev.fecha),
              String(ev.hora),
              String(ev.direccion_organiza || ''),
              unidadesStr,
              String(ev.lugar || ''),
              String(ev.tipo || 'Presencial'),
              String(ev.proceso_iso || 'No Aplica'),
              String(ev.planificacion || 'No Aplica'),
              ev.duracion_ventana_min !== undefined && ev.duracion_ventana_min !== null
                ? Number(ev.duracion_ventana_min)
                : 30,
              String(ev.estado_manual || 'AUTO'),
              ev.eliminado ? 1 : 0,
              ev.eliminado_en || null,
              evUpdated,
              existing.id
            );
          }
        }
      }
    }

    if (Array.isArray(payload.asistencias)) {
      const checkParentStmt = db.prepare('SELECT id FROM eventos WHERE id = ?');
      const getAsisStmt = db.prepare(
        'SELECT * FROM asistencias WHERE (id = ? AND registrado_en = ?) OR (evento_id = ? AND nombre = ? AND registrado_en = ?)'
      );
      const insertAsisWithId = db.prepare(`
        INSERT OR IGNORE INTO asistencias (
          id, evento_id, unidad, cargo, sexo, tema, nombre, fecha, hora,
          firma_base64, ip_dispositivo, user_agent, registrado_en,
          eliminado, eliminado_en, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAsisAuto = db.prepare(`
        INSERT INTO asistencias (
          evento_id, unidad, cargo, sexo, tema, nombre, fecha, hora,
          firma_base64, ip_dispositivo, user_agent, registrado_en,
          eliminado, eliminado_en, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateAsisStmt = db.prepare(`
        UPDATE asistencias
        SET eliminado = ?, eliminado_en = ?, actualizado_en = ?
        WHERE id = ?
      `);

      for (const a of payload.asistencias) {
        if (!a || !a.evento_id || !a.nombre || !a.unidad || !a.firma_base64) continue;
        if (purgedEvSet.has(String(a.evento_id))) continue;
        if (a.id && purgedAsisSet.has(Number(a.id))) continue;
        if (!checkParentStmt.get(String(a.evento_id))) continue;

        const regEn = String(a.registrado_en || now);
        const existing = getAsisStmt.get(
          Number(a.id || 0),
          regEn,
          String(a.evento_id),
          String(a.nombre),
          regEn
        );
        const aUpdated = String(a.actualizado_en || a.eliminado_en || regEn);

        if (!existing) {
          const idConflict = a.id
            ? db.prepare('SELECT 1 FROM asistencias WHERE id = ?').get(Number(a.id))
            : null;
          if (a.id && !idConflict) {
            insertAsisWithId.run(
              Number(a.id),
              String(a.evento_id),
              String(a.unidad),
              String(a.cargo || ''),
              normalizeSexo(a.sexo || ''),
              String(a.tema || ''),
              String(a.nombre),
              String(a.fecha || ''),
              String(a.hora || ''),
              String(a.firma_base64),
              String(a.ip_dispositivo || ''),
              String(a.user_agent || ''),
              regEn,
              a.eliminado ? 1 : 0,
              a.eliminado_en || null,
              aUpdated
            );
          } else {
            insertAsisAuto.run(
              String(a.evento_id),
              String(a.unidad),
              String(a.cargo || ''),
              normalizeSexo(a.sexo || ''),
              String(a.tema || ''),
              String(a.nombre),
              String(a.fecha || ''),
              String(a.hora || ''),
              String(a.firma_base64),
              String(a.ip_dispositivo || ''),
              String(a.user_agent || ''),
              regEn,
              a.eliminado ? 1 : 0,
              a.eliminado_en || null,
              aUpdated
            );
          }
        } else {
          const dbUpdated = String(existing.actualizado_en || existing.eliminado_en || existing.registrado_en || '');
          if (aUpdated > dbUpdated) {
            updateAsisStmt.run(
              a.eliminado ? 1 : 0,
              a.eliminado_en || null,
              aUpdated,
              existing.id
            );
          }
        }
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    console.error('Error en syncClientDataToDb:', err);
  }
}

function normalizeSexo(val) {
  const s = String(val || '').trim();
  const low = s.toLowerCase();
  if (low === 'femenino' || low === 'f' || low === 'mujer') return 'Mujer';
  if (low === 'masculino' || low === 'm' || low === 'varon' || low === 'varón' || low === 'v') return 'Varón';
  return s;
}

function formatHoraAmPm(horaStr) {
  const raw = String(horaStr || '').trim();
  if (!raw || raw === 'Sin límite' || raw === '--' || raw === '--:--') return raw;
  if (/a\.?\s*m\.?|p\.?\s*m\.?/i.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return raw;
  let hh = parseInt(m[1], 10);
  const mm = m[2];
  if (isNaN(hh)) return raw;
  const suffix = hh >= 12 ? 'p.m.' : 'a.m.';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${String(hh).padStart(2, '0')}:${mm} ${suffix}`;
}

function syncLogosFolder() {
  if (process.env.VERCEL) return;
  try {
    const srcImg = path.join(__dirname, '..', 'image');
    const dstImg = path.join(__dirname, '..', 'public', 'image');
    if (fs.existsSync(srcImg)) {
      if (!fs.existsSync(dstImg)) {
        fs.mkdirSync(dstImg, { recursive: true });
      }
      for (const file of fs.readdirSync(srcImg)) {
        const srcFile = path.join(srcImg, file);
        const dstFile = path.join(dstImg, file);
        try {
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, dstFile);
          }
        } catch (_) {}
      }
    }
    const srcLogos = path.join(__dirname, '..', 'image', 'Logos');
    const dstLogos = path.join(__dirname, '..', 'public', 'image', 'Logos');
    if (fs.existsSync(srcLogos)) {
      if (!fs.existsSync(dstLogos)) {
        fs.mkdirSync(dstLogos, { recursive: true });
      }
      for (const file of fs.readdirSync(srcLogos)) {
        const srcFile = path.join(srcLogos, file);
        const dstFile = path.join(dstLogos, file);
        try {
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, dstFile);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

syncLogosFolder();

function resolveLogoForDireccion(direccionOrganiza) {
  const dirStr = String(direccionOrganiza || '').trim();
  if (!dirStr) return '';

  const candidates = [];

  try {
    const row = db
      .prepare(
        "SELECT codigo, nombre FROM catalogos WHERE categoria = 'UNIDAD' AND (LOWER(TRIM(nombre)) = LOWER(?) OR LOWER(TRIM(codigo)) = LOWER(?))"
      )
      .get(dirStr, dirStr);
    if (row && row.codigo) {
      candidates.push(String(row.codigo).trim());
    }
  } catch (_) {}

  const parenMatch = dirStr.match(/\(([A-Za-z0-9_-]+)\)\s*$/);
  if (parenMatch && parenMatch[1]) {
    candidates.push(parenMatch[1].trim());
  }

  candidates.push(dirStr);

  const logoDirs = [
    path.join(__dirname, '..', 'public', 'image', 'Logos'),
    path.join(__dirname, '..', 'image', 'Logos'),
  ];

  for (const cand of candidates) {
    const targetUpper = String(cand || '').trim().toUpperCase();
    if (!targetUpper) continue;
    for (const dirPath of logoDirs) {
      try {
        if (!fs.existsSync(dirPath)) continue;
        const files = fs.readdirSync(dirPath);
        const matched = files.find((f) => path.parse(f).name.toUpperCase() === targetUpper);
        if (matched) {
          return `/image/Logos/${encodeURIComponent(matched)}`;
        }
      } catch (_) {}
    }
  }

  return '';
}

module.exports = {
  db,
  DB_PATH,
  BASE_CATALOG_CAMPOS,
  computeEventStatus,
  parseEventStartDate,
  parseUnidadesInvitadas,
  getAllConfigs,
  updateConfigs,
  getCamposCatalogo,
  addCampoCatalogo,
  deleteCampoCatalogo,
  getCatalogos,
  syncClientDataToDb,
  resolveLogoForDireccion,
  normalizeSexo,
  formatHoraAmPm,
  getNowISO,
  getLocalDateStr,
  getLocalTimeStr,
};
