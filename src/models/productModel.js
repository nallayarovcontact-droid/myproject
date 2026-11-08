'use strict';
const { transaction } = require('../db');

// Every query is parameterized — user input never becomes part of the SQL text.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function createProductModel(db) {
  const columns = 'id, sku, name, description, category, price_cents, stock, image_id, created_at, updated_at';
  const stmts = {
    byId: db.prepare(`SELECT ${columns} FROM products WHERE id = ?`),
    search: db.prepare(
      `SELECT ${columns} FROM products
        WHERE (:q = '' OR name LIKE :pat ESCAPE '\\' OR sku LIKE :pat ESCAPE '\\' OR category LIKE :pat ESCAPE '\\')
        ORDER BY name LIMIT :limit OFFSET :offset`
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS n FROM products
        WHERE (:q = '' OR name LIKE :pat ESCAPE '\\' OR sku LIKE :pat ESCAPE '\\' OR category LIKE :pat ESCAPE '\\')`
    ),
    insert: db.prepare(
      `INSERT INTO products (sku, name, description, category, price_cents, stock, created_at, updated_at)
       VALUES (:sku, :name, :description, :category, :price_cents, :stock, :now, :now)`
    ),
    remove: db.prepare('DELETE FROM products WHERE id = ?'),
    setImage: db.prepare('UPDATE products SET image_id = ?, updated_at = ? WHERE id = ?'),
  };

  // Column whitelist for updates — field names come from this list, never from the request.
  const UPDATABLE = ['sku', 'name', 'description', 'category', 'price_cents', 'stock'];

  return {
    findById(id) {
      return stmts.byId.get(id) || null;
    },
    search({ q = '', limit = 50, offset = 0 }) {
      const params = { q, pat: `%${escapeLike(q)}%`, limit, offset };
      return { items: stmts.search.all(params), total: stmts.count.get({ q, pat: params.pat }).n };
    },
    create(p) {
      const info = stmts.insert.run({
        sku: p.sku ?? null,
        name: p.name,
        description: p.description ?? '',
        category: p.category ?? '',
        price_cents: p.price_cents,
        stock: p.stock ?? 0,
        now: Date.now(),
      });
      return this.findById(Number(info.lastInsertRowid));
    },
    update(id, changes) {
      const keys = Object.keys(changes).filter((k) => UPDATABLE.includes(k));
      if (keys.length === 0) return this.findById(id);
      const sql = `UPDATE products SET ${keys.map((k) => `${k} = :${k}`).join(', ')}, updated_at = :now WHERE id = :id`;
      const params = { id, now: Date.now() };
      for (const k of keys) params[k] = changes[k];
      const info = db.prepare(sql).run(params);
      return info.changes ? this.findById(id) : null;
    },
    remove(id) {
      return transaction(db, () => {
        const existing = stmts.byId.get(id);
        if (!existing) return null;
        stmts.remove.run(id);
        return existing;
      });
    },
    setImage(id, imageId) {
      return stmts.setImage.run(imageId, Date.now(), id).changes > 0;
    },
  };
}

/** Public shape — what the storefront is allowed to see. */
function toPublic(p) {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.price_cents / 100,
    inStock: p.stock > 0,
    imageUrl: p.image_id ? `/media/${p.image_id}` : null,
  };
}

/** Admin shape — includes stock counts and timestamps. */
function toAdmin(p) {
  return { ...toPublic(p), stock: p.stock, imageId: p.image_id, createdAt: p.created_at, updatedAt: p.updated_at };
}

module.exports = { createProductModel, toPublic, toAdmin };
