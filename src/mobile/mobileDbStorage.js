const PACKED_DB_VERSION = 1;
const IMAGE_REF_PREFIX = '__billnest_image_ref_v1__:';

export function serializeMobileDb(db) {
  const imageIds = new Map();
  const images = [];
  function pack(value) {
    if (typeof value === 'string' && value.startsWith('data:image/')) {
      let id = imageIds.get(value);
      if (id === undefined) {
        id = images.length;
        imageIds.set(value, id);
        images.push(value);
      }
      return `${IMAGE_REF_PREFIX}${id}`;
    }
    if (Array.isArray(value)) return value.map(pack);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pack(entry)]));
    }
    return value;
  }

  const packed = pack(db);
  if (!images.length) return JSON.stringify(db);
  return JSON.stringify({ version: PACKED_DB_VERSION, images, data: packed });
}

export function parseMobileDb(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || parsed.version !== PACKED_DB_VERSION || !Array.isArray(parsed.images) || !parsed.data) {
    return parsed;
  }
  function unpack(value) {
    if (typeof value === 'string' && value.startsWith(IMAGE_REF_PREFIX)) {
      const index = Number(value.slice(IMAGE_REF_PREFIX.length));
      if (!Number.isInteger(index) || index < 0 || index >= parsed.images.length) {
        throw new Error('The saved mobile database contains an invalid image reference.');
      }
      return parsed.images[index];
    }
    if (Array.isArray(value)) return value.map(unpack);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unpack(entry)]));
    }
    return value;
  }
  return unpack(parsed.data);
}
