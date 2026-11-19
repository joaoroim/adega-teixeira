'use strict';

/* ================= Banco de dados (SQLite via sql.js, salvo no IndexedDB) ================= */

let db, SQL;
const IDB_NAME = 'adega-comandas';
const IDB_STORE = 'sqlite';
const IDB_KEY = 'db-v2'; // v2: versão simplificada (começa do zero)

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbReq(mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, mode);
    const r = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = () => idbReq('readonly', s => s.get(IDB_KEY));
const idbPut = bytes => idbReq('readwrite', s => s.put(bytes, IDB_KEY));
const idbDropOld = () => idbReq('readwrite', s => s.delete('db')).catch(() => {});

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
CREATE TABLE IF NOT EXISTS venda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('comanda','direta')),
  nome TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','paga')),
  aberta_em TEXT NOT NULL,
  fechada_em TEXT,
  forma_pagamento TEXT CHECK (forma_pagamento IN ('pix','cartao','dinheiro')),
  total_centavos INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venda_id INTEGER NOT NULL REFERENCES venda(id) ON DELETE CASCADE,
  produto TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  preco_unit_centavos INTEGER NOT NULL CHECK (preco_unit_centavos >= 0),
  subtotal_centavos INTEGER NOT NULL
);
-- Produtos lembrados automaticamente a cada item lançado
CREATE TABLE IF NOT EXISTS sugestao (
  nome TEXT PRIMARY KEY COLLATE NOCASE,
  preco_centavos INTEGER NOT NULL,
  usos INTEGER NOT NULL DEFAULT 1,
  ultimo_uso TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_venda ON item(venda_id);
CREATE INDEX IF NOT EXISTS idx_venda_status ON venda(status, tipo, fechada_em);
`;

function all(sql, params = []) {
  const st = db.prepare(sql);
  st.bind(params);
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}
const one = (sql, params = []) => all(sql, params)[0];
const run = (sql, params = []) => db.run(sql, params);
const lastId = () => one('SELECT last_insert_rowid() AS id').id;

function recalcTotal(id) {
  run(`UPDATE venda SET total_centavos =
         (SELECT COALESCE(SUM(subtotal_centavos),0) FROM item WHERE venda_id = ?)
       WHERE id = ?`, [id, id]);
}

/* ================= Utilidades ================= */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = c => brl.format((c || 0) / 100);
function parseMoney(str) {
  let s = String(str).replace(/[^\d,.]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const centsToInput = c => (c / 100).toFixed(2).replace('.', ',');

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
const hora = s => (s || '').slice(11, 16);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGAMENTOS = [['pix', 'Pix'], ['cartao', 'Cartão'], ['dinheiro', 'Dinheiro']];
const PAY_ICON = { pix: 'qr_code_2', cartao: 'credit_card', dinheiro: 'payments' };
const payLabel = k => (PAGAMENTOS.find(p => p[0] === k) || [k, k])[1];
const vendaNome = v => v.tipo === 'direta' ? 'Venda direta' : v.nome;

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

/* ================= Lançar item (usado na comanda e na venda direta) ================= */

// Desenha o formulário de item. onAdd(produto, qtd, precoCentavos) grava o item.
function itemForm(container, onAdd) {
  let qtd = 1;
  container.innerHTML = `
    <div class="card stack">
      <div class="sug-wrap">
        <label for="prod">Produto</label>
        <input id="prod" autocomplete="off" autocapitalize="words" placeholder="Ex.: Brahma lata">
        <div id="sug" class="sug"></div>
      </div>
      <div class="row">
        <div><label>Quantidade</label>
          <div class="qty small">
            <button type="button" id="menos" aria-label="Diminuir">${ic('remove')}</button>
            <output id="q">1</output>
            <button type="button" id="mais" aria-label="Aumentar">${ic('add')}</button>
          </div></div>
        <div><label for="preco">Valor da unidade</label>
          <input id="preco" inputmode="decimal" placeholder="0,00"></div>
      </div>
      <button class="btn primary" id="lancar" type="button">${ic('add')} <span id="lancarTxt">Adicionar</span></button>
    </div>`;
  const prod = container.querySelector('#prod');
  const preco = container.querySelector('#preco');
  const sug = container.querySelector('#sug');
  const q = container.querySelector('#q');
  const txt = container.querySelector('#lancarTxt');

  const atualizar = () => {
    q.textContent = qtd;
    const c = parseMoney(preco.value);
    txt.textContent = c ? `Adicionar · ${money(c * qtd)}` : 'Adicionar';
  };

  function mostrarSugestoes() {
    const t = prod.value.trim();
    const rows = t
      ? all(`SELECT * FROM sugestao WHERE nome LIKE ? ORDER BY (nome LIKE ?) DESC, usos DESC LIMIT 6`, [`%${t}%`, `${t}%`])
      : all(`SELECT * FROM sugestao ORDER BY usos DESC, ultimo_uso DESC LIMIT 6`);
    const exata = rows.length === 1 && rows[0].nome.toLowerCase() === t.toLowerCase();
    sug.innerHTML = exata ? '' : rows.map(r => `
      <div class="sug-item">
        <button type="button" class="sug-pick" data-nome="${esc(r.nome)}" data-preco="${r.preco_centavos}">
          <span>${esc(r.nome)}</span><b>${money(r.preco_centavos)}</b></button>
        <button type="button" class="sug-del" data-del="${esc(r.nome)}" aria-label="Esquecer ${esc(r.nome)}">${ic('close')}</button>
      </div>`).join('');
    sug.querySelectorAll('.sug-pick').forEach(b => b.onclick = () => {
      prod.value = b.dataset.nome;
      preco.value = centsToInput(Number(b.dataset.preco));
      sug.innerHTML = '';
      atualizar();
    });
    sug.querySelectorAll('.sug-del').forEach(b => b.onclick = () => {
      if (!confirm(`Esquecer "${b.dataset.del}" das sugestões?`)) return;
      run(`DELETE FROM sugestao WHERE nome = ?`, [b.dataset.del]);
      persist(); mostrarSugestoes();
    });
  }

  prod.oninput = mostrarSugestoes;
  prod.onfocus = mostrarSugestoes;
  preco.oninput = atualizar;
  container.querySelector('#menos').onclick = () => { if (qtd > 1) { qtd--; atualizar(); } };
  container.querySelector('#mais').onclick = () => { qtd++; atualizar(); };
  container.querySelector('#lancar').onclick = () => {
    const nome = prod.value.trim().replace(/\s+/g, ' ');
    const c = parseMoney(preco.value);
    if (!nome) { toast('Digite o produto'); prod.focus(); return; }
    if (c === null) { toast('Digite o valor'); preco.focus(); return; }
    // lembra o produto e o último valor usado
    run(`INSERT INTO sugestao (nome, preco_centavos, usos, ultimo_uso) VALUES (?, ?, 1, ?)
         ON CONFLICT(nome) DO UPDATE SET preco_centavos = excluded.preco_centavos,
           usos = usos + 1, ultimo_uso = excluded.ultimo_uso`, [nome, c, nowLocal()]);
    onAdd(nome, qtd, c);
    toast(`${qtd}× ${nome} adicionado`);
  };
}

function itensHtml(itens, editavel) {
  if (!itens.length) return `<p class="empty">${ic('sports_bar', 'ic-xl')}<br>Nenhum item ainda.</p>`;
  return `<ul class="list">${itens.map(i => `
    <li class="static">
      <div class="main"><div class="name">${i.quantidade}× ${esc(i.produto)}</div>
        <div class="sub">${money(i.preco_unit_centavos)} cada</div></div>
      <div class="value">${money(i.subtotal_centavos)}</div>
      ${editavel ? `<button class="chip" data-del="${i.id}" aria-label="Remover item">${ic('delete')}</button>` : ''}
    </li>`).join('')}</ul>`;
}

function addItem(vendaId, produto, qtd, preco) {
  run(`INSERT INTO item (venda_id, produto, quantidade, preco_unit_centavos, subtotal_centavos)
       VALUES (?, ?, ?, ?, ?)`, [vendaId, produto, qtd, preco, qtd * preco]);
  recalcTotal(vendaId);
  persist();
}

function ligarRemover(vendaId, depois) {
  $view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    if (!confirm('Remover este item?')) return;
    run(`DELETE FROM item WHERE id = ? AND venda_id = ?`, [b.dataset.del, vendaId]);
    recalcTotal(vendaId); persist(); toast('Item removido'); depois();
  });
}

/* ================= Telas ================= */

// Comandas abertas
function viewComandas() {
  setHeader('Comandas');
  const rows = all(`SELECT * FROM venda WHERE tipo = 'comanda' AND status = 'aberta' ORDER BY aberta_em DESC`);
  $view().innerHTML = `
    <form id="abrir" class="row">
      <input id="nome" autocomplete="off" autocapitalize="words" placeholder="Nome ou mesa" aria-label="Nome ou mesa">
      <button class="btn primary" style="flex:none;width:auto" type="submit">${ic('add')} Abrir</button>
    </form>
    <h2>${rows.length} comanda${rows.length === 1 ? '' : 's'} aberta${rows.length === 1 ? '' : 's'}</h2>
    ${rows.length ? `<ul class="list">${rows.map(r => `
      <li data-id="${r.id}">
        <div class="main"><div class="name">${esc(r.nome)}</div>
          <div class="sub">Aberta às ${esc(hora(r.aberta_em))}</div></div>
        <div class="value">${money(r.total_centavos)}</div>
      </li>`).join('')}</ul>`
      : `<p class="empty">${ic('receipt_long', 'ic-xl')}<br>Nenhuma comanda aberta.</p>`}`;
  document.getElementById('abrir').onsubmit = e => {
    e.preventDefault();
    const nome = document.getElementById('nome').value.trim();
    if (!nome) { toast('Digite o nome'); document.getElementById('nome').focus(); return; }
    const ja = one(`SELECT id FROM venda WHERE tipo='comanda' AND status='aberta' AND nome = ? COLLATE NOCASE`, [nome]);
    if (ja && !confirm(`Já existe uma comanda aberta para "${nome}". Abrir outra mesmo assim?`)) {
      go(`#/comanda/${ja.id}`); return;
    }
    run(`INSERT INTO venda (tipo, nome, aberta_em) VALUES ('comanda', ?, ?)`, [nome, nowLocal()]);
    const id = lastId();
    persist(); toast('Comanda aberta'); go(`#/comanda/${id}`);
  };
  $view().querySelectorAll('li[data-id]').forEach(li => li.onclick = () => go(`#/comanda/${li.dataset.id}`));
}

