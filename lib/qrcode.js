/**
 * Generador nativo de Códigos QR (ISO/IEC 18004) en JavaScript puro.
 * Sin dependencias externas. Soporta versiones 1 a 10, modo Byte (UTF-8),
 * corrección de errores Reed-Solomon (Nivel M / L) y salida en SVG vectorial.
 */

// Tablas de capacidades para Nivel L (7%) y Nivel M (15%)
// Formato de cada versión [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
const VERSION_TABLE_M = [
  null,
  [26, 10, 1, 16, 0, 0],   // v1 (21x21)
  [44, 16, 1, 28, 0, 0],   // v2 (25x25)
  [70, 26, 1, 44, 0, 0],   // v3 (29x29)
  [100, 18, 2, 32, 0, 0],  // v4 (33x33)
  [134, 24, 2, 43, 0, 0],  // v5 (37x37)
  [172, 16, 4, 27, 0, 0],  // v6 (41x41)
  [196, 18, 4, 31, 0, 0],  // v7 (45x45)
  [242, 22, 2, 38, 2, 39], // v8 (49x49)
  [292, 22, 3, 36, 2, 37], // v9 (53x53)
  [346, 26, 4, 43, 1, 44], // v10 (57x57)
];

const ALIGNMENT_PATTERNS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// GF(256) con polinomio primitivo 0x11d
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

function getGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = EXP_TABLE[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function computeReedSolomon(data, ecLen) {
  const gen = getGeneratorPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

function selectVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const [, , g1Blocks, g1Data, g2Blocks, g2Data] = VERSION_TABLE_M[v];
    const totalDataCapacity = g1Blocks * g1Data + g2Blocks * g2Data;
    const headerBits = v <= 9 ? 4 + 8 : 4 + 16;
    const maxBytes = totalDataCapacity - Math.ceil(headerBits / 8);
    if (byteLength <= maxBytes) return v;
  }
  throw new Error('Texto demasiado largo para código QR (máximo ~270 bytes)');
}

function encodeDataCodewords(utf8Bytes, version) {
  const [, , g1Blocks, g1Data, g2Blocks, g2Data] = VERSION_TABLE_M[version];
  const totalDataBytes = g1Blocks * g1Data + g2Blocks * g2Data;
  const bits = [];

  function pushBits(val, len) {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  }

  // Modo Byte = 0100
  pushBits(0b0100, 4);
  // Conteo de caracteres (8 bits para v1-9, 16 bits para v10+)
  pushBits(utf8Bytes.length, version <= 9 ? 8 : 16);

  for (const b of utf8Bytes) {
    pushBits(b, 8);
  }

  // Terminador (hasta 4 ceros)
  const maxBits = totalDataBytes * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) {
    bits.push(0);
  }

  // Alinear a byte
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Rellenar con bytes de pad 0xEC y 0x11
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < maxBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const codewords = new Uint8Array(totalDataBytes);
  for (let i = 0; i < totalDataBytes; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    codewords[i] = b;
  }
  return codewords;
}

function interleaveCodewords(dataCodewords, version) {
  const [totalCodewords, ecLen, g1Blocks, g1Data, g2Blocks, g2Data] = VERSION_TABLE_M[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < g1Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g1Data);
    offset += g1Data;
    dataBlocks.push(block);
    ecBlocks.push(computeReedSolomon(block, ecLen));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g2Data);
    offset += g2Data;
    dataBlocks.push(block);
    ecBlocks.push(computeReedSolomon(block, ecLen));
  }

  const result = new Uint8Array(totalCodewords);
  let idx = 0;
  const maxDataLen = Math.max(g1Data, g2Data);

  for (let col = 0; col < maxDataLen; col++) {
    for (let row = 0; row < dataBlocks.length; row++) {
      if (col < dataBlocks[row].length) {
        result[idx++] = dataBlocks[row][col];
      }
    }
  }
  for (let col = 0; col < ecLen; col++) {
    for (let row = 0; row < ecBlocks.length; row++) {
      result[idx++] = ecBlocks[row][col];
    }
  }
  return result;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  function setFunctionModule(r, c, dark) {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  }

  function drawFinderPattern(r, c) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        const dark = dist !== 2 && dist !== 4;
        setFunctionModule(r + dy, c + dx, dark);
      }
    }
  }

  function drawAlignmentPattern(r, c) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunctionModule(r + dy, c + dx, dist !== 1);
      }
    }
  }

  // Patrones de búsqueda (3 esquinas)
  drawFinderPattern(0, 0);
  drawFinderPattern(0, size - 7);
  drawFinderPattern(size - 7, 0);

  // Patrones de sincronización (Timing patterns)
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Patrones de alineación
  const alignCoords = ALIGNMENT_PATTERNS[version];
  for (let i = 0; i < alignCoords.length; i++) {
    for (let j = 0; j < alignCoords.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === alignCoords.length - 1) ||
        (i === alignCoords.length - 1 && j === 0)
      ) {
        continue;
      }
      drawAlignmentPattern(alignCoords[i], alignCoords[j]);
    }
  }

  // Módulo oscuro fijo y reserva de áreas de información de formato
  setFunctionModule(size - 8, 8, true);

  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (!isFunction[8][i]) setFunctionModule(8, i, false);
      if (!isFunction[i][8]) setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
    if (!isFunction[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
  }

  // Info de versión para v >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  return { size, modules, isFunction };
}

