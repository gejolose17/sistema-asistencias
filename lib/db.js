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

ensureColumn('asistencias', 'cargo', "TEXT DEFAULT ''");
ensureColumn('asistencias', 'sexo', "TEXT DEFAULT ''");

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

function createSampleSignatureDataUrl(text, color = '#0f172a') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
    <path d="M 35 82 Q 65 25, 95 70 T 155 55 Q 190 35, 215 75 T 285 48 Q 310 40, 330 62" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 48 92 Q 140 78, 295 85" fill="none" stroke="#0099a8" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
    <text x="55" y="65" font-family="Georgia, serif" font-style="italic" font-size="22" fill="${color}" opacity="0.85">${text}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Categorías soportadas en la pestaña "Configuración"
const CATALOG_CATEGORIES = [
  'UNIDAD',
  'CARGO',
  'TIPO',
  'SEXO',
  'PROCESO_ISO',
  'PLANIFICACION',
];

function seedInitialData() {
  const now = getNowISO();

  const defaultConfigs = {
    titulo_header: 'ASISTENCIA DE PARTICIPACIÓN',
    subtitulo_header: 'Registro Oficial de Asistencia y Participación Institucional',
    logo_izquierdo: '/uploads/logo-left-default.png',
    logo_derecho: '/uploads/logo-right-default.jpeg',
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
      ['Gestión de la Calidad', 'GCAL'],
      ['Recursos Humanos', 'RRHH'],
      ['Dirección Académica', 'DACA'],
      ['Dirección Financiera', 'DFIN'],
      ['Dirección de Tecnología e Información', 'DTI'],
      ['Facultad de Ciencias Médicas', 'FCMED'],
      ['Facultad de Ingeniería y Arquitectura', 'FIA'],
      ['Facultad de Ciencias Administrativas y Económicas', 'FCAE'],
      ['Facultad de Ciencias Jurídicas, Humanidades y RRII', 'FCJH'],
      ['Facultad de Odontología', 'FODO'],
      ['Facultad de Marketing, Diseño y Ciencias de la Comunicación', 'FMDCC'],
      ['Investigación, Posgrado y Educación Continua', 'INVE'],
      ['Registro Académico', 'RACA'],
      ['Vida Estudiantil', 'VEST'],
      ['Biblioteca Institucional', 'BIBL'],
      ['Administración General y Operaciones', 'ADMG'],
      ['Invitado Externo / Otra Unidad', 'EXT'],
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
      ['P01 - Gestión Académica', 'P01'],
      ['P02 - Gestión Administrativa', 'P02'],
      ['P03 - Gestión de la Calidad (ISO 9001)', 'P03'],
      ['P04 - Gestión de Recursos Humanos', 'P04'],
      ['P05 - Gestión Financiera', 'P05'],
      ['P06 - Investigación, Desarrollo e Innovación', 'P06'],
      ['P07 - Gestión de Tecnología e Información', 'P07'],
      ['P08 - Vinculación y Extensión Universitaria', 'P08'],
    ],
    PLANIFICACION: [
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

  // Actualizar eventos existentes si no tenían los nuevos campos rellenos
  const existingEvents = db.prepare('SELECT * FROM eventos').all();
  if (existingEvents.length > 0) {
    const updateEv = db.prepare(`
      UPDATE eventos
      SET direccion_organiza = CASE WHEN direccion_organiza = '' THEN COALESCE(NULLIF(organizador, ''), 'Gestión de la Calidad') ELSE direccion_organiza END,
          unidades_invitadas = CASE WHEN unidades_invitadas = '[]' OR unidades_invitadas = '' THEN ? ELSE unidades_invitadas END,
          tipo = CASE WHEN tipo = '' THEN 'Presencial' ELSE tipo END,
          proceso_iso = CASE WHEN proceso_iso = '' THEN 'P03 - Gestión de la Calidad (ISO 9001)' ELSE proceso_iso END,
          planificacion = CASE WHEN planificacion = '' THEN 'Planificada (POA / Calendario Anual)' ELSE planificacion END
      WHERE id = ?
    `);
    const defaultInvited = JSON.stringify([
      'Gestión de la Calidad',
      'Recursos Humanos',
      'Dirección Académica',
      'Dirección de Tecnología e Información',
    ]);
    for (const ev of existingEvents) {
      updateEv.run(defaultInvited, ev.id);
    }

    // Actualizar asistencias de demostración si no tienen cargo/sexo
    db.exec(`
      UPDATE asistencias SET cargo = 'Director de Área', sexo = 'Masculino' WHERE cargo = '' AND nombre LIKE '%Gerardo%';
      UPDATE asistencias SET cargo = 'Coordinador Académico / Administrativo', sexo = 'Femenino' WHERE cargo = '' AND nombre LIKE '%María%';
      UPDATE asistencias SET cargo = 'Especialista / Analista de Gestión', sexo = 'Masculino' WHERE cargo = '';
    `);
  } else {
    // Si la BD está en blanco (ej. primera ejecución en Vercel), sembrar eventos de ejemplo
    const currentDate = new Date();
    const activeStart = new Date(currentDate.getTime() - 2 * 60 * 1000);
    const upcomingStart = new Date(currentDate.getTime() + 120 * 60 * 1000);
    const expiredStart = new Date(currentDate.getTime() - 120 * 60 * 1000);

    const insertEvento = db.prepare(`
      INSERT INTO eventos (
        id, token, tema, fecha, hora, direccion_organiza, unidades_invitadas,
        lugar, tipo, proceso_iso, planificacion, organizador, descripcion,
        duracion_ventana_min, estado_manual, creado_en
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTO', ?)
    `);

    const evt1Id = crypto.randomUUID();
    const evt2Id = crypto.randomUUID();
    const evt3Id = crypto.randomUUID();

    insertEvento.run(
      evt1Id,
      'calidad-iso-2026',
      'Sesión de Revisión del Sistema de Gestión de la Calidad ISO 9001',
      getLocalDateStr(activeStart),
      getLocalTimeStr(activeStart),
      'Gestión de la Calidad',
      JSON.stringify(['Gestión de la Calidad', 'Recursos Humanos', 'Dirección Académica']),
      'Sala de Conferencias Principal',
      'Presencial',
      'P03 - Gestión de la Calidad (ISO 9001)',
      'Planificada (POA / Calendario Anual)',
      'Gestión de la Calidad',
      'Revisión de indicadores trimestrales y actualización de listas de control.',
      30,
      now
    );

    insertEvento.run(
      evt2Id,
      'coordinacion-academica',
      'Reunión General de Coordinación Académica e Innovación Docente',
      getLocalDateStr(upcomingStart),
      getLocalTimeStr(upcomingStart),
      'Dirección Académica',
      JSON.stringify(['Dirección Académica', 'Facultad de Ciencias Médicas', 'Facultad de Ingeniería y Arquitectura']),
      'Auditorio Central / Microsoft Teams',
      'Ambos',
      'P01 - Gestión Académica',
      'Sesión de Comité / Consejo Institucional',
      'Dirección Académica',
      'Planificación de calendario docente y evaluación de competencias.',
      30,
      now
    );

    insertEvento.run(
      evt3Id,
      'indash-seguridad-ti',
      'Taller de Ciberseguridad y Protección de Datos Institucionales',
      getLocalDateStr(expiredStart),
      getLocalTimeStr(expiredStart),
      'Dirección de Tecnología e Información',
      JSON.stringify(['Dirección de Tecnología e Información', 'Administración General y Operaciones']),
      'Sala Virtual Zoom',
      'Virtual',
      'P07 - Gestión de Tecnología e Información',
      'Capacitación / Formación Continua',
      'Dirección de Tecnología e Información',
      'Capacitación obligatoria sobre protocolos de seguridad informática.',
      30,
      now
    );

    const insertAsistencia = db.prepare(`
      INSERT INTO asistencias (
        evento_id, unidad, cargo, sexo, tema, nombre, fecha, hora, firma_base64, ip_dispositivo, user_agent, registrado_en
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertAsistencia.run(
      evt1Id,
      'Gestión de la Calidad',
      'Decano / Director de Área',
      'Masculino',
      'Sesión de Revisión del Sistema de Gestión de la Calidad ISO 9001',
      'Gerardo López',
      getLocalDateStr(activeStart),
      getLocalTimeStr(activeStart),
      createSampleSignatureDataUrl('G. López'),
      '192.168.1.2',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      now
    );

    insertAsistencia.run(
      evt1Id,
      'Recursos Humanos',
      'Coordinador Académico / Administrativo',
      'Femenino',
      'Sesión de Revisión del Sistema de Gestión de la Calidad ISO 9001',
      'María Fernanda Castillo',
      getLocalDateStr(activeStart),
      getLocalTimeStr(activeStart),
      createSampleSignatureDataUrl('M. Castillo', '#1e293b'),
      '192.168.1.18',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)',
      now
    );
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

function getCatalogos( { soloActivos = false, categoria = '' } = {} ) {
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
  for (const cat of CATALOG_CATEGORIES) {
    grouped[cat] = [];
  }
  for (const r of rows) {
    if (!grouped[r.categoria]) grouped[r.categoria] = [];
    grouped[r.categoria].push(r);
  }
  return { items: rows, grouped };
}

module.exports = {
  db,
  DB_PATH,
  CATALOG_CATEGORIES,
  computeEventStatus,
  parseUnidadesInvitadas,
  getAllConfigs,
  updateConfigs,
  getCatalogos,
  getNowISO,
  getLocalDateStr,
  getLocalTimeStr,
};
