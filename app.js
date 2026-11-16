'use strict';

/* ================= Banco de dados (SQLite via sql.js, salvo no IndexedDB) ================= */

let db;
const IDB_NAME = 'adega-comandas';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'db';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(bytes) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

let saveChain = Promise.resolve();
function persist() {
  const bytes = db.export();
  saveChain = saveChain.then(() => idbPut(bytes)).catch(err => {
    console.error(err);
    toast('Erro ao salvar os dados!');
  });
  return saveChain;
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS produto (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  marca TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL CHECK (categoria IN ('cerveja','vinho','destilado','petisco','outros')),
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS comanda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES cliente(id),
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga')),
  aberta_em TEXT NOT NULL,
  fechada_em TEXT,
  forma_pagamento TEXT CHECK (forma_pagamento IN ('pix','cartao','dinheiro')),
  total_centavos INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item_comanda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comanda(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produto(id),
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unit_centavos INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_comanda ON item_comanda(comanda_id);
CREATE INDEX IF NOT EXISTS idx_comanda_status ON comanda(status, fechada_em);
`;

function migrate() {
  db.exec(SCHEMA);
  const cols = all(`PRAGMA table_info(produto)`).map(c => c.name);
  if (!cols.includes('foto')) db.exec(`ALTER TABLE produto ADD COLUMN foto TEXT`);
}

function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}
function one(sql, params = []) { return all(sql, params)[0]; }
function run(sql, params = []) { db.run(sql, params); }
function lastId() { return one('SELECT last_insert_rowid() AS id').id; }

function recalcTotal(comandaId) {
  run(`UPDATE comanda SET total_centavos =
         (SELECT COALESCE(SUM(subtotal_centavos),0) FROM item_comanda WHERE comanda_id = ?)
       WHERE id = ?`, [comandaId, comandaId]);
}

/* ================= Utilidades ================= */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = c => brl.format((c || 0) / 100);

function parseMoney(str) {
  // aceita "12,50", "12.50", "R$ 1.234,56"
  let s = String(str).replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const centsToInput = c => (c / 100).toFixed(2).replace('.', ',');

const onlyDigits = s => String(s || '').replace(/\D/g, '');
function fmtPhone(d) {
  d = onlyDigits(d);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

function nowLocal() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const todayLocal = () => nowLocal().slice(0, 10);
function fmtDateTime(s) {
  if (!s) return '';
  const [date, time] = s.split(' ');
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y} ${time.slice(0, 5)}`;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORIAS = [
  ['cerveja', 'Cerveja'], ['vinho', 'Vinho'], ['destilado', 'Destilado'],
  ['petisco', 'Petisco'], ['outros', 'Outros']
];
const catLabel = k => (CATEGORIAS.find(c => c[0] === k) || [k, k])[1];
const PAGAMENTOS = [['pix', 'Pix'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']];
const payLabel = k => (PAGAMENTOS.find(p => p[0] === k) || [k, k])[1];

const thumb = p => p.foto
  ? `<img class="thumb" src="${esc(p.foto)}" alt="" loading="lazy">`
  : `<span class="thumb thumb-empty" aria-hidden="true">${esc((p.nome || '?').trim()[0] || '?')}</span>`;

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

const $view = () => document.getElementById('view');
const go = hash => { location.hash = hash; };

function setHeader(title, backTo) {
  document.getElementById('title').textContent = title;
  document.title = `${title} · Comandas`;
  const back = document.getElementById('back');
  back.hidden = !backTo;
  back.onclick = () => go(backTo);
}

/* ================= Telas ================= */

// 1. Comandas abertas
function viewAbertas() {
  setHeader('Comandas abertas');
  const rows = all(`SELECT c.id, c.total_centavos, c.aberta_em, cl.nome, cl.telefone
                    FROM comanda c JOIN cliente cl ON cl.id = c.cliente_id
                    WHERE c.status = 'aberta' ORDER BY c.aberta_em DESC`);
  $view().innerHTML = `
    <button class="btn primary" id="nova">+ Nova comanda</button>
    <h2>${rows.length} aberta${rows.length === 1 ? '' : 's'}</h2>
    ${rows.length ? `<ul class="list">${rows.map(r => `
      <li data-id="${r.id}">
        <div class="main"><div class="name">${esc(r.nome)}</div>
          <div class="sub">Aberta ${esc(fmtDateTime(r.aberta_em).slice(11))} · ${esc(fmtPhone(r.telefone))}</div></div>
        <div class="value">${money(r.total_centavos)}</div>
      </li>`).join('')}</ul>`
      : `<p class="empty">Nenhuma comanda aberta.</p>`}`;
  document.getElementById('nova').onclick = () => go('#/nova');
  $view().querySelectorAll('li[data-id]').forEach(li =>
    li.onclick = () => go(`#/comanda/${li.dataset.id}`));
}

// 2. Nova comanda
function viewNova() {
  setHeader('Nova comanda', '#/');
  $view().innerHTML = `
    <div class="stack">
      <div><label for="tel">Telefone do cliente</label>
        <input id="tel" type="tel" inputmode="numeric" placeholder="(14) 99999-9999" autocomplete="off"></div>
      <div id="resultado"></div>
    </div>`;
  const tel = document.getElementById('tel');
  const res = document.getElementById('resultado');

  function abrir(clienteId) {
    const aberta = one(`SELECT id FROM comanda WHERE cliente_id = ? AND status = 'aberta'`, [clienteId]);
    if (aberta) { toast('Cliente já tem comanda aberta'); go(`#/comanda/${aberta.id}`); return; }
    run(`INSERT INTO comanda (cliente_id, aberta_em) VALUES (?, ?)`, [clienteId, nowLocal()]);
    const id = lastId();
    persist();
    toast('Comanda aberta');
    go(`#/comanda/${id}`);
  }

  function update() {
    const d = onlyDigits(tel.value);
    if (d.length < 10) {
      res.innerHTML = d.length ? `<p class="muted">Digite o telefone com DDD.</p>` : '';
      return;
    }
    const c = one(`SELECT * FROM cliente WHERE telefone = ?`, [d]);
    if (c) {
      res.innerHTML = `
        <ul class="list"><li class="static"><div class="main"><div class="name">${esc(c.nome)}</div>
          <div class="sub">${esc(fmtPhone(c.telefone))} · cliente cadastrado</div></div></li></ul>
        <button class="btn primary" id="abrir">Abrir comanda</button>`;
      document.getElementById('abrir').onclick = () => abrir(c.id);
    } else {
      res.innerHTML = `
        <p class="muted">Cliente novo. Cadastre o nome:</p>
        <div><label for="nome">Nome</label><input id="nome" autocomplete="off" autocapitalize="words"></div>
        <div class="bottom-actions"><button class="btn primary" id="cad">Cadastrar e abrir comanda</button></div>`;
      const nome = document.getElementById('nome');
      document.getElementById('cad').onclick = () => {
        const n = nome.value.trim();
        if (!n) { toast('Informe o nome'); nome.focus(); return; }
        run(`INSERT INTO cliente (nome, telefone) VALUES (?, ?)`, [n, d]);
        abrir(lastId());
      };
    }
  }
  tel.oninput = update;
  tel.focus();
}

// 3. Detalhe da comanda
function viewComanda(id) {
  const c = one(`SELECT c.*, cl.nome, cl.telefone FROM comanda c
                 JOIN cliente cl ON cl.id = c.cliente_id WHERE c.id = ?`, [id]);
  if (!c) return viewNotFound();
  const paga = c.status === 'paga';
  setHeader(c.nome, paga ? '#/historico' : '#/');
  const itens = all(`SELECT i.*, p.nome, p.marca, p.foto FROM item_comanda i
                     JOIN produto p ON p.id = i.produto_id
                     WHERE i.comanda_id = ? ORDER BY i.id`, [id]);
  $view().innerHTML = `
    <div class="total-box">
      <div class="label">${paga ? 'Total pago' : 'Total parcial'}</div>
      <div class="amount">${money(c.total_centavos)}</div>
      <div class="label">${esc(fmtPhone(c.telefone))} · aberta ${esc(fmtDateTime(c.aberta_em))}
        ${paga ? `<br>Paga ${esc(fmtDateTime(c.fechada_em))} · ${esc(payLabel(c.forma_pagamento))}` : ''}</div>
    </div>
    ${paga ? '' : `<button class="btn primary" id="add">+ Adicionar item</button>`}
    <h2>Itens</h2>
    ${itens.length ? `<ul class="list">${itens.map(i => `
      <li class="static">${thumb(i)}
        <div class="main"><div class="name">${i.quantidade}× ${esc(i.nome)}</div>
          <div class="sub">${esc(i.marca)}${i.marca ? ' · ' : ''}${money(i.preco_unit_centavos)} cada</div></div>
        <div class="value">${money(i.subtotal_centavos)}</div>
        ${paga ? '' : `<button class="chip" data-del="${i.id}" aria-label="Remover item">✕</button>`}
      </li>`).join('')}</ul>`
      : `<p class="empty">Nenhum item ainda.</p>`}
    ${paga ? '' : `<div class="bottom-actions">
      <button class="btn" id="fechar" ${itens.length ? '' : 'disabled'}>Fechar comanda</button>
      ${itens.length ? '' : `<button class="btn danger" id="cancelar">Cancelar comanda vazia</button>`}
    </div>`}`;
  if (paga) return;
  document.getElementById('add').onclick = () => go(`#/comanda/${id}/add`);
  document.getElementById('fechar').onclick = () => go(`#/comanda/${id}/fechar`);
  const cancelar = document.getElementById('cancelar');
  if (cancelar) cancelar.onclick = () => {
    if (!confirm('Cancelar esta comanda vazia?')) return;
    run(`DELETE FROM comanda WHERE id = ? AND status = 'aberta'`, [id]);
    persist(); toast('Comanda cancelada'); go('#/');
  };
  $view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm('Remover este item?')) return;
    run(`DELETE FROM item_comanda WHERE id = ? AND comanda_id = ?`, [b.dataset.del, id]);
    recalcTotal(id); persist(); toast('Item removido'); viewComanda(id);
  });
}

// 4. Adicionar item
function viewAddItem(id) {
  const c = one(`SELECT c.status, cl.nome FROM comanda c JOIN cliente cl ON cl.id = c.cliente_id WHERE c.id = ?`, [id]);
  if (!c || c.status !== 'aberta') return go(`#/comanda/${id}`);
  setHeader('Adicionar item', `#/comanda/${id}`);
  let cat = '';
  let busca = '';

  function renderLista() {
    $view().innerHTML = `
      <input id="busca" type="search" placeholder="Buscar produto ou marca" value="${esc(busca)}" autocomplete="off">
      <div class="chips" style="margin-top:12px">
        <button class="chip ${cat === '' ? 'active' : ''}" data-cat="">Todos</button>
        ${CATEGORIAS.map(([k, l]) => `<button class="chip ${cat === k ? 'active' : ''}" data-cat="${k}">${l}</button>`).join('')}
      </div>
      <ul class="list" id="lista"></ul>`;
    const inp = document.getElementById('busca');
    inp.oninput = () => { busca = inp.value; preencher(); };
    $view().querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { cat = b.dataset.cat; renderLista(); });
    preencher();
  }

  function preencher() {
    const termo = `%${busca.trim()}%`;
    const prods = all(`SELECT * FROM produto WHERE ativo = 1
                       AND (? = '' OR categoria = ?)
                       AND (nome LIKE ? OR marca LIKE ?)
                       ORDER BY categoria, nome`, [cat, cat, termo, termo]);
    const ul = document.getElementById('lista');
    ul.innerHTML = prods.length ? prods.map(p => `
      <li data-id="${p.id}">${thumb(p)}<div class="main"><div class="name">${esc(p.nome)}</div>
        <div class="sub">${esc(p.marca)}${p.marca ? ' · ' : ''}${esc(catLabel(p.categoria))}</div></div>
        <div class="value">${money(p.preco_centavos)}</div></li>`).join('')
      : `<p class="empty">Nenhum produto encontrado.<br>Cadastre na aba Produtos.</p>`;
    ul.querySelectorAll('li[data-id]').forEach(li =>
      li.onclick = () => escolher(prods.find(p => p.id === Number(li.dataset.id))));
  }

  function escolher(p) {
    let qtd = 1;
    $view().innerHTML = `
      <div class="selected-product">
        ${p.foto ? `<img class="foto-grande" src="${esc(p.foto)}" alt="">` : ''}
        <div class="name">${esc(p.nome)}</div>
        <div class="muted">${esc(p.marca)}${p.marca ? ' · ' : ''}${money(p.preco_centavos)} cada</div>
      </div>
      <div class="qty">
        <button id="menos" aria-label="Diminuir">−</button>
        <output id="q">1</output>
        <button id="mais" aria-label="Aumentar">+</button>
      </div>
      <div class="total-box"><div class="label">Subtotal</div><div class="amount" id="sub"></div></div>
      <button class="btn primary" id="ok">Adicionar à comanda</button>
      <button class="btn" id="voltar">Escolher outro produto</button>`;
    const upd = () => {
      document.getElementById('q').textContent = qtd;
      document.getElementById('sub').textContent = money(qtd * p.preco_centavos);
    };
    document.getElementById('menos').onclick = () => { if (qtd > 1) { qtd--; upd(); } };
    document.getElementById('mais').onclick = () => { qtd++; upd(); };
    document.getElementById('voltar').onclick = renderLista;
    document.getElementById('ok').onclick = () => {
      // preço congelado no momento da venda
      run(`INSERT INTO item_comanda (comanda_id, produto_id, quantidade, preco_unit_centavos, subtotal_centavos)
           VALUES (?, ?, ?, ?, ?)`, [id, p.id, qtd, p.preco_centavos, qtd * p.preco_centavos]);
      recalcTotal(id);
      persist();
      toast(`${qtd}× ${p.nome} adicionado`);
      go(`#/comanda/${id}`);
    };
    upd();
  }

  renderLista();
}

// 5. Fechar comanda
function viewFechar(id) {
  const c = one(`SELECT c.*, cl.nome FROM comanda c JOIN cliente cl ON cl.id = c.cliente_id WHERE c.id = ?`, [id]);
  if (!c || c.status !== 'aberta') return go(`#/comanda/${id}`);
  setHeader('Fechar comanda', `#/comanda/${id}`);
  const itens = all(`SELECT i.quantidade, i.subtotal_centavos, p.nome FROM item_comanda i
                     JOIN produto p ON p.id = i.produto_id WHERE i.comanda_id = ? ORDER BY i.id`, [id]);
  let forma = '';
  $view().innerHTML = `
    <div class="total-box"><div class="label">${esc(c.nome)} · total a pagar</div>
      <div class="amount">${money(c.total_centavos)}</div></div>
    <ul class="list">${itens.map(i => `<li class="static"><div class="main"><div class="name">${i.quantidade}× ${esc(i.nome)}</div></div>
      <div class="value">${money(i.subtotal_centavos)}</div></li>`).join('')}</ul>
    <h2>Forma de pagamento</h2>
    <div class="pay">${PAGAMENTOS.map(([k, l]) => `<button data-pay="${k}">${l}</button>`).join('')}</div>
    <button class="btn primary" id="confirmar" disabled>Confirmar pagamento</button>`;
  const conf = document.getElementById('confirmar');
  $view().querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    forma = b.dataset.pay;
    $view().querySelectorAll('[data-pay]').forEach(x => x.classList.toggle('active', x === b));
    conf.disabled = false;
  });
  conf.onclick = () => {
    if (!forma) return;
    recalcTotal(id);
    run(`UPDATE comanda SET status = 'paga', fechada_em = ?, forma_pagamento = ? WHERE id = ?`,
        [nowLocal(), forma, id]);
    persist();
    toast('Pagamento registrado');
    go('#/');
  };
}