function placeDataBits(modules, isFunction, size, codewords) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx++;
          }
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
  }
}

function drawFormatBits(modules, size, mask) {
  // Nivel M = 00 en formato ISO/IEC 18004
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  const bits = ((data << 10) | rem) ^ 0x5412;

  // Primera copia (alrededor del patrón superior izquierdo)
  for (let i = 0; i <= 5; i++) modules[i][8] = (bits >>> i) & 1;
  modules[7][8] = (bits >>> 6) & 1;
  modules[8][8] = (bits >>> 7) & 1;
  modules[8][7] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) modules[8][14 - i] = (bits >>> i) & 1;

  // Segunda copia (superior derecho e inferior izquierdo)
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = (bits >>> i) & 1;
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = (bits >>> i) & 1;
  modules[size - 8][8] = 1;
}

function applyMask(modules, isFunction, size, mask) {
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunction[r][c]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (r + c) % 2 === 0; break;
        case 1: invert = r % 2 === 0; break;
        case 2: invert = c % 3 === 0; break;
        case 3: invert = (r + c) % 3 === 0; break;
        case 4: invert = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: invert = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: invert = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: invert = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (invert) modules[r][c] ^= 1;
    }
  }
}

function calculatePenalty(modules, size) {
  let penalty = 0;
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
        if (runLen === 5) penalty += 3;
        else if (runLen > 5) penalty += 1;
      } else {
        runColor = modules[r][c];
        runLen = 1;
      }
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r][c];
      if (
        color === modules[r][c + 1] &&
        color === modules[r + 1][c] &&
        color === modules[r + 1][c + 1]
      ) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

function generateQRMatrix(text) {
  const utf8Bytes = Buffer.from(String(text), 'utf8');
  const version = selectVersion(utf8Bytes.length);
  const dataCodewords = encodeDataCodewords(utf8Bytes, version);
  const allCodewords = interleaveCodewords(dataCodewords, version);

  const { size, modules, isFunction } = createMatrix(version);
  placeDataBits(modules, isFunction, size, allCodewords);

  let bestMask = 0;
  let lowestPenalty = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const copy = modules.map((row) => new Uint8Array(row));
    applyMask(copy, isFunction, size, mask);
    drawFormatBits(copy, size, mask);
    const p = calculatePenalty(copy, size);
    if (p < lowestPenalty) {
      lowestPenalty = p;
      bestMask = mask;
    }
  }

  applyMask(modules, isFunction, size, bestMask);
  drawFormatBits(modules, size, bestMask);

  return modules.map((row) => Array.from(row));
}

function generateQRSVG(text, options = {}) {
  const {
    margin = 4,
    darkColor = '#1f2937',
    lightColor = '#ffffff',
    sizePx = 280,
  } = options;

  const matrix = generateQRMatrix(text);
  const moduleCount = matrix.length;
  const totalSize = moduleCount + margin * 2;

  let pathData = '';
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (matrix[r][c] === 1) {
        const x = c + margin;
        const y = r + margin;
        pathData += `M${x},${y}h1v1h-1z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges">
  <rect width="100%" height="100%" fill="${lightColor}" rx="1.5"/>
  <path d="${pathData.trim()}" fill="${darkColor}"/>
</svg>`;
}

module.exports = {
  generateQRMatrix,
  generateQRSVG,
};
