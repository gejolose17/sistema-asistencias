const zlib = require('node:zlib');

// CRC32 Table
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function createZip(files) {
  const localHeaders = [];
  const centralDirs = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedData = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(uncompressedData);
    const compressedData = zlib.deflateRawSync(uncompressedData);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(uncompressedData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localChunk = Buffer.concat([localHeader, nameBuf, compressedData]);
    localHeaders.push(localChunk);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4);
    cdHeader.writeUInt16LE(20, 6);
    cdHeader.writeUInt16LE(0, 8);
    cdHeader.writeUInt16LE(8, 10);
    cdHeader.writeUInt16LE(0, 12);
    cdHeader.writeUInt16LE(0, 14);
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressedData.length, 20);
    cdHeader.writeUInt32LE(uncompressedData.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);
    cdHeader.writeUInt16LE(0, 32);
    cdHeader.writeUInt16LE(0, 34);
    cdHeader.writeUInt16LE(0, 36);
    cdHeader.writeUInt32LE(0, 38);
    cdHeader.writeUInt32LE(offset, 42);

    centralDirs.push(Buffer.concat([cdHeader, nameBuf]));
    offset += localChunk.length;
  }

  const centralDirBuf = Buffer.concat(centralDirs);
  const centralDirOffset = offset;
  const centralDirSize = centralDirBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDirBuf, eocd]);
}

function colLetter(colIdx) {
  let temp = colIdx + 1;
  let letter = '';
  while (temp > 0) {
    let mod = (temp - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    temp = Math.floor((temp - mod) / 26);
  }
  return letter;
}

function escapeXML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function sanitizeSheetName(name) {
  return String(name || 'Hoja1')
    .replace(/[\\/*?:[\]]/g, '')
    .slice(0, 31) || 'Hoja1';
}

function buildWorksheetXml(headers, rows, summaryRows = []) {
  // Calcular anchos de columna según encabezados y primeras filas
  const colWidths = headers.map((h) => Math.max(10, String(h || '').length + 4));
  for (const row of rows.slice(0, 500)) {
    row.forEach((val, idx) => {
      if (idx < colWidths.length) {
        const len = String(val ?? '').length + 3;
        if (len > colWidths[idx]) colWidths[idx] = len;
      }
    });
  }
  for (const sRow of summaryRows) {
    sRow.forEach((val, idx) => {
      if (idx < colWidths.length) {
        const len = String(val ?? '').length + 3;
        if (len > colWidths[idx]) colWidths[idx] = len;
      }
    });
  }

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n';
  xml += '<cols>\n';
  colWidths.forEach((w, idx) => {
    const clamped = Math.min(48, Math.max(11, w));
    xml += `<col min="${idx + 1}" max="${idx + 1}" width="${clamped}" customWidth="1"/>\n`;
  });
  xml += '</cols>\n';
  xml += '<sheetData>\n';

  // Encabezados
  xml += '<row r="1" ht="26" customHeight="1">\n';
  headers.forEach((h, colIdx) => {
    const cellRef = colLetter(colIdx) + '1';
    xml += `<c r="${cellRef}" t="inlineStr" s="1"><is><t>${escapeXML(h)}</t></is></c>`;
  });
  xml += '</row>\n';

  let currentRowNum = 2;

  for (const row of rows) {
    xml += `<row r="${currentRowNum}">\n`;
    row.forEach((val, colIdx) => {
      const cellRef = colLetter(colIdx) + currentRowNum;
      if (typeof val === 'number' && Number.isFinite(val)) {
        xml += `<c r="${cellRef}" s="2"><v>${val}</v></c>`;
      } else {
        xml += `<c r="${cellRef}" t="inlineStr" s="2"><is><t>${escapeXML(val)}</t></is></c>`;
      }
    });
    xml += '</row>\n';
    currentRowNum++;
  }

  if (summaryRows && summaryRows.length > 0) {
    currentRowNum++; // fila en blanco
    for (const sRow of summaryRows) {
      xml += `<row r="${currentRowNum}">\n`;
      sRow.forEach((val, colIdx) => {
        const cellRef = colLetter(colIdx) + currentRowNum;
        if (typeof val === 'number' && Number.isFinite(val)) {
          xml += `<c r="${cellRef}" s="3"><v>${val}</v></c>`;
        } else {
          xml += `<c r="${cellRef}" t="inlineStr" s="3"><is><t>${escapeXML(val)}</t></is></c>`;
        }
      });
      xml += '</row>\n';
      currentRowNum++;
    }
  }

  xml += '</sheetData>\n</worksheet>';
  return xml;
}

/**
 * Genera un libro Excel (.xlsx) con una o varias hojas.
 * @param {Array<{ name: string, headers: string[], rows: Array<Array<any>>, summaryRows?: Array<Array<any>> }>} sheets
 * @returns {Buffer}
 */
function buildMultiSheetXlsxBuffer(sheets) {
  const safeSheets = (sheets || []).map((s, idx) => ({
    ...s,
    safeName: sanitizeSheetName(s.name || `Hoja${idx + 1}`),
  }));

  const zipFiles = [];

  let contentTypesOverrides = '';
  let workbookSheetsXml = '';
  let workbookRelsXml = '';

  safeSheets.forEach((sheet, idx) => {
    const sheetNum = idx + 1;
    const sheetPath = `xl/worksheets/sheet${sheetNum}.xml`;
    const sheetXml = buildWorksheetXml(sheet.headers || [], sheet.rows || [], sheet.summaryRows || []);
    zipFiles.push({ name: sheetPath, data: sheetXml });

    contentTypesOverrides += `  <Override PartName="/${sheetPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`;
    workbookSheetsXml += `    <sheet name="${escapeXML(sheet.safeName)}" sheetId="${sheetNum}" r:id="rId${sheetNum}"/>\n`;
    workbookRelsXml += `  <Relationship Id="rId${sheetNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNum}.xml"/>\n`;
  });

  const stylesRelId = `rId${safeSheets.length + 1}`;
  workbookRelsXml += `  <Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${contentTypesOverrides}  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${workbookSheetsXml}  </sheets>
</workbook>`;

  const fullWorkbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${workbookRelsXml}</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><name val="Arial"/><sz val="10"/></font>
    <font><b/><name val="Arial"/><sz val="10"/><color rgb="FFFFFFFF"/></font>
    <font><b/><name val="Arial"/><sz val="10"/><color rgb="FF1F2937"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0099A8"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE6F6F8"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  zipFiles.push(
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: fullWorkbookRelsXml },
    { name: 'xl/styles.xml', data: stylesXml }
  );

  return createZip(zipFiles);
}

function buildXlsxBuffer(sheetName, headers, rows, summaryRows = []) {
  return buildMultiSheetXlsxBuffer([{ name: sheetName, headers, rows, summaryRows }]);
}

module.exports = {
  buildXlsxBuffer,
  buildMultiSheetXlsxBuffer,
};