// 6. Produtos
function viewProdutos() {
  setHeader('Produtos');
  const prods = all(`SELECT * FROM produto ORDER BY ativo DESC, categoria, nome`);
  $view().innerHTML = `
    <button class="btn primary" id="novo">+ Novo produto</button>
    <h2>${prods.length} produto${prods.length === 1 ? '' : 's'}</h2>
    ${prods.length ? `<ul class="list">${prods.map(p => `
      <li data-id="${p.id}" class="${p.ativo ? '' : 'off'}">${thumb(p)}<div class="main"><div class="name">${esc(p.nome)}</div>
        <div class="sub">${esc(p.marca)}${p.marca ? ' · ' : ''}${esc(catLabel(p.categoria))}${p.ativo ? '' : ' · desativado'}</div></div>
        <div class="value">${money(p.preco_centavos)}</div></li>`).join('')}</ul>`
      : `<p class="empty">Nenhum produto cadastrado.</p>`}
    <h2>Backup dos dados</h2>
    <p class="muted">Os dados ficam só neste aparelho. Faça backup de vez em quando.</p>
    <button class="btn" id="exportar">Baixar backup</button>
    <button class="btn" id="importar">Restaurar backup</button>
    <input type="file" id="arquivo" accept=".sqlite,.db,application/octet-stream" hidden>`;
  document.getElementById('novo').onclick = () => go('#/produto/novo');
  $view().querySelectorAll('li[data-id]').forEach(li => li.onclick = () => go(`#/produto/${li.dataset.id}`));
  document.getElementById('exportar').onclick = exportarBackup;
  const arq = document.getElementById('arquivo');
  document.getElementById('importar').onclick = () => arq.click();
  arq.onchange = () => arq.files[0] && importarBackup(arq.files[0]);
}

