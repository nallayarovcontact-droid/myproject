'use strict';

const $ = (id) => document.getElementById(id);
const IS_ADMIN = location.pathname.replace(/\/$/, '') === '/admin';
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const symbols = { Engine: '⚙', Exterior: '◆', Interior: '▤', Wheels: '◉', Lighting: '✦', Brakes: '◎', Accessories: '◇' };

const t = {
  en: ['INDEPENDENT BMW PARTS CATALOG', 'Built for the <span>drive.</span>', 'Explore performance, exterior, interior and maintenance parts. Browse parts and check compatibility before ordering.', 'Products listed', 'Explore Parts', 'Search products or BMW models...', 'Store'],
  tr: ['BAĞIMSIZ BMW PARÇA KATALOĞU', 'Sürüş için <span>tasarlandı.</span>', 'Performans, dış, iç ve bakım parçalarını keşfedin. Sipariş vermeden önce parçalara göz atın ve uyumluluğu kontrol edin.', 'Listelenen ürün', 'Parçaları Keşfet', 'Ürün veya BMW modeli ara...', 'Mağaza'],
  ru: ['НЕЗАВИСИМЫЙ КАТАЛОГ ЗАПЧАСТЕЙ BMW', 'Создано для <span>дороги.</span>', 'Исследуйте детали двигателя, кузова, салона и обслуживания. Просматривайте детали и проверяйте совместимость перед заказом.', 'Товаров', 'Каталог деталей', 'Поиск товаров и моделей BMW...', 'Магазин'],
};

let products = [];
let editId = null;

// ---------- Helpers ----------
async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(text) {
  const m = $('message');
  m.textContent = text;
  m.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { m.style.display = 'none'; }, 3200);
}

function el(tag, cls, text) {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (text !== undefined) x.textContent = text;
  return x;
}

const money = (n) => '$' + Number(n).toFixed(2);

function translate() {
  const lang = $('lang').value;
  const a = t[lang];
  ['eyebrow', 'heroTitle', 'heroDesc', 'countLabel', 'catalogTitle'].forEach((id, i) => {
    $(id)[i === 1 ? 'innerHTML' : 'textContent'] = a[i];
  });
  $('search').placeholder = a[5];
  $('shopBtn').textContent = a[6];
  document.documentElement.lang = lang;
  try { localStorage.setItem('lang', lang); } catch { /* storage unavailable */ }
}

// ---------- Store ----------
function showDetails(p) {
  $('dCategory').textContent = p.category;
  $('dName').textContent = p.name;
  $('dDesc').textContent = p.description || 'No description yet.';
  $('dModels').textContent = 'Compatible: ' + (p.models || 'Check fitment');
  $('details').showModal();
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const cat = $('category').value;
  const sort = $('sort').value;
  const list = products.filter((p) =>
    (p.name + ' ' + p.models + ' ' + p.description).toLowerCase().includes(q) && (!cat || p.category === cat));
  if (sort === 'asc') list.sort((a, b) => a.price - b.price);
  if (sort === 'desc') list.sort((a, b) => b.price - a.price);

  const grid = $('products');
  grid.replaceChildren();
  list.forEach((p) => {
    const card = el('article', 'card');
    const photo = el('div', 'photo');
    if (p.image) {
      const img = el('img');
      img.src = p.image;
      img.alt = p.name;
      img.loading = 'lazy';
      photo.append(img);
    } else {
      photo.textContent = symbols[p.category] || '◆';
    }
    const inner = el('div', 'inside');
    inner.append(
      el('div', 'category', p.category),
      el('h3', '', p.name),
      el('div', 'muted', 'Fits: ' + (p.models || 'Check fitment')),
      el('div', 'price', money(p.price)),
      el('div', 'muted', p.stock > 0 ? 'Stock: ' + p.stock : 'Out of stock'),
    );
    const b = el('button', 'secondary', 'View details');
    b.onclick = () => showDetails(p);
    inner.append(b);
    card.append(photo, inner);
    grid.append(card);
  });
  if (!list.length) grid.append(el('p', '', 'No products found.'));
  $('count').textContent = products.length;
}

async function loadProducts() {
  try {
    products = await api('/api/products');
  } catch (err) {
    toast('Could not load products: ' + err.message);
    products = [];
  }
  render();
  if (IS_ADMIN) renderAdmin();
}