// Detalhe da comanda (aberta: lança itens; paga: só leitura)
function viewComanda(id) {
  const v = one(`SELECT * FROM venda WHERE id = ?`, [id]);
  if (!v) return viewNotFound();
  const paga = v.status === 'paga';
  setHeader(vendaNome(v), paga ? '#/historico' : '#/');
  const itens = all(`SELECT * FROM item WHERE venda_id = ? ORDER BY id`, [id]);
  $view().innerHTML = `
    <div class="total-box">
      <div class="label">${paga ? 'Total pago' : 'Total'}</div>
      <div class="amount">${money(v.total_centavos)}</div>
      <div class="label">Aberta ${esc(fmtDateTime(v.aberta_em))}
        ${paga ? `<br>Paga ${esc(fmtDateTime(v.fechada_em))} · ${esc(payLabel(v.forma_pagamento))}` : ''}</div>
    </div>
    ${paga ? '' : `<div id="form"></div>`}
    <h2>Itens</h2>
    ${itensHtml(itens, !paga)}
    ${paga ? '' : `<div class="bottom-actions">
      <button class="btn" id="fechar" ${itens.length ? '' : 'disabled'}>${ic('check_circle')} Fechar comanda</button>
      ${itens.length ? '' : `<button class="btn danger" id="cancelar">Cancelar comanda</button>`}
    </div>`}`;
  if (paga) return;
  itemForm(document.getElementById('form'), (p, q, c) => { addItem(id, p, q, c); viewComanda(id); });
  document.getElementById('fechar').onclick = () => go(`#/pagar/${id}`);
  const cancelar = document.getElementById('cancelar');
  if (cancelar) cancelar.onclick = () => {
    if (!confirm('Cancelar esta comanda vazia?')) return;
    run(`DELETE FROM venda WHERE id = ? AND status = 'aberta'`, [id]);
    persist(); toast('Comanda cancelada'); go('#/');
  };
  ligarRemover(id, () => viewComanda(id));
}

