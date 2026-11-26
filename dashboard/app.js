// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the fitted board: KPI strip, protocol accounting, an integrity strip it computes from
// the rows themselves, the held-out evidence for both models, verdict controls that recompute
// every farm verdict live, a sortable board, and a detail view per protocol with the model's
// arithmetic and the costed farm plan. No network: every byte arrives in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');

  // ---- formatting ----
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unrecorded';
    if (days >= 365) return (days / 365).toFixed(1) + ' yr';
    return Math.max(0, Math.round(days)) + ' d';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
      else node.appendChild(c);
    }
    return node;
  }

  // ---- the model, restated in the page: the same arithmetic as lib/model.ts, so the integrity
  // strip can recompute every row from the shipped coefficients and compare with board.json ----
  function yearsOf(row, medYears) { return row.age_days === null || row.age_days === undefined ? medYears : row.age_days / 365.25; }
  function valueIf(row) {
    var m = DATA.model.value;
    if (!m.use_size) return m.flat * row.tvl_usd;
    var feats = { growth: row.change_7d || 0, years: yearsOf(row, m.median_years), lnChains: Math.log(Math.max(1, row.chains.length)), control: 0 };
    var z = m.beta[0] + m.beta[1] * Math.log(Math.max(1, row.tvl_usd));
    m.terms.forEach(function (t, i) { if (t !== 'lnTvl') z += (m.beta[i + 1] || 0) * feats[t]; });
    z += m.cat_effects[row.category || ''] || 0;
    return Math.exp(z);
  }
  function oddsOf(row) {
    var m = DATA.model.odds;
    var feats = { years: yearsOf(row, m.median_years), lnTvl: Math.log(Math.max(1, row.tvl_usd)), growth: row.change_7d || 0, lnChains: Math.log(Math.max(1, row.chains.length)), control: 0 };
    var order = ['years', 'lnTvl', 'growth', 'lnChains', 'control'];
    var z = (m.cat_offsets[row.category || ''] || 0) + (m.beta[0] || 0);
    var bi = 0;
    order.forEach(function (t) { if (m.terms.indexOf(t) >= 0) { bi += 1; z += (m.beta[bi] || 0) * feats[t]; } });
    var p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
    return Math.min(0.99, Math.max(0.01, p));
  }
  function impliedOf(row) { return Math.max(1, Math.round(oddsOf(row) * valueIf(row))); }

  // ---- farm economics, the model's own arithmetic at the reader's controls ----
  function econOf(row, c) {
    var deposit = Math.min(c.dep_max, Math.max(c.dep_min, Math.round(c.plan_pct * row.tvl_usd)));
    var pool = c.drop_share * oddsOf(row) * valueIf(row);
    var share = deposit / (deposit + c.participation * row.tvl_usd);
    var drop = pool * share;
    var weeklyTxs = 1 + 0.25 * Math.min(3, Math.max(0, row.chains.length - 1));
    var gasFees = (3 + c.horizon_wk * weeklyTxs) * row.gas_tx;
    var swap = c.swap_pct * deposit;
    var capital = deposit * c.funding_apr * (c.horizon_wk / 52);
    var fees = gasFees + swap + capital;
    var hours = 1 + c.horizon_wk * 0.5 + 0.75;
    var net = drop - fees;
    var perHour = net / hours;
    var verdict = net <= 0 ? 'SKIP' : net >= c.bar_net && perHour >= c.bar_hour ? 'FARM' : 'MARGINAL';
    return { deposit: deposit, drop: drop, fees: fees, gasFees: gasFees, swap: swap, capital: capital, net: net, perHour: perHour, hours: hours, verdict: verdict };
  }

  // ---- integrity: recomputed here, from the rows, every load ----
  function fnv(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }
  function integrity() {
    var rows = DATA.rows;
    var recomputed = 0;
    rows.forEach(function (r) { if (impliedOf(r) === r.implied_value_usd) recomputed += 1; });
    var ordered = true;
    for (var i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) ordered = false;
    var ranksOk = rows.every(function (r, i) { return r.rank === i + 1; });
    var totalImplied = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var totalTvl = rows.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    var checksum = fnv(rows.map(function (r) { return r.slug + ':' + r.rank + ':' + r.implied_value_usd; }).join('|'));
    var watch = rows.filter(function (r) { return r.watchlist; }).length;
    var ledger = DATA.accounting.reduce(function (s, g) { return s + g.count; }, 0);
    return [
      { ok: recomputed === rows.length, text: 'this table = board.json: ' + recomputed + ' of ' + rows.length + ' rows recomputed here' },
      { ok: ordered && ranksOk, text: 'ranks 1–' + rows.length + ' in order, values never rise' },
      { ok: totalImplied === DATA.integrity.total_implied_usd, text: 'totals equal: ' + fmtFull(totalImplied) + ' implied · ' + fmtFull(totalTvl) + ' TVL' },
      { ok: checksum === DATA.integrity.checksum, text: 'checksum ' + checksum + ' = the board model.ts wrote' },
      { ok: watch === DATA.watchlist_size, text: 'watchlist ' + watch + ' of ' + DATA.watchlist_size + ' ranked' },
      { ok: ledger === DATA.accounting_total, text: 'ledger ' + ledger + ' of ' + DATA.accounting_total + ' protocols' },
    ];
  }

  // ---- state ----
  var P = DATA.farm_params;
  var state = {
    view: 'board', verdict: 'all', tier: 'all', q: '', category: 'all', chain: 'all',
    sort: 'rank', dir: 1, selected: null,
    plan_pct: P.plan_pct, drop_share: P.drop_share, horizon_wk: P.horizon_wk,
  };
  function controls() {
    return { plan_pct: state.plan_pct, dep_min: P.dep_min, dep_max: P.dep_max, drop_share: state.drop_share,
      horizon_wk: state.horizon_wk, participation: P.participation, funding_apr: P.funding_apr,
      swap_pct: P.swap_pct, bar_net: P.bar_net, bar_hour: P.bar_hour };
  }

  // ---- static cover sections ----
  function kpiCard(label, big, sub) {
    return el('div', { 'class': 'kpi' },
      el('div', { 'class': 'k-label', text: label }),
      el('div', { 'class': 'k-big', html: big }),
      el('div', { 'class': 'k-sub', text: sub }));
  }
  function cover() {
    var k = DATA.kpi;
    var head = el('header', { 'class': 'top' },
      el('div', null,
        el('h1', { html: '<span class="dot">◉</span> Launch Radar' }),
        el('div', { 'class': 'sub', text: 'pre-token protocols, valued from their own record' })),
      el('div', { 'class': 'meta', html: 'DefiLlama snapshot <b>' + DATA.as_of + '</b> · model <b>' + DATA.model_version + '</b><br>fitted on this snapshot, in this browser' }));
    var kpis = el('div', { 'class': 'kpis' },
      kpiCard('Out-of-sample miss, walk-forward', '×' + k.wf_miss + ' <span class="vs">vs ×' + k.flat_miss + '</span>', 'a flat cap/TVL multiple misses by more'),
      kpiCard('Is the printed range honest?', k.honesty50 + '% · ' + k.honesty80 + '%', 'of real caps inside P25–P75 · P10–P90'),
      kpiCard('Token odds Brier vs base rate', String(k.brier) + ' <span class="vs">vs ' + k.base_brier + '</span>', 'walk-forward ' + k.wf_brier + ' · ' + k.called_right + '% called right'),
      kpiCard('Terms kept after both tests', k.terms_value + ' · ' + k.terms_odds, 'value · odds; the rest shown, not used'),
      kpiCard('Worth farming, this scenario', k.farm_count + ' <span class="vs">of ' + k.board_size + '</span>', 'net ≥ $' + P.bar_net + ' and $' + P.bar_hour + '/h; ' + k.marginal_count + ' marginal, ' + k.skip_count + ' skip'),
      kpiCard('Watchlist ranked', k.watchlist_size + ' / ' + k.watchlist_size, 'plus ' + (k.board_size - k.watchlist_size) + ' more pre-token protocols'));
    var formula = el('div', { 'class': 'formula', html: '<b>Implied value</b> = ' + DATA.formula_line.split('. ').slice(1).join('. ') });
    var total = DATA.accounting_total;
    var bar = el('div', { 'class': 'bar' }, DATA.accounting.map(function (g) {
      return el('div', { style: 'width:' + (100 * g.count / total) + '%;background:' + g.color, title: g.label + ': ' + g.count });
    }));
    var legend = el('div', { 'class': 'legend' }, DATA.accounting.map(function (g) {
      return el('span', null, el('span', { 'class': 'sw', style: 'background:' + g.color }), g.label + ' ', el('b', { text: String(g.count) }));
    }));
    var acct = el('section', { 'class': 'panel' },
      el('div', { 'class': 'p-head' },
        el('span', { 'class': 'p-title', text: 'PROTOCOL ACCOUNTING' }),
        el('span', { 'class': 'p-note', text: 'all ' + total + ' snapshot protocols in exactly one group' })),
      el('div', { 'class': 'acct' }, bar, legend));
    var pills = el('div', { 'class': 'integrity' }, integrity().map(function (p) {
      return el('span', { 'class': 'pill' + (p.ok ? '' : ' bad'), text: (p.ok ? '✓ ' : '✗ ') + p.text });
    }));
    return [head, kpis, formula, acct, pills];
  }

  function stampCell(s) {
    var cls = s === 'kept' ? 'kept' : s === 'baseline' ? 'base' : s === 'must not help' ? 'must' : 'not';
    var txt = s === 'kept' ? 'KEPT' : s === 'baseline' ? 'baseline' : s === 'must not help' ? 'MUST NOT HELP' : 'TESTED, NOT KEPT';
    return el('td', null, el('span', { 'class': 'stamp ' + cls, text: txt }));
  }
  function evidence() {
    var ev = DATA.evidence;
    function ladderTable(title, sub, terms, colA, colB, withAcc) {
      var rows = terms.map(function (t) {
        var cells = [el('td', { text: t.label }), el('td', { text: String(t.test_a) }), el('td', { text: String(t.test_b) })];
        if (withAcc) cells.splice(2, 0, el('td', { text: t.acc + '%' }));
        cells.push(stampCell(t.stamp));
        return el('tr', null, cells);
      });
      var heads = [el('th', { text: 'TERM, ADDED IN ORDER' }), el('th', { text: colA }), el('th', { text: colB })];
      if (withAcc) heads.splice(2, 0, el('th', { text: 'CALLED RIGHT' }));
      heads.push(el('th', { text: '' }));
      return el('div', { 'class': 'ev' },
        el('h3', null, title + ' ', el('span', { text: sub })),
        el('table', { 'class': 'mini' }, el('thead', null, el('tr', null, heads)), el('tbody', null, rows)));
    }
    var honRows = ev.honesty.map(function (h) {
      return el('tr', null,
        el('td', { text: h.label + (h.stated !== '—' ? ' · stated ' + h.stated : '') }),
        el('td', { text: h.loo + '%' }), el('td', { text: h.wf + '%' }));
    });
    function coefText(list) {
      function f(v) { return String(Math.round(v * 1000) / 1000); }
      return list.map(function (c) { return c.label + ' <b>' + f(c.est) + ' ± ' + f(c.se) + '</b>'; }).join('; ');
    }
    var hon = el('div', { 'class': 'ev' },
      el('h3', null, 'Is the printed range honest? ', el('span', { text: 'share of real caps inside it' })),
      el('table', { 'class': 'mini' },
        el('thead', null, el('tr', null, el('th', { text: 'RANGE' }), el('th', { text: 'LEAVE-ONE-OUT' }), el('th', { text: 'WALK-FORWARD' }))),
        el('tbody', null, honRows)),
      el('div', { 'class': 'coefs', html: 'Coefficients ± bootstrap s.e. Value: ' + coefText(ev.value_coefs) + '.<br>Odds, in logits: ' + coefText(ev.odds_coefs) + '.' }));
    var panel = el('section', { 'class': 'panel' },
      el('div', { 'class': 'p-head' },
        el('span', { 'class': 'p-title', text: 'OUT-OF-SAMPLE EVIDENCE' }),
        el('span', { 'class': 'p-note', text: 'a term is kept only if it lowers the held-out miss in both tests' })),
      el('div', { 'class': 'evidence' },
        ladderTable('Value if a token launches', '· typical miss, ' + ev.fit_n + ' traded tokens', ev.value_terms, 'LEAVE-ONE-OUT', 'WALK-FORWARD', false),
        ladderTable('Token odds', '· Brier score, ' + ev.peers_n + ' peers', ev.odds_terms, 'TEN-FOLD', 'WALK-FORWARD', true),
        hon),
      el('div', { 'class': 'reading', html: '<b>Reading it:</b> ' + ev.reading.replace(/^Reading it: /, '') }));
    return panel;
  }

  // ---- controls + board ----
  var root = el('div');
  function econCache() {
    var c = controls();
    var map = {};
    DATA.rows.forEach(function (r) { map[r.slug] = econOf(r, c); });
    return map;
  }
  function visibleRows(econ) {
    var rows = DATA.rows.filter(function (r) {
      var e = econ[r.slug];
      if (state.verdict !== 'all' && e.verdict !== state.verdict) return false;
      if (state.tier !== 'all' && r.tier !== state.tier) return false;
      if (state.category !== 'all' && (r.category || '') !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        var hay = (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ') + ' ' + r.slug).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      var va, vb;
      if (key === 'rank') { va = a.rank; vb = b.rank; }
      else if (key === 'net') { va = econ[a.slug].net; vb = econ[b.slug].net; }
      else if (key === 'perhour') { va = econ[a.slug].perHour; vb = econ[b.slug].perHour; }
      else if (key === 'verdict') { va = econ[a.slug].net; vb = econ[b.slug].net; }
      else { va = a[key]; vb = b[key]; }
      return (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
    });
    return rows;
  }

  function tabBtn(label, count, active, cls, onclick) {
    return el('button', { 'class': (cls || '') + (active ? ' on' : ''), onclick: onclick },
      label + ' ', el('span', { 'class': 'n', text: String(count) }));
  }
  function renderControls(econ) {
    var counts = { FARM: 0, MARGINAL: 0, SKIP: 0 };
    DATA.rows.forEach(function (r) { counts[econ[r.slug].verdict] += 1; });
    var tiers = { watchlist: 0, early: 0, 'off-list': 0 };
    DATA.rows.forEach(function (r) { tiers[r.tier] += 1; });
    var verdictTabs = el('div', { 'class': 'tabs' },
      tabBtn('All', DATA.rows.length, state.verdict === 'all', '', function () { state.verdict = 'all'; renderDynamic(); }),
      tabBtn('Farm', counts.FARM, state.verdict === 'FARM', 'v-farm', function () { state.verdict = 'FARM'; renderDynamic(); }),
      tabBtn('Marginal', counts.MARGINAL, state.verdict === 'MARGINAL', 'v-marginal', function () { state.verdict = 'MARGINAL'; renderDynamic(); }),
      tabBtn('Skip', counts.SKIP, state.verdict === 'SKIP', 'v-skip', function () { state.verdict = 'SKIP'; renderDynamic(); }));
    var tierTabs = el('div', { 'class': 'tabs' },
      tabBtn('All tiers', DATA.rows.length, state.tier === 'all', '', function () { state.tier = 'all'; renderDynamic(); }),
      tabBtn('Watchlist', tiers.watchlist, state.tier === 'watchlist', '', function () { state.tier = 'watchlist'; renderDynamic(); }),
      tabBtn('Early (< ' + fmtUsd(DATA.floor_usd) + ')', tiers.early, state.tier === 'early', '', function () { state.tier = 'early'; renderDynamic(); }),
      tabBtn('Off-list', tiers['off-list'], state.tier === 'off-list', '', function () { state.tier = 'off-list'; renderDynamic(); }));
    var planSel = el('select', { onchange: function (ev) { state.plan_pct = parseFloat(ev.target.value); renderDynamic(); } },
      [0.0001, 0.0002, 0.0005].map(function (v) {
        var o = el('option', { value: String(v), text: 'plan ' + (v * 100).toFixed(2) + '% of TVL' });
        if (v === state.plan_pct) o.setAttribute('selected', '');
        return o;
      }));
    var dropSlider = el('input', { type: 'range', min: '1', max: '15', step: '0.5', value: String(state.drop_share * 100),
      oninput: function (ev) { state.drop_share = parseFloat(ev.target.value) / 100; ev.target.nextSibling.textContent = (state.drop_share * 100).toFixed(1) + '%'; renderTable(); },
      onchange: function () { renderDynamic(); } });
    var horSlider = el('input', { type: 'range', min: '4', max: '26', step: '1', value: String(state.horizon_wk),
      oninput: function (ev) { state.horizon_wk = parseInt(ev.target.value, 10); ev.target.nextSibling.textContent = state.horizon_wk + ' wk'; renderTable(); },
      onchange: function () { renderDynamic(); } });
    var search = el('input', { type: 'search', placeholder: 'Search…', value: state.q,
      oninput: function (ev) { state.q = ev.target.value; renderTable(); } });
    var cats = ['all'].concat(Array.from(new Set(DATA.rows.map(function (r) { return r.category || ''; }))).sort());
    var catSel = el('select', { onchange: function (ev) { state.category = ev.target.value; renderTable(); } },
      cats.map(function (c) {
        var o = el('option', { value: c, text: c === 'all' ? 'All categories' : (c || '(no category)') });
        if (c === state.category) o.setAttribute('selected', '');
        return o;
      }));
    var chains = ['all'].concat(Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains; }))).sort());
    var chainSel = el('select', { onchange: function (ev) { state.chain = ev.target.value; renderTable(); } },
      chains.map(function (c) {
        var o = el('option', { value: c, text: c === 'all' ? 'All chains' : c });
        if (c === state.chain) o.setAttribute('selected', '');
        return o;
      }));
    var vis = visibleRows(econ);
    var sumTvl = vis.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    var sumImp = vis.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    return el('div', null,
      el('div', { 'class': 'controls' },
        verdictTabs, tierTabs,
        el('label', { 'class': 'ctl' }, 'Deposit ', planSel),
        el('label', { 'class': 'ctl' }, 'Drop share ', dropSlider, el('span', { 'class': 'val', text: (state.drop_share * 100).toFixed(1) + '%' })),
        el('label', { 'class': 'ctl' }, 'Horizon ', horSlider, el('span', { 'class': 'val', text: state.horizon_wk + ' wk' }))),
      el('div', { 'class': 'controls' },
        el('label', { 'class': 'ctl' }, search),
        el('label', { 'class': 'ctl' }, catSel),
        el('label', { 'class': 'ctl' }, chainSel),
        el('button', { 'class': 'btn', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; renderDynamic(); } }, 'Reset'),
        el('button', { 'class': 'btn', onclick: function () { exportRows('csv', econ); } }, 'CSV'),
        el('button', { 'class': 'btn', onclick: function () { exportRows('json', econ); } }, 'JSON'),
        el('button', { 'class': 'btn', onclick: function () { state.view = state.view === 'board' ? 'live' : 'board'; renderDynamic(); } }, state.view === 'board' ? 'Live tokens' : 'Back to board'),
        el('span', { 'class': 'spacer' }),
        el('span', { 'class': 'summary', text: vis.length + ' of ' + DATA.rows.length + ' rows · ' + fmtUsd(sumTvl) + ' TVL · ' + fmtUsd(sumImp) + ' implied' })));
  }

  function exportRows(kind, econ) {
    var rows = visibleRows(econ).map(function (r) {
      var e = econ[r.slug];
      return { rank: r.rank, protocol: r.name, category: r.category, tvl_usd: r.tvl_usd, token_odds: r.odds,
        value_if_launches_usd: r.value_if_usd, implied_value_usd: r.implied_value_usd, verdict: e.verdict, net_usd: Math.round(e.net * 100) / 100 };
    });
    var text, name, type;
    if (kind === 'csv') {
      var keys = Object.keys(rows[0] || {});
      text = keys.join(',') + '\n' + rows.map(function (r) { return keys.map(function (k) { return JSON.stringify(r[k] === null ? '' : r[k]); }).join(','); }).join('\n');
      name = 'launch-radar.csv'; type = 'text/csv';
    } else { text = JSON.stringify(rows, null, 1); name = 'launch-radar.json'; type = 'application/json'; }
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type })), download: name });
    document.body.appendChild(a); a.click(); a.remove();
  }

  function sortHead(label, key, cls) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return el('th', { 'class': cls || '', onclick: function () {
      if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'rank' ? 1 : -1; }
      renderTable();
    } }, label + arrow);
  }
  function boardTable(econ) {
    var rows = visibleRows(econ);
    var body = rows.map(function (r) {
      var e = econ[r.slug];
      var tierChip = r.tier === 'watchlist' ? el('span', { 'class': 'chip watch', text: 'Watchlist' })
        : r.tier === 'off-list' ? el('span', { 'class': 'chip off', text: 'Off-List' }) : null;
      return el('tr', { 'class': state.selected === r.slug ? 'sel' : '', onclick: function () {
          state.selected = state.selected === r.slug ? null : r.slug; renderTable();
        } },
        el('td', { 'class': 'rank', text: String(r.rank) }),
        el('td', { 'class': 'range', text: r.rank_lo + '–' + r.rank_hi }),
        el('td', { 'class': 'proto' },
          el('span', { 'class': 'nm', text: r.name }), tierChip,
          el('div', { 'class': 'meta2', text: (r.category || 'Uncategorised') + ' · ' + (r.chains.slice(0, 3).join(', ') || '—') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') })),
        el('td', { 'class': 'r num', text: fmtUsd(r.tvl_usd) }),
        el('td', { 'class': 'r num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { 'class': 'r', text: fmtAge(r.age_days) }),
        el('td', { 'class': 'r' },
          el('span', { 'class': 'oddsbar' }, el('i', { style: 'width:' + Math.round(r.odds * 100) + '%' })),
          el('span', { 'class': 'num', text: Math.round(r.odds * 100) + '%' })),
        el('td', { 'class': 'r num', text: fmtUsd(r.value_if_usd) }),
        el('td', { 'class': 'r' },
          el('span', { 'class': 'num', text: fmtUsd(r.implied_value_usd) }),
          el('div', { 'class': 'sub2', text: fmtUsd(r.p25_usd) + '–' + fmtUsd(r.p75_usd) })),
        el('td', { 'class': 'verd' },
          el('span', { 'class': 'verdict ' + e.verdict, text: e.verdict + ' $' + Math.round(e.net) }),
          el('span', { 'class': 'sub2', text: fmtUsd(e.drop) + ' drop − ' + fmtUsd(e.fees) + ' fees' })),
        el('td', { 'class': 'r num', text: '$' + e.perHour.toFixed(2) }));
    });
    return el('table', { 'class': 'board' },
      el('thead', null, el('tr', null,
        sortHead('#', 'rank'), el('th', { text: 'RANGE' }),
        el('th', { text: 'PROTOCOL' }),
        sortHead('TVL', 'tvl_usd', 'r'), sortHead('7D', 'change_7d', 'r'),
        el('th', { 'class': 'r', text: 'NO-TOKEN AGE' }),
        sortHead('TOKEN ODDS', 'odds', 'r'), sortHead('IF IT LAUNCHES', 'value_if_usd', 'r'),
        sortHead('IMPLIED VALUE', 'implied_value_usd', 'r'),
        sortHead('VERDICT · NET OF FEES', 'verdict'), sortHead('NET / HOUR', 'perhour', 'r'))),
      el('tbody', null, body));
  }

  function detail(econ) {
    var r = DATA.rows.filter(function (x) { return x.slug === state.selected; })[0];
    if (!r) return null;
    var e = econ[r.slug];
    var vif = valueIf(r), od = oddsOf(r);
    function line(a, b, total) { return el('div', { 'class': 'line' + (total ? ' total' : '') }, el('span', { text: a }), el('span', { text: b })); }
    var left = el('div', { 'class': 'd-col' },
      el('h4', { text: 'THE MODEL, STEP BY STEP' }),
      line('TVL (snapshot)', fmtFull(r.tvl_usd)),
      line('Fitted value if it launches', fmtFull(r.value_if_usd)),
      line('  its bootstrap range (P25–P75)', fmtFull(r.vif25_usd) + ' – ' + fmtFull(r.vif75_usd)),
      line('Token odds (peers’ record)', Math.round(od * 100) + '%'),
      line('Implied value = odds × value', fmtFull(r.implied_value_usd)),
      line('  printed range (P25–P75)', fmtFull(r.p25_usd) + ' – ' + fmtFull(r.p75_usd)),
      line('Rank, with bootstrap range', '#' + r.rank + ' (' + r.rank_lo + '–' + r.rank_hi + ')'),
      line('Recomputed in this browser', fmtFull(Math.max(1, Math.round(od * vif))) + (impliedOf(r) === r.implied_value_usd ? ' — agrees' : ' — differs')),
      el('div', { 'class': 'why', html: 'Verdict <b>' + e.verdict + '</b>: the plan is expected to return <b>' + fmtUsd(e.drop) + '</b> of a launch’s farmer share against <b>' + fmtUsd(e.fees) + '</b> of costs over ' + state.horizon_wk + ' weeks — <b>' + fmtUsd(e.net) + ' net</b>, about <b>$' + e.perHour.toFixed(2) + ' an hour</b> for ' + e.hours.toFixed(1) + ' hours of work. FARM needs $' + P.bar_net + ' net and $' + P.bar_hour + ' an hour at the default controls.' }));
    var right = el('div', { 'class': 'd-col' },
      el('h4', { text: 'BUDGET AND FARM PLAN' }),
      line('Deposit (plan size × TVL)', fmtFull(e.deposit)),
      line('Expected drop', fmtFull(e.drop)),
      line('Gas and transaction fees', '−' + fmtFull(e.gasFees)),
      line('Swap costs', '−' + fmtFull(e.swap)),
      line('Capital charge (' + (P.funding_apr * 100) + '% APR)', '−' + fmtFull(e.capital)),
      line('Net', fmtFull(e.net), true),
      el('ol', { 'class': 'steps' }, r.farm_steps.map(function (s) { return el('li', { text: s }); })));
    return el('section', { 'class': 'panel detail' },
      el('div', { 'class': 'd-head' },
        el('h2', null, r.name + ' ', el('span', { 'class': 'chip ' + (r.tier === 'watchlist' ? 'watch' : 'off'), text: r.tier === 'watchlist' ? 'Watchlist' : r.tier === 'off-list' ? 'Off-List' : 'Early' })),
        el('button', { 'class': 'close', onclick: function () { state.selected = null; renderTable(); } }, '✕')),
      el('div', { 'class': 'd-grid' }, left, right));
  }

  function liveTable() {
    var body = DATA.live.map(function (r) {
      return el('tr', null,
        el('td', { 'class': 'proto' }, el('span', { 'class': 'nm', text: r.name }),
          el('div', { 'class': 'meta2', text: (r.category || 'Uncategorised') + ' · ' + r.chains.slice(0, 3).join(', ') })),
        el('td', { 'class': 'r num', text: fmtUsd(r.tvl_usd) }),
        el('td', { 'class': 'r num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { 'class': 'r num', text: fmtUsd(r.mcap_usd) }));
    });
    return el('table', { 'class': 'board' },
      el('thead', null, el('tr', null, el('th', { text: 'LIVE TOKEN — ALREADY TRADES' }), el('th', { 'class': 'r', text: 'TVL' }), el('th', { 'class': 'r', text: '7D' }), el('th', { 'class': 'r', text: 'MARKET CAP' }))),
      el('tbody', null, body));
  }

  var tableHost = el('div');
  var detailHost = el('div');
  function renderDynamic() {
    var econ = econCache();
    root.replaceChildren.apply(root, [renderControls(econ)]);
    renderTable();
  }
  function renderTable() {
    var econ = econCache();
    tableHost.replaceChildren.apply(tableHost, [state.view === 'board' ? boardTable(econ) : liveTable()]);
    detailHost.replaceChildren.apply(detailHost, state.view === 'board' && state.selected ? [detail(econ)] : []);
  }
  function render() {
    var parts = cover();
    parts.push(evidence());
    parts.push(root);
    parts.push(tableHost);
    parts.push(detailHost);
    parts.push(el('footer', { 'class': 'note', text: 'Implied value is this entry’s own fitted claim from the sealed snapshot’s figures — odds × value if it launches — never a prediction that a token will launch. Farm verdicts are scenarios at the stated controls, not advice.' }));
    app.replaceChildren.apply(app, parts);
    renderDynamic();
  }
  render();
})();