function viewProdutoForm(id) {
  const p = id ? one(`SELECT * FROM produto WHERE id = ?`, [id]) : null;
  if (id && !p) return viewNotFound();
  setHeader(p ? 'Editar produto' : 'Novo produto', '#/produtos');
  $view().innerHTML = `
    ${p ? `<div class="foto-edit">
      ${p.foto ? `<img class="foto-grande" src="${esc(p.foto)}" alt="">` : `<p class="muted">Sem foto</p>`}
      <button class="btn" type="button" id="foto">${p.foto ? 'Trocar foto' : 'Buscar foto'}</button>
    </div>` : ''}
    <form id="f" class="stack" novalidate>
      <div><label for="nome">Nome</label><input id="nome" required value="${esc(p?.nome)}" autocapitalize="words"></div>
      <div><label for="marca">Marca</label><input id="marca" value="${esc(p?.marca)}" autocapitalize="words"></div>
      <div><label for="cat">Categoria</label><select id="cat">
        ${CATEGORIAS.map(([k, l]) => `<option value="${k}" ${p?.categoria === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
      <div><label for="preco">Preço (R$)</label>
        <input id="preco" inputmode="decimal" placeholder="0,00" value="${p ? centsToInput(p.preco_centavos) : ''}"></div>
      <label class="check"><input type="checkbox" id="ativo" ${!p || p.ativo ? 'checked' : ''}> Ativo (aparece para venda)</label>
      <div class="bottom-actions"><button class="btn primary" type="submit">Salvar</button>
      ${p ? `<button class="btn ${p.ativo ? 'danger' : ''}" type="button" id="toggle">${p.ativo ? 'Desativar produto' : 'Reativar produto'}</button>` : ''}</div>
    </form>`;
  document.getElementById('f').onsubmit = e => {
    e.preventDefault();
    const nome = document.getElementById('nome').value.trim();
    const marca = document.getElementById('marca').value.trim();
    const categoria = document.getElementById('cat').value;
    const preco = parseMoney(document.getElementById('preco').value);
    const ativo = document.getElementById('ativo').checked ? 1 : 0;
    if (!nome) return toast('Informe o nome');
    if (preco === null || document.getElementById('preco').value.trim() === '') return toast('Preço inválido');
    if (p) {
      run(`UPDATE produto SET nome=?, marca=?, categoria=?, preco_centavos=?, ativo=? WHERE id=?`,
          [nome, marca, categoria, preco, ativo, p.id]);
    } else {
      run(`INSERT INTO produto (nome, marca, categoria, preco_centavos, ativo) VALUES (?,?,?,?,?)`,
          [nome, marca, categoria, preco, ativo]);
      const novoId = lastId();
      persist(); toast('Produto salvo. Buscando foto…');
      return go(`#/produto/${novoId}/foto`);
    }
    persist(); toast('Produto salvo'); go('#/produtos');
  };
  const fb = document.getElementById('foto');
  if (fb) fb.onclick = () => go(`#/produto/${p.id}/foto`);
  const t = document.getElementById('toggle');
  if (t) t.onclick = () => {
    run(`UPDATE produto SET ativo = ? WHERE id = ?`, [p.ativo ? 0 : 1, p.id]);
    persist(); toast(p.ativo ? 'Produto desativado' : 'Produto reativado'); go('#/produtos');
  };
}