// Venda direta: lança itens e recebe na hora
function viewVendaDireta() {
  setHeader('Venda direta');
  const v = one(`SELECT * FROM venda WHERE tipo = 'direta' AND status = 'aberta' ORDER BY id DESC LIMIT 1`);
  const itens = v ? all(`SELECT * FROM item WHERE venda_id = ? ORDER BY id`, [v.id]) : [];
  $view().innerHTML = `
    <div class="total-box"><div class="label">Total da venda</div>
      <div class="amount">${money(v?.total_centavos)}</div></div>
    <div id="form"></div>
    <h2>Itens</h2>
    ${itensHtml(itens, true)}
    <div class="bottom-actions">
      <button class="btn primary" id="receber" ${itens.length ? '' : 'disabled'}>${ic('check_circle')} Receber</button>
      ${itens.length ? `<button class="btn danger" id="limpar">Limpar venda</button>` : ''}
    </div>`;
  itemForm(document.getElementById('form'), (p, q, c) => {
    let vid = v?.id;
    if (!vid) {
      run(`INSERT INTO venda (tipo, aberta_em) VALUES ('direta', ?)`, [nowLocal()]);
      vid = lastId();
    }
    addItem(vid, p, q, c);
    viewVendaDireta();
  });
  if (!v) return;
  document.getElementById('receber').onclick = () => go(`#/pagar/${v.id}`);
  const limpar = document.getElementById('limpar');
  if (limpar) limpar.onclick = () => {
    if (!confirm('Apagar todos os itens desta venda?')) return;
    run(`DELETE FROM item WHERE venda_id = ?`, [v.id]);
    run(`DELETE FROM venda WHERE id = ?`, [v.id]);
    persist(); toast('Venda limpa'); viewVendaDireta();
  };
  ligarRemover(v.id, viewVendaDireta);
}