// ---------- Admin ----------
function showLogin() {
  $('loginPanel').classList.remove('hidden');
  $('adminPanel').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('password').focus();
}

function showAdminPanel() {
  $('loginPanel').classList.add('hidden');
  $('adminPanel').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  renderAdmin();
}

function handleAuthError(err) {
  if (err.status === 401) { toast('Session expired. Please log in again.'); showLogin(); return true; }
  return false;
}

function renderAdmin() {
  $('adminCount').textContent = products.length;
  const listEl = $('adminList');
  listEl.replaceChildren();
  products.forEach((p) => {
    const row = el('div', 'adminrow');
    if (p.image) {
      const img = el('img');
      img.src = p.image;
      img.alt = '';
      row.append(img);
    } else {
      row.append(el('span', 'tag', p.category));
    }
    const info = el('div', 'info');
    info.append(el('strong', '', p.name), el('div', 'muted', money(p.price) + ' · ' + (p.models || '—') + ' · Stock ' + p.stock));
    const edit = el('button', 'secondary', 'Edit');
    edit.onclick = () => startEdit(p.id);
    const del = el('button', '', 'Delete');
    del.onclick = async () => {
      if (!confirm('Delete ' + p.name + '?')) return;
      try {
        await api('/api/products/' + encodeURIComponent(p.id), { method: 'DELETE' });
        if (editId === p.id) resetForm();
        toast('Product deleted.');
        await loadProducts();
      } catch (err) {
        if (!handleAuthError(err)) toast(err.message);
      }
    };
    row.append(info, edit, del);
    listEl.append(row);
  });
}

function startEdit(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  editId = id;
  ['name', 'price', 'models', 'stock', 'description'].forEach((k) => { $(k).value = p[k] ?? ''; });
  $('editCategory').value = p.category;
  $('picture').value = '';
  $('removeImage').checked = false;
  $('removeImageWrap').classList.toggle('hidden', !p.image);
  $('formTitle').textContent = 'Edit product';
  $('productForm').scrollIntoView({ behavior: 'smooth' });
}

function resetForm() {
  editId = null;
  $('productForm').reset();
  $('removeImageWrap').classList.add('hidden');
  $('formTitle').textContent = 'Add a product';
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onSave(e) {
  e.preventDefault();
  const file = $('picture').files[0];
  if (file && file.size > MAX_IMAGE_BYTES) { toast('Please choose an image smaller than 1.5 MB.'); return; }

  const payload = {
    name: $('name').value.trim(),
    price: Number($('price').value),
    category: $('editCategory').value,
    models: $('models').value.trim(),
    stock: Number($('stock').value),
    description: $('description').value.trim(),
  };
  if (file) payload.imageData = await readAsDataUrl(file);
  else if (editId && $('removeImage').checked) payload.removeImage = true;

  const saveBtn = $('save');
  saveBtn.disabled = true;
  try {
    if (editId) await api('/api/products/' + encodeURIComponent(editId), { method: 'PUT', body: payload });
    else await api('/api/products', { method: 'POST', body: payload });
    resetForm();
    toast('Product saved.');
    await loadProducts();
  } catch (err) {
    if (!handleAuthError(err)) toast(err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

async function initAdmin() {
  $('shop').style.display = 'none';
  $('admin').style.display = 'block';
  document.title = 'Admin | BMW Parts World';

  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      showAdminPanel();
    } catch (err) {
      toast(err.message);
    }
  };
  $('logoutBtn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    resetForm();
    showLogin();
  };
  $('cancel').onclick = resetForm;
  $('productForm').onsubmit = onSave;

  try {
    const { authenticated } = await api('/api/session');
    authenticated ? showAdminPanel() : showLogin();
  } catch {
    showLogin();
  }
}

// ---------- Boot ----------
$('shopBtn').onclick = () => { location.href = '/'; };
['search', 'category', 'sort'].forEach((id) => $(id).addEventListener('input', render));
document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
  $('category').value = chip.dataset.cat;
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === chip));
  render();
}));
try { const saved = localStorage.getItem('lang'); if (saved && t[saved]) $('lang').value = saved; } catch { /* ignore */ }
$('lang').onchange = translate;
translate();

if (IS_ADMIN) initAdmin();
else { $('shop').style.display = 'block'; $('admin').style.display = 'none'; }
loadProducts();