// 7. Histórico
const histFiltro = { de: '', ate: '', cliente: '' };
function viewHistorico() {
  setHeader('Histórico');
  if (!histFiltro.de) histFiltro.de = todayLocal();
  if (!histFiltro.ate) histFiltro.ate = todayLocal();
  $view().innerHTML = `
    <div class="stack">
      <div class="row">
        <div><label for="de">De</label><input type="date" id="de" value="${histFiltro.de}"></div>
        <div><label for="ate">Até</label><input type="date" id="ate" value="${histFiltro.ate}"></div>
      </div>
      <div><label for="cli">Cliente (nome ou telefone)</label>
        <input id="cli" type="search" value="${esc(histFiltro.cliente)}" autocomplete="off"></div>
    </div>
    <div id="res"></div>`;
  const de = document.getElementById('de'), ate = document.getElementById('ate'), cli = document.getElementById('cli');
  const upd = () => {
    Object.assign(histFiltro, { de: de.value, ate: ate.value, cliente: cli.value });
    const termo = cli.value.trim();
    const dig = onlyDigits(termo);
    const rows = all(`SELECT c.id, c.total_centavos, c.fechada_em, c.forma_pagamento, cl.nome, cl.telefone
                      FROM comanda c JOIN cliente cl ON cl.id = c.cliente_id
                      WHERE c.status = 'paga'
                        AND (? = '' OR substr(c.fechada_em,1,10) >= ?)
                        AND (? = '' OR substr(c.fechada_em,1,10) <= ?)
                        AND (? = '' OR cl.nome LIKE ? OR (? <> '' AND cl.telefone LIKE ?))
                      ORDER BY c.fechada_em DESC`,
      [de.value, de.value, ate.value, ate.value, termo, `%${termo}%`, dig, `%${dig}%`]);
    const soma = rows.reduce((s, r) => s + r.total_centavos, 0);
    const porForma = PAGAMENTOS.map(([k, l]) => [l, rows.filter(r => r.forma_pagamento === k).reduce((s, r) => s + r.total_centavos, 0)]);
    document.getElementById('res').innerHTML = `
      <div class="total-box" style="margin-top:18px"><div class="label">${rows.length} comanda${rows.length === 1 ? '' : 's'} paga${rows.length === 1 ? '' : 's'}</div>
        <div class="amount">${money(soma)}</div>
        <div class="label">${porForma.map(([l, v]) => `${l} ${money(v)}`).join(' · ')}</div></div>
      ${rows.length ? `<ul class="list">${rows.map(r => `
        <li data-id="${r.id}"><div class="main"><div class="name">${esc(r.nome)}</div>
          <div class="sub">${esc(fmtDateTime(r.fechada_em))} · ${esc(payLabel(r.forma_pagamento))}</div></div>
          <div class="value">${money(r.total_centavos)}</div></li>`).join('')}</ul>`
        : `<p class="empty">Nenhuma comanda paga nesse filtro.</p>`}`;
    document.querySelectorAll('#res li[data-id]').forEach(li => li.onclick = () => go(`#/comanda/${li.dataset.id}`));
  };
  de.onchange = ate.onchange = upd;
  cli.oninput = upd;
  upd();
}