// Pagamento (comanda ou venda direta)
function viewPagar(id) {
  const v = one(`SELECT * FROM venda WHERE id = ?`, [id]);
  if (!v || v.status !== 'aberta') return go('#/');
  const voltar = v.tipo === 'direta' ? '#/venda' : `#/comanda/${id}`;
  setHeader(v.tipo === 'direta' ? 'Receber venda' : 'Fechar comanda', voltar);
  const itens = all(`SELECT * FROM item WHERE venda_id = ? ORDER BY id`, [id]);
  if (!itens.length) return go(voltar);
  let forma = '';
  $view().innerHTML = `
    <div class="total-box"><div class="label">${esc(vendaNome(v))} · total a pagar</div>
      <div class="amount">${money(v.total_centavos)}</div></div>
    ${itensHtml(itens, false)}
    <h2>Forma de pagamento</h2>
    <div class="pay">${PAGAMENTOS.map(([k, l]) => `<button data-pay="${k}">${ic(PAY_ICON[k], 'ic-lg')}<span>${l}</span></button>`).join('')}</div>
    <button class="btn primary" id="confirmar" disabled>${ic('check_circle')} Confirmar pagamento</button>`;
  const conf = document.getElementById('confirmar');
  $view().querySelectorAll('[data-pay]').forEach(b => b.onclick = () => {
    forma = b.dataset.pay;
    $view().querySelectorAll('[data-pay]').forEach(x => x.classList.toggle('active', x === b));
    conf.disabled = false;
  });
  conf.onclick = () => {
    if (!forma) return;
    recalcTotal(id);
    run(`UPDATE venda SET status = 'paga', fechada_em = ?, forma_pagamento = ? WHERE id = ?`, [nowLocal(), forma, id]);
    persist();
    toast('Pagamento registrado');
    go(v.tipo === 'direta' ? '#/venda' : '#/');
  };
}

