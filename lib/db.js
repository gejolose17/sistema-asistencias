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

ensureColumn('asistencias', 'cargo', "TEXT DEFAULT ''");
ensureColumn('asistencias', 'sexo', "TEXT DEFAULT ''");
ensureColumn('asistencias', 'eliminado', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('asistencias', 'eliminado_en', 'TEXT DEFAULT NULL');

function getNowISO() {
  return new Date().toISOString();
}

function getLocalDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalTimeStr(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
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
    subtitulo_header: 'Registro Oficial de Asistencia y Participación Institucional',
    logo_izquierdo: '/image/uamh.png',
    logo_derecho: '/image/uamh.png',
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
      ['Rector / Vicerrector', 'RECT'],
      ['Decano / Director de Área', 'DIR'],
      ['Coordinador Académico / Administrativo', 'COORD'],
      ['Docente / Investigador', 'DOC'],
      ['Especialista / Analista de Gestión', 'ESP'],
      ['Personal Administrativo', 'ADM'],
      ['Soporte Técnico / Operativo', 'TEC'],
      ['Estudiante / Representante Estudiantil', 'EST'],
      ['Consultor / Invitado Externo', 'INV'],
    ],
    TIPO: [
      ['Presencial', 'PRES'],
      ['Virtual', 'VIRT'],
      ['Ambos', 'AMB'],
    ],
    SEXO: [
      ['Femenino', 'F'],
      ['Masculino', 'M'],
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

  // Sincronización oficial obligatoria de UNIDAD y PROCESO_ISO requeridos por el usuario
  try {
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

    // Desactivar opciones obsoletas de UNIDAD que no formen parte de la lista oficial requerida
    const validUnidades = initialCatalogs.UNIDAD.map((u) => u[0]);
    const placeholdersU = validUnidades.map(() => '?').join(',');
    db.prepare(`UPDATE catalogos SET activo = 0 WHERE categoria = 'UNIDAD' AND nombre NOT IN (${placeholdersU})`).run(...validUnidades);

    // Desactivar opciones obsoletas de PROCESO_ISO que no formen parte de la lista oficial requerida
    const validProcesos = initialCatalogs.PROCESO_ISO.map((p) => p[0]);
    const placeholdersP = validProcesos.map(() => '?').join(',');
    db.prepare(`UPDATE catalogos SET activo = 0 WHERE categoria = 'PROCESO_ISO' AND nombre NOT IN (${placeholdersP})`).run(...validProcesos);
  } catch (err) {
    console.error('Error sincronizando listas requeridas de Unidad y Proceso ISO:', err);
  }

  // Garantizar que logo oficial sea uamh.png
  try {
    db.prepare(`
      UPDATE config SET valor = '/image/uamh.png'
      WHERE clave IN ('logo_izquierdo', 'logo_derecho')
        AND (valor LIKE '%logo-left%' OR valor LIKE '%logo-right%' OR valor = '' OR valor LIKE '%default%')
    `).run();
  } catch (err) {
    console.error('Error aplicando updates de inicialización:', err);
  }

  // Purgar de forma permanente cualquier dato de prueba previo (eventos demo y firmas de ejemplo)
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
    db.prepare(`DELETE FROM asistencias WHERE ip_dispositivo IN ('192.168.1.2', '192.168.1.18')`).run();
    db.prepare(`DELETE FROM asistencias WHERE nombre LIKE '%María Fernanda Castillo%' OR nombre LIKE '%Carlos Eduardo Mendoza%'`).run();
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

  const [year, month, day] = String(evento.fecha).split('-').map(Number);
  const [hour, minute] = String(evento.hora).split(':').map(Number);

  const startDate = new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0, 0, 0);
  const ventanaMin = Number(evento.duracion_ventana_min || 30);
  const expirationDate = new Date(startDate.getTime() + ventanaMin * 60 * 1000);
  const now = new Date();

  const horaCierreStr = getLocalTimeStr(expirationDate);
  const fechaCierreStr = getLocalDateStr(expirationDate);

  let activa = true;
  let codigoEstado = 'EN_CURSO';
  let etiquetaEstado = 'Activa';
  let mensajeEstado = `Lista habilitada. Se desactivará automáticamente a las ${horaCierreStr} (30 min después de la hora programada).`;

  if (evento.estado_manual === 'FORZAR_CERRADA') {
    activa = false;
    codigoEstado = 'CERRADA_MANUAL';
    etiquetaEstado = 'Cerrada (Manual)';
    mensajeEstado = 'Esta lista de asistencia fue desactivada manualmente por el administrador.';
  } else if (evento.estado_manual === 'FORZAR_ABIERTA') {
    activa = true;
    codigoEstado = 'ABIERTA_MANUAL';
    etiquetaEstado = 'Activa (Extendida)';
    mensajeEstado = 'Lista de asistencia habilitada manualmente por el administrador.';
  } else {
    if (now.getTime() > expirationDate.getTime()) {
      activa = false;
      codigoEstado = 'EXPIRADA';
      etiquetaEstado = 'Desactivada (+30 min)';
      mensajeEstado = `Esta lista de asistencia se desactivó automáticamente a las ${horaCierreStr} del ${fechaCierreStr} (30 minutos después de la fecha y hora programada).`;
    } else if (now.getTime() >= startDate.getTime()) {
      activa = true;
      codigoEstado = 'EN_CURSO';
      etiquetaEstado = 'En Curso (Activa)';
      mensajeEstado = `Reunión en curso. La lista se cerrará automáticamente a las ${horaCierreStr}.`;
    } else {
      activa = true;
      codigoEstado = 'PROGRAMADA';
      etiquetaEstado = 'Programada (Activa)';
      mensajeEstado = `Reunión programada para ${evento.fecha} a las ${evento.hora}. Se desactivará automáticamente a las ${horaCierreStr}.`;
    }
  }

  const segundosParaExpirar = Math.max(0, Math.floor((expirationDate.getTime() - now.getTime()) / 1000));
  const segundosParaIniciar = Math.max(0, Math.floor((startDate.getTime() - now.getTime()) / 1000));

  return {
    ...evento,
    unidades_invitadas_lista: parseUnidadesInvitadas(evento.unidades_invitadas),
    inicio_iso: startDate.toISOString(),
    expiracion_iso: expirationDate.toISOString(),
    hora_cierre: horaCierreStr,
    fecha_cierre: fechaCierreStr,
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

module.exports = {
  db,
  DB_PATH,
  BASE_CATALOG_CAMPOS,
  computeEventStatus,
  parseUnidadesInvitadas,
  getAllConfigs,
  updateConfigs,
  getCamposCatalogo,
  addCampoCatalogo,
  deleteCampoCatalogo,
  getCatalogos,
  getNowISO,
  getLocalDateStr,
  getLocalTimeStr,
};
