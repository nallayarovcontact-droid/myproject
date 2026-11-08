'use strict';
// Storefront. All product data is written with textContent / attributes — never innerHTML —
// so a product name like <img onerror=...> is displayed as text, not executed.

const grid = document.getElementById('grid');
const statusEl = document.getElementById('status');
const tpl = document.getElementById('card');
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });

async function load(q = '') {
  statusEl.textContent = 'Loading…';
  const params = new URLSearchParams({ q, limit: '48' });
  try {
    const res = await fetch(`/api/products?${params}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { items, total } = await res.json();
    render(items);
    statusEl.textContent = total ? `${total} part${total === 1 ? '' : 's'}` : 'No parts found.';
  } catch (err) {
    statusEl.textContent = `Could not load products: ${err.message}`;
  }
}

function render(items) {
  grid.replaceChildren(
    ...items.map((p) => {
      const node = tpl.content.firstElementChild.cloneNode(true);
      const img = node.querySelector('img');
      if (p.imageUrl) {
        img.src = p.imageUrl;
        img.alt = p.name;
      } else {
        img.remove();
      }
      node.querySelector('.name').textContent = p.name;
      node.querySelector('.sku').textContent = p.sku ? `Part no. ${p.sku}` : '';
      node.querySelector('.desc').textContent = p.description;
      node.querySelector('.price').textContent = `${money.format(p.price)}${p.inStock ? '' : ' · out of stock'}`;
      return node;
    })
  );
}

document.getElementById('search').addEventListener('submit', (e) => {
  e.preventDefault();
  load(document.getElementById('q').value.trim());
});

load();