// Histórico
const histFiltro = { de: '', ate: '', busca: '' };
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
      <div><label for="bus">Nome da comanda</label>
        <input id="bus" type="search" value="${esc(histFiltro.busca)}" autocomplete="off"></div>
    </div>
    <div id="res"></div>
    <h2>Backup dos dados</h2>
    <p class="muted">Os dados ficam só neste aparelho. Faça backup de vez em quando.</p>
    <button class="btn" id="exportar">${ic('download')} Baixar backup</button>
    <button class="btn" id="importar">${ic('upload')} Restaurar backup</button>
    <input type="file" id="arquivo" accept=".sqlite,.db,application/octet-stream" hidden>`;
  const de = document.getElementById('de'), ate = document.getElementById('ate'), bus = document.getElementById('bus');
  const upd = () => {
    Object.assign(histFiltro, { de: de.value, ate: ate.value, busca: bus.value });
    const t = bus.value.trim();
    const rows = all(`SELECT * FROM venda WHERE status = 'paga'
                        AND (? = '' OR substr(fechada_em,1,10) >= ?)
                        AND (? = '' OR substr(fechada_em,1,10) <= ?)
                        AND (? = '' OR (tipo = 'comanda' AND nome LIKE ?))
                      ORDER BY fechada_em DESC`,
      [de.value, de.value, ate.value, ate.value, t, `%${t}%`]);
    const soma = rows.reduce((s, r) => s + r.total_centavos, 0);
    const porForma = PAGAMENTOS.map(([k, l]) =>
      [l, rows.filter(r => r.forma_pagamento === k).reduce((s, r) => s + r.total_centavos, 0)]);
    document.getElementById('res').innerHTML = `
      <div class="total-box" style="margin-top:18px"><div class="label">${rows.length} venda${rows.length === 1 ? '' : 's'} paga${rows.length === 1 ? '' : 's'}</div>
        <div class="amount">${money(soma)}</div>
        <div class="label">${porForma.map(([l, v]) => `${l} ${money(v)}`).join(' · ')}</div></div>
      ${rows.length ? `<ul class="list">${rows.map(r => `
        <li data-id="${r.id}"><div class="main"><div class="name">${esc(vendaNome(r))}</div>
          <div class="sub">${esc(fmtDateTime(r.fechada_em))} · ${esc(payLabel(r.forma_pagamento))}</div></div>
          <div class="value">${money(r.total_centavos)}</div></li>`).join('')}</ul>`
        : `<p class="empty">${ic('history', 'ic-xl')}<br>Nenhuma venda paga nesse filtro.</p>`}`;
    document.querySelectorAll('#res li[data-id]').forEach(li => li.onclick = () => go(`#/comanda/${li.dataset.id}`));
  };
  de.onchange = ate.onchange = upd;
  bus.oninput = upd;
  upd();
  document.getElementById('exportar').onclick = exportarBackup;
  const arq = document.getElementById('arquivo');
  document.getElementById('importar').onclick = () => arq.click();
  arq.onchange = () => arq.files[0] && importarBackup(arq.files[0]);
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
    const novo = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    novo.exec('SELECT 1 FROM venda LIMIT 1; SELECT 1 FROM item LIMIT 1;');
    db.close();
    db = novo;
    db.exec(SCHEMA);
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
  const tab = h.startsWith('#/venda') ? '#/venda' : h.startsWith('#/historico') ? '#/historico' : '#/';
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.route === tab));
  window.scrollTo(0, 0);
  if (h === '#/' || h === '#') return viewComandas();
  if (h === '#/venda') return viewVendaDireta();
  if ((m = h.match(/^#\/comanda\/(\d+)$/))) return viewComanda(Number(m[1]));
  if ((m = h.match(/^#\/pagar\/(\d+)$/))) return viewPagar(Number(m[1]));
  if (h === '#/historico') return viewHistorico();
  viewNotFound();
}

/* ================= Início ================= */

(async function init() {
  try {
    SQL = await initSqlJs({ locateFile: f => `vendor/${f}` });
    const saved = await idbGet();
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.exec(SCHEMA);
    if (!saved) { await persist(); await idbDropOld(); } // começa do zero e apaga os dados da versão antiga
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) {
    console.error(e);
    $view().innerHTML = `<p class="empty">Erro ao abrir o banco de dados.<br>${esc(e.message)}</p>`;
    return;
  }
  const TAB_ICON = { '#/': 'receipt_long', '#/venda': 'point_of_sale', '#/historico': 'history' };
  document.querySelectorAll('.tabbar button').forEach(b => {
    b.innerHTML = `${ic(TAB_ICON[b.dataset.route])}<span>${b.textContent}</span>`;
    b.onclick = () => go(b.dataset.route);
  });
  document.getElementById('back').innerHTML = ic('arrow_back_ios_new');
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
