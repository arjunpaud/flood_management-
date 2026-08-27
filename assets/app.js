/* रसुवा–भोटेकोशी बाढी · लाइभ बुलेटिन (क्लोन)
 *
 * Every number and headline on the page is fetched at runtime from the
 * external sources listed in the स्रोत section. Nothing is hard-coded.
 *
 *   BIPAD Portal (NDRRMA)  →  incidents, river gauges, active alerts   [CORS open]
 *   News RSS               →  ratopati / onlinekhabar / nagarik / …    [via proxy]
 *   data/live.json         →  optional pre-baked output of scripts/fetch-sources.mjs
 */
(function () {
  'use strict';

  var CFG = {
    refreshMs: 5 * 60 * 1000,
    incidentDays: 21,
    incidentLimit: 400,
    riverLimit: 400,
    alertLimit: 120,
    newsPerFeed: 10,
    fetchTimeout: 20000,
    proxyTimeout: 9000,
    originalSite: 'https://nirajbhusal.github.io/rasuwa-flood-bulletin/',
    bipad: 'https://bipadportal.gov.np/api/v1/'
  };

  /* Hazards that belong on a flood bulletin, BIPAD hazard id → Nepali label. */
  var WATER_HAZARDS = {
    11: 'बाढी', 17: 'पहिरो', 28: 'डुबान', 26: 'हिमताल विस्फोटन',
    3: 'हिमपहिरो', 14: 'भारी वर्षा', 5: 'पुल भत्किनु', 7: 'डुबेर मृत्यु'
  };

  /* Districts along the भोटेकोशी–त्रिशूली–नारायणी corridor. */
  var FOCUS_DISTRICTS = [
    'रसुवा', 'नुवाकोट', 'धादिङ', 'धादिंग', 'चितवन', 'गोरखा', 'तनहुँ',
    'मकवानपुर', 'सिन्धुपाल्चोक', 'नवलपरासी', 'काठमाडौं'
  ];

  /* Gauges on the affected corridor, matched against the DHM station name. */
  var RIVER_PATTERNS = [
    /trishuli/i, /narayani/i, /bhote\s*koshi/i, /tadi/i, /betrawati/i,
    /devghat/i, /east rapti/i, /manahari/i, /lothar/i, /budhi gandaki/i
  ];

  var state = {
    feeds: null, sources: [], contacts: [], helpline: [],
    incidents: [], rivers: [], alerts: [], news: [],
    incidentTab: 'focus', newsTab: 'all', srcTab: 0,
    map: null, layer: null, health: {}
  };

  /* ── small helpers ─────────────────────────────────────── */

  var NE_DIGITS = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];

  function toNe(v) {
    return String(v).replace(/[0-9]/g, function (d) { return NE_DIGITS[+d]; });
  }

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function timeout(ms) {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store', signal: timeout(CFG.fetchTimeout) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + url);
        return r.json();
      });
  }

  function getText(url, ms) {
    return fetch(url, { cache: 'no-store', signal: timeout(ms || CFG.fetchTimeout) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + ' ' + url);
        return r.text();
      });
  }

  function asArray(v) { return Array.isArray(v) ? v : (v ? [v] : []); }

  function daysAgoISO(days) {
    var d = new Date(Date.now() - days * 864e5);
    return d.toISOString().slice(0, 10);
  }

  /* "२ घण्टा अघि" — relative time in Nepali. */
  function ago(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'भर्खरै';
    if (s < 3600) return toNe(Math.round(s / 60)) + ' मिनेट अघि';
    if (s < 86400) return toNe(Math.round(s / 3600)) + ' घण्टा अघि';
    return toNe(Math.round(s / 86400)) + ' दिन अघि';
  }

  function clock(d) {
    var p = function (n) { return toNe(n < 10 ? '0' + n : n); };
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* BIPAD titleNe reads "प्रदेश, जिल्ला, पालिका-वडा मा …" */
  function districtOf(rec) {
    var t = rec.titleNe || '';
    var parts = t.split(',');
    if (parts.length >= 2) return parts[1].trim();
    return '';
  }

  function health(key, label, status) {
    state.health[key] = { label: label, status: status };
    renderHealth();
  }

  function renderHealth() {
    var box = $('health');
    clear(box);
    Object.keys(state.health).forEach(function (k) {
      var h = state.health[k];
      box.appendChild(el('span', h.status, h.label));
    });
  }

  /* ── BIPAD: incidents ──────────────────────────────────── */

  function loadIncidents() {
    health('bipad', 'BIPAD घटना', 'wait');
    var url = CFG.bipad + 'incident/?limit=' + CFG.incidentLimit +
      '&ordering=-incident_on&incident_on__gt=' + daysAgoISO(CFG.incidentDays);

    return getJSON(url).then(function (data) {
      var rows = asArray(data.results).filter(function (r) {
        return WATER_HAZARDS[r.hazard];
      });
      state.incidents = rows;
      health('bipad', 'BIPAD घटना · ' + toNe(rows.length), 'ok');
      renderIncidents();
      renderMap();
    }).catch(function (e) {
      health('bipad', 'BIPAD घटना असफल', 'fail');
      $('live-list').innerHTML = '';
      $('live-list').appendChild(el('div', 'empty',
        'BIPAD पोर्टलसँग जोडिन सकिएन (' + e.message + ')। पुनः ताजा गर्नुहोस्।'));
    });
  }

  function incidentDistricts() {
    var seen = {};
    state.incidents.forEach(function (r) {
      var d = districtOf(r);
      if (d) seen[d] = (seen[d] || 0) + 1;
    });
    return Object.keys(seen).sort(function (a, b) {
      var fa = FOCUS_DISTRICTS.indexOf(a), fb = FOCUS_DISTRICTS.indexOf(b);
      if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb);
      return seen[b] - seen[a];
    }).map(function (d) { return { name: d, n: seen[d] }; });
  }

  function visibleIncidents() {
    if (state.incidentTab === 'all') return state.incidents;
    if (state.incidentTab === 'focus') {
      return state.incidents.filter(function (r) {
        return FOCUS_DISTRICTS.indexOf(districtOf(r)) >= 0;
      });
    }
    return state.incidents.filter(function (r) {
      return districtOf(r) === state.incidentTab;
    });
  }

  function renderIncidents() {
    /* stat strip — counts, straight off the API */
    var byHazard = {};
    state.incidents.forEach(function (r) {
      var k = WATER_HAZARDS[r.hazard];
      byHazard[k] = (byHazard[k] || 0) + 1;
    });
    var dists = incidentDistricts();
    var focusCount = state.incidents.filter(function (r) {
      return FOCUS_DISTRICTS.indexOf(districtOf(r)) >= 0;
    }).length;

    var stats = $('live-stats');
    clear(stats);
    function stat(n, label) {
      var s = el('div', 'stat');
      s.appendChild(el('b', null, toNe(n)));
      s.appendChild(el('small', null, label));
      stats.appendChild(s);
    }
    stat(state.incidents.length, 'दर्ता घटना · पछिल्ला ' + toNe(CFG.incidentDays) + ' दिन');
    stat(byHazard['बाढी'] || 0, 'बाढी');
    stat(byHazard['पहिरो'] || 0, 'पहिरो');
    stat(focusCount, 'प्रभावित करिडोरका जिल्लामा');
    stat(dists.length, 'जिल्ला');

    /* tabs */
    var tabs = $('live-tabs');
    clear(tabs);
    var opts = [{ k: 'focus', t: 'करिडोर जिल्ला (' + toNe(focusCount) + ')' },
                { k: 'all', t: 'सबै (' + toNe(state.incidents.length) + ')' }];
    dists.slice(0, 10).forEach(function (d) {
      opts.push({ k: d.name, t: d.name + ' (' + toNe(d.n) + ')' });
    });
    opts.forEach(function (o) {
      var b = el('button', state.incidentTab === o.k ? 'active' : '', o.t);
      b.type = 'button';
      b.onclick = function () { state.incidentTab = o.k; renderIncidents(); renderMap(); };
      tabs.appendChild(b);
    });

    /* list */
    var rows = visibleIncidents();
    $('live-count').textContent = toNe(rows.length) + ' घटना';
    var list = $('live-list');
    clear(list);
    if (!rows.length) {
      list.appendChild(el('div', 'empty', 'यो छनोटमा दर्ता भएको घटना छैन।'));
      return;
    }
    rows.slice(0, 60).forEach(function (r) {
      var c = el('div', 'card');
      var h = el('h3');
      var tag = el('span', 'tag hazard', WATER_HAZARDS[r.hazard]);
      h.appendChild(tag);
      h.appendChild(document.createTextNode(r.titleNe || r.title || '—'));
      c.appendChild(h);
      var p = el('p');
      var when = r.incidentOn || r.reportedOn || r.createdOn;
      p.appendChild(el('time', null,
        new Date(when).toLocaleDateString('ne-NP') + ' · ' + ago(r.reportedOn || when)));
      if (r.verified) p.appendChild(document.createTextNode(' · प्रमाणित'));
      if (r.streetAddress) p.appendChild(document.createTextNode(' · ' + r.streetAddress));
      c.appendChild(p);
      list.appendChild(c);
    });
    if (rows.length > 60) {
      list.appendChild(el('div', 'empty',
        'थप ' + toNe(rows.length - 60) + ' घटना BIPAD पोर्टलमा हेर्नुहोस्।'));
    }
  }

  /* ── BIPAD: river gauges ───────────────────────────────── */

  function loadRivers() {
    health('river', 'नदी जलसतह', 'wait');
    return getJSON(CFG.bipad + 'river/?limit=' + CFG.riverLimit + '&ordering=-id')
      .then(function (data) {
        var seen = {}, out = [];
        asArray(data.results).forEach(function (r) {
          if (seen[r.title]) return;          /* newest row per station wins */
          seen[r.title] = 1;
          var hit = RIVER_PATTERNS.some(function (p) { return p.test(r.title || ''); });
          if (hit) out.push(r);
        });
        state.rivers = out;
        health('river', 'नदी जलसतह · ' + toNe(out.length), 'ok');
        renderRivers();
      }).catch(function () {
        health('river', 'नदी जलसतह असफल', 'fail');
        renderRivers();
      });
  }

  function riverStatus(r) {
    var w = r.waterLevel, d = r.dangerLevel, wn = r.warningLevel;
    if (d != null && w >= d) return { cls: 'fail', ne: 'खतरा तह' };
    if (wn != null && w >= wn) return { cls: 'wait', ne: 'सतर्कता तह' };
    return { cls: 'ok', ne: 'सामान्य' };
  }

  function renderRivers() {
    var host = $('river-list');
    if (!host) return;
    clear(host);
    if (!state.rivers.length) {
      host.appendChild(el('div', 'empty', 'जलसतहको तथ्यांक अहिले आएन।'));
      $('river-count').textContent = '—';
      return;
    }
    $('river-count').textContent = toNe(state.rivers.length) + ' स्टेसन';
    state.rivers.forEach(function (r) {
      var st = riverStatus(r);
      var c = el('div', 'card');
      var h = el('h3');
      h.appendChild(el('span', 'tag ' + (st.cls === 'ok' ? 'gov' : 'hazard'), st.ne));
      h.appendChild(document.createTextNode(r.title));
      c.appendChild(h);
      var p = el('p');
      p.appendChild(document.createTextNode(
        'जलसतह ' + toNe(Number(r.waterLevel).toFixed(2)) + ' मि' +
        (r.warningLevel != null ? ' · सतर्कता ' + toNe(r.warningLevel) + ' मि' : '') +
        (r.dangerLevel != null ? ' · खतरा ' + toNe(r.dangerLevel) + ' मि' : '') +
        (r.steady ? ' · ' + ({ RISING: 'बढ्दो', FALLING: 'घट्दो', STEADY: 'स्थिर' }[r.steady] || r.steady) : '')
      ));
      c.appendChild(p);
      var t = el('p');
      t.appendChild(el('time', null, 'बेसिन ' + (r.basin || '—') + ' · ' + ago(r.waterLevelOn)));
      c.appendChild(t);
      host.appendChild(c);
    });
  }

  /* ── BIPAD: active alerts ──────────────────────────────── */

  function loadAlerts() {
    health('alert', 'सक्रिय सतर्कता', 'wait');
    return getJSON(CFG.bipad + 'alert/?limit=' + CFG.alertLimit + '&ordering=-created_on')
      .then(function (data) {
        var now = Date.now();
        state.alerts = asArray(data.results).filter(function (a) {
          if (!a.public) return false;
          var d = districtOf(a) || (a.titleNe || '');
          var near = FOCUS_DISTRICTS.some(function (x) { return (a.titleNe || '').indexOf(x) >= 0; });
          var fresh = !a.expireOn || new Date(a.expireOn).getTime() > now - 6 * 3600e3;
          return near && fresh && d !== undefined;
        });
        health('alert', 'सक्रिय सतर्कता · ' + toNe(state.alerts.length), 'ok');
        renderAlerts();
      }).catch(function () {
        health('alert', 'सतर्कता असफल', 'fail');
        renderAlerts();
      });
  }

  function renderAlerts() {
    var host = $('alert-list');
    if (!host) return;
    clear(host);
    $('alert-count').textContent = toNe(state.alerts.length);
    if (!state.alerts.length) {
      host.appendChild(el('div', 'empty',
        'करिडोरका जिल्लाका लागि BIPAD मा अहिले सक्रिय सार्वजनिक सतर्कता छैन।'));
      return;
    }
    state.alerts.slice(0, 20).forEach(function (a) {
      var c = el('div', 'card');
      var h = el('h3');
      h.appendChild(el('span', 'tag gov', (a.source || 'BIPAD').toUpperCase()));
      h.appendChild(document.createTextNode(a.titleNe || a.title || '—'));
      c.appendChild(h);
      var p = el('p');
      if (a.description) p.appendChild(document.createTextNode(a.description + ' · '));
      p.appendChild(el('time', null, ago(a.startedOn || a.createdOn)));
      c.appendChild(p);
      host.appendChild(c);
    });
  }

  /* ── news: data/live.json first, then RSS via proxy ────── */

  function loadNews() {
    health('news', 'समाचार फिड', 'wait');
    /* Preferred path: a file baked by scripts/fetch-sources.mjs in CI. */
    return getJSON('data/live.json?t=' + Date.now()).then(function (baked) {
      var items = asArray(baked && baked.news);
      if (!items.length) throw new Error('empty');
      state.news = items;
      health('news', 'समाचार · अभिलेख फाइल · ' + toNe(items.length), 'ok');
      renderNews();
    }).catch(function () {
      return loadNewsLive();
    });
  }

  function loadNewsLive() {
    var feeds = asArray(state.feeds && state.feeds.rss);
    var kw = asArray(state.feeds && state.feeds.keywords).map(function (k) { return k.toLowerCase(); });

    return Promise.all(feeds.map(function (f) {
      return fetchFeed(f, kw).catch(function () { return []; });
    })).then(function (batches) {
      var all = [];
      batches.forEach(function (b) { all = all.concat(b); });
      all.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      state.news = all;
      var okFeeds = batches.filter(function (b) { return b.length; }).length;
      health('news', 'समाचार · ' + toNe(okFeeds) + '/' + toNe(feeds.length) + ' फिड · ' + toNe(all.length),
        all.length ? 'ok' : 'fail');
      renderNews();
    });
  }

  /* Nepali news sites send no CORS header, so hop through a public proxy. */
  function fetchFeed(feed, kw) {
    var proxies = asArray(state.feeds && state.feeds.proxies);
    var chain = Promise.reject();
    proxies.forEach(function (p) {
      chain = chain.catch(function () {
        /* A dead proxy must fail fast — six feeds each walking the whole
           chain at the full timeout would leave the section blank for a minute. */
        return getText(p + encodeURIComponent(feed.url), CFG.proxyTimeout);
      });
    });
    return chain.then(function (body) { return parseFeed(unwrap(body), feed, kw); });
  }

  /* allorigins' /get endpoint wraps the document in {"contents": "..."} */
  function unwrap(body) {
    var s = String(body).trim();
    if (s.charAt(0) !== '{') return s;
    try {
      var j = JSON.parse(s);
      return typeof j.contents === 'string' ? j.contents : s;
    } catch (e) {
      return s;
    }
  }

  function parseFeed(xml, feed, kw) {
    var doc = new DOMParser().parseFromString(xml, 'text/xml');
    var nodes = doc.querySelectorAll('item, entry');
    var out = [];
    Array.prototype.forEach.call(nodes, function (n) {
      var pick = function (t) {
        var e = n.querySelector(t);
        return e ? (e.textContent || '').trim() : '';
      };
      var title = pick('title');
      var link = pick('link') || (n.querySelector('link') && n.querySelector('link').getAttribute('href')) || '';
      var date = pick('pubDate') || pick('published') || pick('updated');
      if (!title) return;
      var hay = (title + ' ' + link).toLowerCase();
      var match = !kw.length || kw.some(function (k) { return hay.indexOf(k) >= 0; });
      if (!match) return;
      out.push({
        source: feed.name, sourceId: feed.id, site: feed.site,
        title: title, link: link, date: date,
        ts: date ? new Date(date).getTime() || 0 : 0
      });
    });
    return out.slice(0, CFG.newsPerFeed);
  }

  function renderNews() {
    var tabs = $('news-tabs');
    clear(tabs);
    var bySrc = {};
    state.news.forEach(function (n) { bySrc[n.source] = (bySrc[n.source] || 0) + 1; });
    var opts = [{ k: 'all', t: 'सबै (' + toNe(state.news.length) + ')' }];
    Object.keys(bySrc).forEach(function (s) {
      opts.push({ k: s, t: s + ' (' + toNe(bySrc[s]) + ')' });
    });
    opts.forEach(function (o) {
      var b = el('button', state.newsTab === o.k ? 'active' : '', o.t);
      b.type = 'button';
      b.onclick = function () { state.newsTab = o.k; renderNews(); };
      tabs.appendChild(b);
    });

    var rows = state.newsTab === 'all'
      ? state.news
      : state.news.filter(function (n) { return n.source === state.newsTab; });

    $('news-count').textContent = toNe(rows.length) + ' शीर्षक';
    var list = $('news-list');
    clear(list);
    if (!rows.length) {
      list.appendChild(el('div', 'empty',
        'समाचार फिड अहिले पढ्न सकिएन। ब्राउजरले तेस्रो-पक्ष प्रोक्सी रोकेको हुन सक्छ — ' +
        'तल स्रोत खण्डबाट सिधै प्रकाशकको पृष्ठमा जानुहोस्।'));
      return;
    }
    rows.slice(0, 60).forEach(function (n) {
      var c = el('div', 'card');
      var h = el('h3');
      h.appendChild(el('span', 'tag', n.source));
      var a = el('a', null, n.title);
      a.href = n.link; a.target = '_blank'; a.rel = 'noopener';
      h.appendChild(a);
      c.appendChild(h);
      var p = el('p');
      p.appendChild(el('time', null, n.date ? ago(n.date) : ''));
      c.appendChild(p);
      list.appendChild(c);
    });
  }

  /* ── map ───────────────────────────────────────────────── */

  function renderMap() {
    if (typeof L === 'undefined') return;
    if (!state.map) {
      state.map = L.map('map-canvas').setView([28.05, 85.15], 8);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 17, attribution: '© OpenStreetMap'
      }).addTo(state.map);
      state.layer = L.layerGroup().addTo(state.map);
    }
    state.layer.clearLayers();

    var pts = [];
    visibleIncidents().forEach(function (r) {
      if (!r.point || !r.point.coordinates) return;
      var lng = r.point.coordinates[0], lat = r.point.coordinates[1];
      if (!lat || !lng) return;
      pts.push([lat, lng]);
      L.circleMarker([lat, lng], {
        radius: 6, color: '#c41e3a', weight: 2, fillColor: '#c41e3a', fillOpacity: .45
      }).bindPopup(
        '<b>' + (WATER_HAZARDS[r.hazard] || '') + '</b><br>' +
        (r.titleNe || r.title || '') + '<br><small>' + ago(r.reportedOn || r.incidentOn) + '</small>'
      ).addTo(state.layer);
    });

    state.rivers.forEach(function (r) {
      if (!r.point || !r.point.coordinates) return;
      var st = riverStatus(r);
      var col = st.cls === 'fail' ? '#7f1d1d' : (st.cls === 'wait' ? '#d97706' : '#0e7490');
      L.circleMarker([r.point.coordinates[1], r.point.coordinates[0]], {
        radius: 7, color: col, weight: 3, fillColor: '#fff', fillOpacity: .9
      }).bindPopup(
        '<b>' + r.title + '</b><br>जलसतह ' + toNe(Number(r.waterLevel).toFixed(2)) + ' मि · ' + st.ne +
        '<br><small>' + ago(r.waterLevelOn) + '</small>'
      ).addTo(state.layer);
    });

    $('map-count').textContent = toNe(pts.length) + ' बिन्दु';
    if (pts.length) state.map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 11 });
  }

  /* ── static registries (contacts / helpline / sources) ─── */

  function absolute(url) {
    if (/^https?:\/\//i.test(url) || /^(tel|mailto):/i.test(url)) return url;
    return CFG.originalSite + url.replace(/^\.?\//, '');
  }

  function renderHelpline() {
    var host = $('hl-dist');
    clear(host);
    state.helpline.forEach(function (d) {
      var art = el('article');
      art.appendChild(el('b', null, d.district));
      asArray(d.lines).forEach(function (l) {
        var a = el('a');
        a.href = 'tel:' + l.tel;
        a.appendChild(el('span', null, l.role));
        a.appendChild(el('em', null, l.phone));
        art.appendChild(a);
      });
      host.appendChild(art);
    });
  }

  function renderContacts() {
    var host = $('cao-grid');
    clear(host);
    var total = 0;
    state.contacts.forEach(function (d) {
      var art = el('article');
      var h = el('h3', null, d.district);
      h.appendChild(el('small', null, toNe(d.count)));
      art.appendChild(h);
      asArray(d.officials).forEach(function (o) {
        total++;
        var a = el('a');
        a.href = 'tel:' + o.tel;
        var s = el('span', null, o.body + ' ');
        s.appendChild(el('b', null, o.officer));
        a.appendChild(s);
        a.appendChild(el('em', null, o.phone));
        art.appendChild(a);
      });
      host.appendChild(art);
    });
    $('cao-count').textContent = toNe(total) + ' अधिकृत';
  }

  function renderSocial() {
    var host = $('social-grid');
    clear(host);
    var rows = asArray(state.feeds && state.feeds.official)
      .concat(asArray(state.feeds && state.feeds.social));
    rows.forEach(function (s) {
      var a = el('a');
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
      a.appendChild(document.createTextNode(s.name));
      a.appendChild(el('em', null, s.platform ? s.platform.toUpperCase() : 'वेब'));
      host.appendChild(a);
    });
  }

  function liveGroups() {
    /* Source groups this page actually reads on every refresh. */
    var live = ['BIPAD', 'NDRRMA'];
    asArray(state.feeds && state.feeds.rss).forEach(function (f) { live.push(f.name); });
    return live;
  }

  function renderSources() {
    var groups = state.sources;
    var live = liveGroups();
    var total = 0;
    groups.forEach(function (g) { total += asArray(g.links).length; });
    $('src-count').textContent = toNe(groups.length) + ' समूह · ' + toNe(total) + ' कडी';

    /* The original appended a Nepali link-count to each group name; drop it
       and show the count as a badge instead. */
    var cleanName = function (s) { return String(s).replace(/[\s०-९0-9]+$/, ''); };

    var tabs = $('src-tabs');
    clear(tabs);
    groups.forEach(function (g, i) {
      var b = el('button', state.srcTab === i ? 'active' : '', cleanName(g.group));
      b.type = 'button';
      b.onclick = function () { state.srcTab = i; renderSources(); };
      tabs.appendChild(b);
    });

    var host = $('src-grid');
    clear(host);
    var g = groups[state.srcTab];
    if (!g) return;
    var box = el('div', 'src-group');
    var h = el('h3', null, cleanName(g.group));
    var isLive = live.some(function (n) { return g.group.indexOf(n) >= 0; });
    h.appendChild(el('span', 'badge', toNe(asArray(g.links).length) + ' कडी'));
    h.appendChild(el('span', 'badge', isLive ? 'लाइभ' : 'अभिलेख'));
    box.appendChild(h);
    var list = el('div', 'src-list');
    asArray(g.links).forEach(function (l) {
      var a = el('a', null, l.title || l.url);
      a.href = absolute(l.url); a.target = '_blank'; a.rel = 'noopener';
      list.appendChild(a);
    });
    box.appendChild(list);
    host.appendChild(box);
  }

  /* ── boot & refresh cycle ──────────────────────────────── */

  function refresh() {
    var btn = $('refresh');
    btn.disabled = true;
    $('updated').textContent = 'ताजा गर्दै…';
    return Promise.all([loadIncidents(), loadRivers(), loadAlerts(), loadNews()])
      .then(function () {
        var now = new Date();
        $('updated').textContent = 'अन्तिम अद्यावधिक ' + clock(now) +
          ' · स्वतः हरेक ' + toNe(CFG.refreshMs / 60000) + ' मिनेट';
      })
      .catch(function () { $('updated').textContent = 'केही स्रोत पढ्न सकिएन'; })
      .then(function () { btn.disabled = false; });
  }

  function boot() {
    Promise.all([
      getJSON('data/feeds.json').catch(function () { return {}; }),
      getJSON('data/sources.json').catch(function () { return []; }),
      getJSON('data/contacts.json').catch(function () { return []; }),
      getJSON('data/helpline.json').catch(function () { return []; })
    ]).then(function (r) {
      state.feeds = r[0];
      state.sources = asArray(r[1]);
      state.contacts = asArray(r[2]);
      state.helpline = asArray(r[3]);
      renderHelpline();
      renderContacts();
      renderSocial();
      renderSources();
      return refresh();
    });

    $('refresh').onclick = refresh;
    setInterval(refresh, CFG.refreshMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