/* ================= Fotos de produtos ================= */

// Busca imagens em fontes abertas, sem chave de API, direto do navegador.
async function buscarOpenFoodFacts(termo) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl?' + new URLSearchParams({
    search_terms: termo, search_simple: 1, action: 'process', json: 1, page_size: 24,
    fields: 'product_name,brands,quantity,image_front_url,image_front_small_url'
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('Open Food Facts ' + r.status);
  const j = await r.json();
  return (j.products || [])
    .filter(p => p.image_front_url)
    .map(p => ({
      src: p.image_front_url,
      preview: p.image_front_small_url || p.image_front_url,
      legenda: [p.brands, p.product_name, p.quantity].filter(Boolean).join(' · '),
      fonte: 'Open Food Facts'
    }));
}

async function buscarWikimedia(termo) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: `filetype:bitmap ${termo}`,
    gsrnamespace: 6, gsrlimit: 12, prop: 'imageinfo', iiprop: 'url',
    iiurlwidth: 400, format: 'json', origin: '*'
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error('Wikimedia ' + r.status);
  const j = await r.json();
  return Object.values(j.query?.pages || {})
    .filter(pg => pg.imageinfo?.[0]?.thumburl)
    .map(pg => ({
      src: pg.imageinfo[0].thumburl,
      preview: pg.imageinfo[0].thumburl,
      legenda: pg.title.replace(/^File:/, '').replace(/\.\w+$/, ''),
      fonte: 'Wikimedia'
    }));
}

