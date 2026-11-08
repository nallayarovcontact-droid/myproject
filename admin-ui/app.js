'use strict';
// Admin UI. This file is only served to admin sessions, but that is a convenience —
// the real protection is requireAdmin on every /api/admin route.

const form = document.getElementById('product-form');
const rows = document.getElementById('rows');
const formError = document.getElementById('form-error');
const MAX_UPLOAD = 5 * 1024 * 1024;
const field = (n) => form.elements.namedItem(n); // avoids clashes with form.id / form.name

async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: json ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(json) : body,
  });
  if (res.status === 401) {
    location.assign('/login.html?next=/admin/');
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([data.error, ...(data.details || [])].filter(Boolean).join(' — ') || res.statusText);
  return data;
}

async function refresh() {
  const q = document.getElementById('q').value.trim();
  const { items } = await api(`/api/admin/products?${new URLSearchParams({ q, limit: '100' })}`);
  rows.replaceChildren(...items.map(row));
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function row(p) {
  const tr = document.createElement('tr');
  const imgTd = document.createElement('td');
  if (p.imageUrl) {
    const img = document.createElement('img');
    img.src = p.imageUrl;
    img.alt = '';
    imgTd.append(img);
  }
  const actions = document.createElement('td');
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit', className: 'secondary' });
  edit.addEventListener('click', () => fill(p));
  const del = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Delete', className: 'danger' });
  del.addEventListener('click', () => remove(p));
  wrap.append(edit, del);
  actions.append(wrap);
  tr.append(imgTd, cell(p.name), cell(p.sku || ''), cell(p.price.toFixed(2)), cell(String(p.stock)), actions);
  return tr;
}

function fill(p) {
  field('id').value = p.id;
  field('name').value = p.name;
  field('sku').value = p.sku || '';
  field('category').value = p.category;
  field('price').value = p.price;
  field('stock').value = p.stock;
  field('description').value = p.description;
  document.getElementById('form-title').textContent = `Edit #${p.id}`;
  field('name').focus();
}

async function remove(p) {
  // confirm() is fine in a real browser; it only matters for automated testing tools.
  if (!window.confirm(`Delete "${p.name}"?`)) return;
  try {
    await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    formError.textContent = err.message;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  const file = field('photo').files[0];
  if (file && file.size > MAX_UPLOAD) {
    formError.textContent = 'Photo is larger than 5 MB';
    return;
  }
  const payload = {
    name: field('name').value,
    sku: field('sku').value.trim() || null,
    category: field('category').value,
    price: Number(field('price').value),
    stock: Number(field('stock').value || 0),
    description: field('description').value,
  };
  try {
    const id = field('id').value;
    const saved = id
      ? await api(`/api/admin/products/${id}`, { method: 'PATCH', json: payload })
      : await api('/api/admin/products', { method: 'POST', json: payload });
    if (file) {
      // Raw bytes, typed by the browser; the server re-checks the real type from the file's magic bytes.
      await api(`/api/admin/products/${saved.id}/image`, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
    }
    form.reset();
    await refresh();
  } catch (err) {
    formError.textContent = err.message;
  }
});

form.addEventListener('reset', () => {
  field('id').value = '';
  document.getElementById('form-title').textContent = 'New product';
  formError.textContent = '';
});

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  refresh();
});

document.getElementById('logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.assign('/');
});

api('/api/auth/me').then(({ user }) => {
  document.getElementById('who').textContent = user ? user.username : '';
});
refresh().catch((err) => (formError.textContent = err.message));
