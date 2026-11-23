/**
 * Minimal zero-dependency ZIP (.qpack) reader using browser-native DecompressionStream.
 * Supports method 0 (STORE - used for images) and method 8 (DEFLATE - used for manifest.json).
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(view) {
  const minOffset = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      return i;
    }
  }
  throw new Error("Неверный формат .qpack (не найден End of Central Directory)");
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Браузер не поддерживает DecompressionStream");
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Parse a .qpack ArrayBuffer into a Map<string, Uint8Array>.
 */
export async function readQpackArchive(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const eocdOffset = findEOCD(view);

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const decoder = new TextDecoder("utf-8");
  const files = new Map();
  let ptr = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (view.getUint32(ptr, true) !== CEN_SIG) {
      throw new Error("Поврежденный Central Directory в .qpack");
    }
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const filename = decoder.decode(nameBytes);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (filename.endsWith("/")) continue;

    if (view.getUint32(localHeaderOffset, true) !== LOC_SIG) {
      throw new Error(`Поврежденный Local File Header для ${filename}`);
    }
    const locNameLen = view.getUint16(localHeaderOffset + 26, true);
    const locExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + locNameLen + locExtraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    let outBytes;
    if (method === 0) {
      outBytes = compData.slice();
    } else if (method === 8) {
      outBytes = await inflateRaw(compData);
    } else {
      throw new Error(`Неподдерживаемый метод сжатия ZIP (${method}) для ${filename}`);
    }
    files.set(filename, outBytes);
  }

  return files;
}