async function buscarImagens(termo) {
  const res = await Promise.allSettled([buscarOpenFoodFacts(termo), buscarWikimedia(termo)]);
  res.filter(r => r.status === 'rejected').forEach(r => console.warn(r.reason));
  if (res.every(r => r.status === 'rejected')) throw new Error('sem conexão');
  const vistos = new Set();
  return res.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .filter(i => !vistos.has(i.src) && vistos.add(i.src));
}

// Reduz a imagem e guarda dentro do banco (funciona offline depois).
function imagemParaDataUrl(src, max = 320) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      try { resolve(c.toDataURL('image/jpeg', 0.82)); } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('falha ao carregar imagem'));
    img.src = src;
  });
}

function viewFoto(id) {
  const p = one(`SELECT * FROM produto WHERE id = ?`, [id]);
  if (!p) return viewNotFound();
  setHeader('Foto do produto', `#/produto/${id}`);
  let termo = [p.nome, p.marca].filter(Boolean).join(' ');
  if (p.marca && p.nome.toLowerCase().includes(p.marca.toLowerCase())) termo = p.nome;

  $view().innerHTML = `
    <div class="selected-product"><div class="name">${esc(p.nome)}</div>
      <div class="muted">${esc(p.marca)}</div></div>
    <form id="bf" class="row" style="margin-top:16px">
      <input id="termo" type="search" value="${esc(termo)}" aria-label="Termo de busca">
      <button class="btn primary" style="flex:none;width:auto" type="submit">Buscar</button>
    </form>
    <p class="muted" id="status" style="margin-top:12px"></p>
    <div class="grid" id="grid"></div>
    <div class="bottom-actions">
      <button class="btn" id="camera">Tirar ou escolher foto do celular</button>
      ${p.foto ? `<button class="btn danger" id="remover">Remover foto atual</button>` : ''}
      <button class="btn" id="pular">${p.foto ? 'Manter foto atual' : 'Pular por enquanto'}</button>
    </div>
    <input type="file" id="arq" accept="image/*" capture="environment" hidden>`;

  const status = document.getElementById('status');
  const grid = document.getElementById('grid');

  async function salvar(dataUrl) {
    run(`UPDATE produto SET foto = ? WHERE id = ?`, [dataUrl, id]);
    await persist();
    toast('Foto salva');
    go('#/produtos');
  }

  async function escolher(src) {
    status.textContent = 'Salvando foto…';
    try {
      await salvar(await imagemParaDataUrl(src));
    } catch (e) {
      // site não permite copiar a imagem: guarda o link (precisa de internet para exibir)
      console.warn(e);
      await salvar(src);
    }
  }

  async function buscar() {
    const t = document.getElementById('termo').value.trim();
    if (!t) return;
    status.textContent = 'Buscando imagens…';
    grid.innerHTML = '';
    try {
      const imgs = await buscarImagens(t);
      status.textContent = imgs.length
        ? 'Toque na foto certa para usar:'
        : 'Nada encontrado. Tente outro termo (ex.: só a marca) ou tire uma foto.';
      grid.innerHTML = imgs.map((im, i) => `
        <button class="cand" data-i="${i}" type="button">
          <img src="${esc(im.preview)}" alt="" loading="lazy" referrerpolicy="no-referrer">
          <span>${esc(im.legenda)}</span></button>`).join('');
      grid.querySelectorAll('.cand').forEach(b => {
        b.onclick = () => escolher(imgs[Number(b.dataset.i)].src);
        b.querySelector('img').onerror = () => b.remove();
      });
    } catch (e) {
      status.textContent = 'Sem internet ou busca indisponível. Você pode tirar uma foto.';
    }
  }

  document.getElementById('bf').onsubmit = e => { e.preventDefault(); buscar(); };
  const arq = document.getElementById('arq');
  document.getElementById('camera').onclick = () => arq.click();
  arq.onchange = async () => {
    const f = arq.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    try { await salvar(await imagemParaDataUrl(url)); }
    catch { toast('Não consegui ler a imagem'); }
    finally { URL.revokeObjectURL(url); }
  };
  const rm = document.getElementById('remover');
  if (rm) rm.onclick = async () => {
    run(`UPDATE produto SET foto = NULL WHERE id = ?`, [id]);
    await persist(); toast('Foto removida'); go(`#/produto/${id}`);
  };
  document.getElementById('pular').onclick = () => go('#/produtos');
  buscar();
}

