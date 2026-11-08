'use strict';
// One-time import of the old flat-file catalog into the database.
// Usage: node scripts/migrate-json.js path/to/products.json [path/to/old/uploads]
//
// Field names are mapped loosely (name/title, price, description, category, sku/partNumber, stock/quantity).
// Adjust FIELD_MAP if your products.json uses different keys. Every record goes through the same
// validation as the admin API; invalid ones are reported and skipped, and nothing is written unless
// the whole import succeeds (single transaction).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { openDb, transaction } = require('../src/db');
const { createProductModel } = require('../src/models/productModel');
const { createImageService } = require('../src/services/imageService');
const { validateProduct } = require('../src/validation/schemas');

const FIELD_MAP = {
  name: ['name', 'title'],
  price: ['price', 'cost'],
  description: ['description', 'desc'],
  category: ['category', 'type'],
  sku: ['sku', 'partNumber', 'part_number', 'oem'],
  stock: ['stock', 'quantity', 'qty'],
};
const IMAGE_KEYS = ['image', 'photo', 'img', 'imageUrl'];

function pick(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  return undefined;
}

async function main() {
  const [jsonFile, oldUploads] = process.argv.slice(2);
  if (!jsonFile) throw new Error('Usage: node scripts/migrate-json.js products.json [old-uploads-dir]');
  const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.products;
  if (!Array.isArray(list)) throw new Error('Expected an array (or { products: [...] })');

  const db = openDb(config.dbFile);
  const products = createProductModel(db);
  const images = createImageService(db, { uploadDir: config.uploadDir });

  const rows = [];
  const skipped = [];
  list.forEach((item, i) => {
    const body = {};
    for (const [field, keys] of Object.entries(FIELD_MAP)) {
      let v = pick(item, keys);
      if (v === undefined) continue;
      if (field === 'price' || field === 'stock') v = Number(v);
      if (field === 'sku') v = String(v);
      body[field] = v;
    }
    try {
      rows.push({ data: validateProduct(body, { partial: false }), image: pick(item, IMAGE_KEYS) });
    } catch (err) {
      skipped.push({ index: i, name: body.name, errors: err.details || [err.message] });
    }
  });

  const created = transaction(db, () => rows.map((r) => ({ product: products.create(r.data), image: r.image })));

  // Re-import photos through the same validation as new uploads (magic bytes, size, new random name).
  let imported = 0;
  if (oldUploads) {
    const base = path.resolve(oldUploads);
    for (const { product, image } of created) {
      if (typeof image !== 'string') continue;
      const file = path.resolve(base, path.basename(image)); // basename(): ignore any directories in the old value
      const ext = path.extname(file).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
      try {
        const buf = fs.readFileSync(file);
        if (!mime || buf.length > config.maxUploadBytes) throw new Error('type/size not allowed');
        const saved = await images.save(buf, mime);
        products.setImage(product.id, saved.id);
        imported++;
      } catch (err) {
        skipped.push({ productId: product.id, image, errors: [`image skipped: ${err.message}`] });
      }
    }
  }

  console.log(`Imported ${created.length} products, ${imported} images.`);
  if (skipped.length) console.log('Skipped:', JSON.stringify(skipped, null, 2));
  db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
