'use strict';
const { HttpError, readJson, readBody, sendJson } = require('../lib/http');
const { validateProduct, validateSearchQuery, parseId } = require('../validation/schemas');
const { toPublic, toAdmin } = require('../models/productModel');

function createProductController({ products, images, audit, config }) {
  const mustFind = (id) => {
    const p = products.findById(id);
    if (!p) throw new HttpError(404, 'Product not found');
    return p;
  };

  const constraintError = (err) => {
    if (String(err.message).includes('UNIQUE constraint failed: products.sku')) {
      return new HttpError(409, 'A product with this SKU already exists');
    }
    return err;
  };

  return {
    // ---- public (storefront) ----
    listPublic(req, res) {
      const { items, total } = products.search(validateSearchQuery(req.query));
      sendJson(res, 200, { items: items.map(toPublic), total });
    },
    getPublic(req, res) {
      sendJson(res, 200, toPublic(mustFind(parseId(req.params.id))));
    },

    // ---- admin (every route below is behind requireAdmin) ----
    listAdmin(req, res) {
      const { items, total } = products.search(validateSearchQuery(req.query));
      sendJson(res, 200, { items: items.map(toAdmin), total });
    },

    async create(req, res) {
      const data = validateProduct(await readJson(req, config.maxJsonBytes), { partial: false });
      let created;
      try {
        created = products.create(data);
      } catch (err) {
        throw constraintError(err);
      }
      audit(req, 'product.create', String(created.id));
      sendJson(res, 201, toAdmin(created));
    },

    async update(req, res) {
      const id = parseId(req.params.id);
      const data = validateProduct(await readJson(req, config.maxJsonBytes), { partial: true });
      let updated;
      try {
        updated = products.update(id, data);
      } catch (err) {
        throw constraintError(err);
      }
      if (!updated) throw new HttpError(404, 'Product not found');
      audit(req, 'product.update', String(id));
      sendJson(res, 200, toAdmin(updated));
    },

    async remove(req, res) {
      const id = parseId(req.params.id);
      const removed = products.remove(id);
      if (!removed) throw new HttpError(404, 'Product not found');
      await images.remove(removed.image_id);
      audit(req, 'product.delete', String(id));
      res.writeHead(204);
      res.end();
    },

    /** PUT /api/admin/products/:id/image — raw image bytes as the body (no multipart parsing needed). */
    async uploadImage(req, res) {
      const id = parseId(req.params.id);
      const product = mustFind(id);
      // Reject wrong types before reading any of the body; save() re-checks against the real bytes.
      const type = req.headers['content-type'];
      if (!/^image\/(jpeg|png|webp)\s*(;|$)/i.test(type || '')) {
        throw new HttpError(415, 'Only JPEG, PNG and WebP images are accepted');
      }
      const buf = await readBody(req, config.maxUploadBytes);
      const saved = await images.save(buf, type);
      if (!products.setImage(id, saved.id)) {
        await images.remove(saved.id);
        throw new HttpError(404, 'Product not found');
      }
      await images.remove(product.image_id); // drop the old file
      audit(req, 'product.image', `${id}:${saved.id}`);
      sendJson(res, 201, toAdmin(products.findById(id)));
    },
  };
}

module.exports = { createProductController };
