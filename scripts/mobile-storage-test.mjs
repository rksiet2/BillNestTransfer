import assert from 'node:assert/strict';
import { parseMobileDb, serializeMobileDb } from '../src/mobile/mobileDbStorage.js';

const logo = `data:image/jpeg;base64,${'a'.repeat(12000)}`;
const db = {
  settings: { room_biz_logo_path: logo },
  foodItems: [{ name: 'Dish', image_path: logo }],
  bills: Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    hotelLogo: logo,
    total: index * 100,
  })),
};
const serialized = serializeMobileDb(db);
assert.ok(serialized.length < JSON.stringify(db).length / 10, 'duplicate bill/logo images are stored once');
assert.deepEqual(parseMobileDb(serialized), db, 'packing and parsing preserves every stored record and image');
assert.deepEqual(parseMobileDb(JSON.stringify(db)), db, 'older unpacked mobile databases remain readable');

console.log('PASS: repeated image data is deduplicated in localStorage representation.');
console.log('PASS: packed and legacy databases round-trip without losing bill data.');