function viewNotFound() {
  setHeader('Não encontrado', '#/');
  $view().innerHTML = `<p class="empty">Registro não encontrado.</p>`;
}

/* ================= Backup ================= */

function exportarBackup() {
  const blob = new Blob([db.export()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `comandas-backup-${todayLocal()}.sqlite`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importarBackup(file) {
  if (!confirm('Restaurar o backup vai SUBSTITUIR todos os dados atuais. Continuar?')) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const novo = new SQL.Database(bytes);
    novo.exec('SELECT 1 FROM produto LIMIT 1; SELECT 1 FROM comanda LIMIT 1;');
    db.close();
    db = novo;
    migrate();
    await persist();
    toast('Backup restaurado');
    route();
  } catch (e) {
    console.error(e);
    toast('Arquivo de backup inválido');
  }
}

/* ================= Roteamento ================= */

function route() {
  const h = location.hash || '#/';
  let m;
  const tab = h.startsWith('#/produto') ? '#/produtos' : h.startsWith('#/historico') ? '#/historico' : '#/';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.route === tab));
  window.scrollTo(0, 0);
  if (h === '#/' || h === '#') return viewAbertas();
  if (h === '#/nova') return viewNova();
  if ((m = h.match(/^#\/comanda\/(\d+)$/))) return viewComanda(Number(m[1]));
  if ((m = h.match(/^#\/comanda\/(\d+)\/add$/))) return viewAddItem(Number(m[1]));
  if ((m = h.match(/^#\/comanda\/(\d+)\/fechar$/))) return viewFechar(Number(m[1]));
  if (h === '#/produtos') return viewProdutos();
  if (h === '#/produto/novo') return viewProdutoForm(null);
  if ((m = h.match(/^#\/produto\/(\d+)$/))) return viewProdutoForm(Number(m[1]));
  if ((m = h.match(/^#\/produto\/(\d+)\/foto$/))) return viewFoto(Number(m[1]));
  if (h === '#/historico') return viewHistorico();
  viewNotFound();
}

/* ================= Início ================= */

let SQL;
(async function init() {
  try {
    SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
    const saved = await idbGet();
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    migrate();
    if (!saved) await persist();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    console.error(e);
    $view().innerHTML = `<p class="empty">Erro ao abrir o banco de dados.<br>${esc(e.message)}</p>`;
    return;
  }
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => go(b.dataset.route));
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
