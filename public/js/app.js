/* APAAR × AICTE portal — single-page application (vanilla JS, no deps). */
(function () {
  'use strict';

  /* ================= state & api ========================================== */
  var S = {
    token: sessionStorage.getItem('apaar_token') || null,
    user: JSON.parse(sessionStorage.getItem('apaar_user') || 'null'),
    view: 'overview',
    dash: null,
    issues: [],
    page: 1,
    q: '',
    instFilter: '',
    statusFilter: '',
    lastVerify: null,
    programmes: [],
    institutions: []
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (S.token) headers['auth_token'] = S.token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== '/api/auth/login') { logout(true); throw new Error('Session expired'); }
        if (!r.ok) { var e = new Error(data.error || ('HTTP ' + r.status)); e.data = data; e.status = r.status; throw e; }
        return data;
      });
    });
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return (n == null ? 0 : n).toLocaleString('en-IN'); }
  function prettyApaar(id) {
    id = String(id || '');
    return id.length === 12 ? id.slice(0, 2) + ' ' + id.slice(2, 6) + ' ' + id.slice(6, 11) + ' ' + id.slice(11) : id;
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  /* ================= toasts ============================================== */
  function toast(msg, sub, kind) {
    var wrap = $('.toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<span style="font-size:17px;line-height:1.2">' +
      (kind === 'ok' ? '✓' : kind === 'err' ? '✕' : kind === 'warn' ? '⚠' : 'ℹ') +
      '</span><div><div>' + esc(msg) + '</div>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(30px)';
      setTimeout(function () { el.remove(); }, 320);
    }, 4200);
  }

  /* ================= auth ================================================= */
  var ROLE_PRESET = {
    AICTE_ADMIN: 'aicte.admin',
    INSTITUTION: 'cope.pune',
    VERIFIER: 'employer.demo'
  };

  function login(username, password) {
    return api('/api/auth/login', { method: 'POST', body: { username: username, password: password } })
      .then(function (d) {
        S.token = d.token; S.user = d.user;
        sessionStorage.setItem('apaar_token', d.token);
        sessionStorage.setItem('apaar_user', JSON.stringify(d.user));
        enterPortal();
        toast('Welcome, ' + d.user.name, 'Signed in as ' + roleLabel(d.user.role), 'ok');
      })
      .catch(function (e) {
        var box = $('#login-err');
        box.style.display = 'block';
        box.textContent = e.data && e.data.error ? e.data.error : 'Sign-in failed — is the server running?';
      });
  }

  function logout(silent) {
    if (S.token) api('/api/auth/logout', { method: 'POST' }).catch(function () {});
    S.token = null; S.user = null;
    sessionStorage.removeItem('apaar_token');
    sessionStorage.removeItem('apaar_user');
    $('#portal').classList.add('hide');
    $('#login').classList.remove('hide');
    if (!silent) toast('Signed out');
  }

  function roleLabel(r) {
    return { AICTE_ADMIN: 'AICTE Central Admin', INSTITUTION: 'Institution User', VERIFIER: 'Authorized Verifier' }[r] || r;
  }

  function enterPortal() {
    $('#login').classList.add('hide');
    $('#portal').classList.remove('hide');
    renderShell();
    go(S.user.role === 'VERIFIER' ? 'verify' : 'overview');
  }

  /* ================= shell / nav ========================================== */
  var NAV = [
    { id: 'overview',    label: 'Overview',      icon: '◧', roles: ['AICTE_ADMIN', 'INSTITUTION'] },
    { id: 'institutions',label: 'Institutions',  icon: '🏛', roles: ['AICTE_ADMIN'] },
    { id: 'students',    label: 'Students',      icon: '👥', roles: ['AICTE_ADMIN', 'INSTITUTION'] },
    { id: 'upload',      label: 'Data Upload',   icon: '⬆', roles: ['AICTE_ADMIN', 'INSTITUTION'] },
    { id: 'validation',  label: 'Validation',    icon: '⚠', roles: ['AICTE_ADMIN', 'INSTITUTION'] },
    { id: 'verify',      label: 'Verify APAAR',  icon: '⛨', roles: ['AICTE_ADMIN', 'INSTITUTION', 'VERIFIER'] },
    { id: 'reports',     label: 'Reports',       icon: '▤', roles: ['AICTE_ADMIN', 'INSTITUTION'] },
    { id: 'audit',       label: 'Audit Trail',   icon: '⟲', roles: ['AICTE_ADMIN', 'INSTITUTION'] }
  ];

  function renderShell() {
    var u = S.user;
    var nav = NAV.filter(function (n) { return n.roles.indexOf(u.role) >= 0; });
    var html = '<div class="brand"><div class="logo">A</div><div>APAAR Repository<small>AICTE Platform</small></div></div>' +
      '<div class="nav-group">Monitoring</div>';
    nav.forEach(function (n, i) {
      if (i === 4) html += '<div class="nav-group">Records & Trust</div>';
      var count = '';
      if (n.id === 'validation' && S.issues.length) {
        var errs = S.issues.filter(function (x) { return x.severity === 'error'; }).length;
        count = '<span class="count ' + (errs ? 'alert' : '') + '">' + (errs || S.issues.length) + '</span>';
      }
      html += '<div class="nav-item" data-go="' + n.id + '"><span class="ic">' + n.icon + '</span>' + n.label + count + '</div>';
    });
    html += '<div class="sidebar-foot"><div class="who"><div class="av">' + esc(initials(u.name)) + '</div>' +
      '<div><b>' + esc(u.name) + '</b><span>' + esc(roleLabel(u.role)) + (u.institution_id ? ' · ' + esc(u.institution_id) : '') + '</span></div>' +
      '<button class="out" title="Sign out" onclick="App.logout()">⏻</button></div></div>';
    $('#sidebar').innerHTML = html;
    $$('#sidebar [data-go]').forEach(function (el) {
      el.addEventListener('click', function () { go(el.dataset.go); });
    });
  }

  var TITLES = {
    overview: ['National Overview', 'Real-time enrolment & data-quality monitoring across AICTE-approved institutions'],
    institutions: ['Institutions', 'Approved institutions with intake utilisation and anomaly counts'],
    students: ['Student Records', 'APAAR-keyed student master — search, inspect, manage consent'],
    upload: ['Data Upload', 'Submit student-level data after admissions — single record or bulk batch'],
    validation: ['Validation Center', 'Automated anomaly detection: duplicates, invalid APAAR, intake breaches, inconsistencies'],
    verify: ['Verify APAAR', 'Authorized stakeholders: verify a student record and its signed credential'],
    reports: ['Reports & Analytics', 'Export monitoring data for policy, accreditation and regulatory review'],
    audit: ['Audit Trail', 'Immutable log of every login, upload, verification and export']
  };

  function closeMenu() {
    $('#sidebar').classList.remove('open');
    var sc = $('#sidebar-scrim'); if (sc) sc.classList.remove('on');
  }

  function go(view) {
    S.view = view;
    $$('#sidebar [data-go]').forEach(function (el) {
      el.classList.toggle('active', el.dataset.go === view);
    });
    var t = TITLES[view] || ['', ''];
    $('#page-title').textContent = t[0];
    $('#page-sub').textContent = t[1];
    closeMenu();
    var c = $('#content');
    c.innerHTML = '<div class="sk" style="height:120px"></div><div class="sk" style="height:260px"></div><div class="sk" style="height:200px"></div>';

    ({
      overview: viewOverview, institutions: viewInstitutions, students: viewStudents,
      upload: viewUpload, validation: viewValidation, verify: viewVerify,
      reports: viewReports, audit: viewAudit
    }[view] || viewOverview)();
  }

  /* ================= overview ============================================ */
  function viewOverview() {
    api('/api/dashboard').then(function (d) {
      S.dash = d;
      var k = d.kpis;
      var c = $('#content');
      c.innerHTML =
        '<div class="kpis">' +
        kpi('Students in Repository', fmt(k.students_total), fmt(k.students_active) + ' active across ' + k.institutions + ' institutions', '👥', '') +
        kpi('Approved Intake (incl. SN)', fmt(k.intake_with_sn), k.utilisation + '% utilised nationally', '🎫', 'gold') +
        kpi('APAAR Integrity', k.apaar_valid_pct + '%', 'valid IDs · ' + k.consent_granted_pct + '% consent granted', '⛨', 'green') +
        kpi('Open Anomalies', fmt(k.issues_error + k.issues_warning), k.issues_error + ' errors · ' + k.issues_warning + ' warnings', '⚠', 'red') +
        '</div>' +

        '<div class="charts-row">' +
        cardHTML('Admissions by Year', '<canvas class="chart" id="ch-year"></canvas>') +
        cardHTML('Category Distribution', '<canvas class="chart" id="ch-cat"></canvas><div class="legend" id="lg-cat"></div>') +
        cardHTML('Seat Type Mix', '<canvas class="chart" id="ch-seat"></canvas><div class="legend" id="lg-seat"></div>') +
        '</div>' +

        '<div class="charts-row-2">' +
        cardHTML('Enrolment vs Approved Intake — Top Institutions',
          '<canvas class="chart" id="ch-inst"></canvas>') +
        cardHTML('Anomaly Feed',
          '<div id="issue-feed"></div>' +
          (k.cross_institution_dupes ? '<div class="issue error"><span class="code">DUP-002</span><div><div class="msg"><b>' + k.cross_institution_dupes + '</b> APAAR ID(s) enrolled at more than one institution</div><div class="meta"><span>National-level cross-check</span></div></div></div>' : ''),
          '<button class="btn btn-ghost btn-sm" onclick="App.go(\'validation\')">Open Validation Center →</button>') +
        '</div>' +

        cardHTML('Institution Monitoring' + (S.user.role === 'INSTITUTION' ? '' : ' — ranked by open issues'),
          institutionsTable(d.institutions_table),
          S.user.role === 'AICTE_ADMIN'
            ? '<a class="btn btn-ghost btn-sm" href="/api/reports/enrolment.csv" target="_blank" onclick="App.auditPing()">⤓ Export CSV</a>'
            : '');

      // charts
      Charts.bar($('#ch-year'), d.charts.by_year, { color: '#2d4bff', color2: '#7c5cff' });
      Charts.donut($('#ch-cat'), d.charts.by_category.map(function (x, i) {
        return { label: x.label, value: x.value, color: Charts.palette[i % Charts.palette.length] };
      }), { centerSub: 'students', height: 226 });
      legendInto('#lg-cat', d.charts.by_category);
      Charts.donut($('#ch-seat'), d.charts.by_seat.map(function (x, i) {
        return { label: x.label, value: x.value, color: seatColor(x.label) };
      }), { centerSub: 'seats', height: 226 });
      legendInto('#lg-seat', d.charts.by_seat);

      var rows = d.institutions_table.slice(0, 6);
      Charts.hbar($('#ch-inst'), rows.map(function (r) {
        return {
          label: shortName(r.name), value: r.utilisation,
          display: r.utilisation + '% (' + r.enrolled + '/' + r.intake + ')',
          color: r.utilisation > 100 ? '#f4436c' : r.utilisation > 90 ? '#f5a524' : '#2d4bff'
        };
      }), { labelW: 170, rowH: 36, minH: 226 });

      // issue feed
      var feed = $('#issue-feed');
      if (feed) {
        if (d.top_issues.length === 0) {
          feed.innerHTML = '<div class="empty"><div class="ic">✓</div><b>All checks passing</b>No anomalies detected in your scope.</div>';
        } else {
          feed.innerHTML = d.top_issues.slice(0, 5).map(function (t) {
            return '<div class="issue ' + t.severity + '"><span class="code">' + t.code + '</span>' +
              '<div><div class="msg">' + esc(t.sample) + '</div>' +
              '<div class="meta"><span><b>' + t.count + '</b> occurrence' + (t.count > 1 ? 's' : '') + '</span></div></div></div>';
          }).join('');
        }
      }
    }).catch(function (e) { failContent(e); });
  }

  function kpi(label, val, sub, icon, mod) {
    return '<div class="kpi ' + (mod || '') + '"><div class="k-ic">' + icon + '</div>' +
      '<div class="k-lbl">' + esc(label) + '</div><div class="k-val">' + val + '</div>' +
      '<div class="k-sub">' + esc(sub) + '</div></div>';
  }
  function cardHTML(title, body, action) {
    return '<div class="card"><div class="card-head"><h3>' + esc(title) + '</h3>' + (action || '') + '</div>' +
      '<div class="card-body">' + body + '</div></div>';
  }
  function legendInto(sel, items) {
    var el = $(sel); if (!el) return;
    el.innerHTML = items.map(function (x, i) {
      return '<span class="li"><span class="sw" style="background:' + Charts.palette[i % Charts.palette.length] + '"></span>' +
        esc(x.label) + ' · ' + fmt(x.value) + '</span>';
    }).join('');
  }
  function seatColor(label) {
    return { Regular: '#2d4bff', Supernumerary: '#7c5cff', NRI: '#f5a524', OCI: '#17b978', ForeignNational: '#f4436c' }[label] || '#8a92b0';
  }
  function shortName(n) {
    return n.replace(/(Institute of Technology|National Institute of Technology|Institute of Engineering & Technology|College of Technology|Institute of Technology)$/i, '')
      .trim() || n;
  }

  function institutionsTable(rows) {
    return '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      '<th>Institution</th><th>State</th><th class="num">Programmes</th><th class="num">Intake + SN</th>' +
      '<th class="num">Enrolled</th><th>Utilisation</th><th class="num">Issues</th><th class="num">APAAR %</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        var cls = r.utilisation > 100 ? 'err' : r.utilisation > 95 ? 'gold' : 'ok';
        return '<tr><td><b>' + esc(r.name) + '</b></td><td>' + esc(r.state) + '</td>' +
          '<td class="num">' + r.approved + '</td><td class="num">' + fmt(r.intake) + '</td>' +
          '<td class="num"><b>' + fmt(r.enrolled) + '</b></td>' +
          '<td style="min-width:150px"><div class="between gap-8"><div class="bar ' + cls + '" style="flex:1"><i style="width:' +
          Math.min(100, r.utilisation) + '%"></i></div><b class="small">' + r.utilisation + '%</b></div></td>' +
          '<td class="num">' + (r.issues ? '<span class="badge err">' + r.issues + '</span>' : '<span class="badge ok">0</span>') + '</td>' +
          '<td class="num">' + r.apaar_coverage + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  /* ================= institutions ========================================= */
  function viewInstitutions() {
    Promise.all([api('/api/institutions'), api('/api/programmes')]).then(function (res) {
      S.institutions = res[0].institutions;
      S.programmes = res[1].programmes;
      var dash = S.dash || {};
      var table = (dash.institutions_table || []);
      $('#content').innerHTML =
        '<div class="split-3">' +
        kpi('Approved Institutions', fmt(S.institutions.length), 'across ' + uniq(S.institutions.map(function (i) { return i.state; })).length + ' states', '🏛', '') +
        kpi('Approved Programmes', fmt(S.programmes.length), fmt(S.programmes.reduce(function (a, p) { return a + p.approved_intake; }, 0)) + ' seats sanctioned', '🎓', 'gold') +
        kpi('Seats with Supernumerary', fmt(S.programmes.reduce(function (a, p) { return a + p.supernumerary_cap; }, 0)), 'plus NRI/OCI/FN quota caps', '⊕', 'green') +
        '</div>' +
        cardHTML('Institution Directory', institutionsTable(table.length ? table : S.institutions.map(function (i) {
          return { name: i.name, state: i.state, approved: 0, intake: 0, enrolled: 0, utilisation: 0, issues: 0, apaar_coverage: 100 };
        }))) +
        cardHTML('Programme Master — approved intake, supernumerary & quota caps',
          '<div class="table-wrap"><table class="tbl"><thead><tr><th>Programme</th><th>Institution</th><th>Level</th>' +
          '<th class="num">Approved Intake</th><th class="num">Supernumerary</th><th class="num">NRI Cap</th><th class="num">OCI/FN Cap</th></tr></thead><tbody>' +
          S.programmes.map(function (p) {
            var ins = S.institutions.find(function (i) { return i.id === p.institution_id; });
            return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(ins ? ins.name : p.institution_id) + '</td>' +
              '<td><span class="badge neutral">' + esc(p.level) + '</span></td>' +
              '<td class="num"><b>' + p.approved_intake + '</b></td><td class="num">' + p.supernumerary_cap + '</td>' +
              '<td class="num">' + p.nri_cap + '</td><td class="num">' + p.fn_cap + '</td></tr>';
          }).join('') + '</tbody></table></div>');
    }).catch(failContent);
  }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  /* ================= students ============================================= */
  function viewStudents() {
    var instOpts = S.institutions.length ? Promise.resolve(S.institutions) : api('/api/institutions').then(function (d) { S.institutions = d.institutions; return d.institutions; });
    var progOpts = S.programmes.length ? Promise.resolve(S.programmes) : api('/api/programmes').then(function (d) { S.programmes = d.programmes; return d.programmes; });
    Promise.all([instOpts, progOpts]).then(function () {
      $('#content').innerHTML =
        '<div class="card"><div class="card-head">' +
        '<div class="flex gap-8 wrap"><div class="searchbox" style="margin-left:0;min-width:280px"><span>⌕</span>' +
        '<input id="stu-q" placeholder="Search name, APAAR ID, enrolment no…" value="' + esc(S.q) + '"><span class="k">↵</span></div>' +
        (S.user.role === 'AICTE_ADMIN' ? '<select class="input" id="stu-inst" style="width:auto"><option value="">All institutions</option>' +
          S.institutions.map(function (i) { return '<option value="' + i.id + '"' + (S.instFilter === i.id ? ' selected' : '') + '>' + esc(i.name) + '</option>'; }).join('') + '</select>' : '') +
        '<select class="input" id="stu-status" style="width:auto"><option value="">Any status</option>' +
          ['Active', 'Graduated', 'Withdrawn'].map(function (s) { return '<option' + (S.statusFilter === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
        '</div>' +
        '<a class="btn btn-ghost btn-sm" href="/api/records.csv' +
        (S.instFilter ? '?institution_id=' + S.instFilter : '') + '" target="_blank">⤓ CSV</a>' +
        '</div><div class="card-body" id="stu-body" style="padding-top:8px"><div class="sk" style="height:300px"></div></div></div>';

      var t;
      $('#stu-q').addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { S.q = $('#stu-q').value; S.page = 1; loadStudents(); }, 260); });
      $('#stu-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { S.q = $('#stu-q').value; S.page = 1; loadStudents(); } });
      $('#stu-inst') && $('#stu-inst').addEventListener('change', function () { S.instFilter = this.value; S.page = 1; loadStudents(); });
      $('#stu-status').addEventListener('change', function () { S.statusFilter = this.value; S.page = 1; loadStudents(); });
      loadStudents();
    }).catch(failContent);
  }

  function loadStudents() {
    var qs = 'per=12&page=' + S.page + '&q=' + encodeURIComponent(S.q) +
      (S.instFilter ? '&institution_id=' + encodeURIComponent(S.instFilter) : '') +
      (S.statusFilter ? '&status=' + encodeURIComponent(S.statusFilter) : '');
    api('/api/students?' + qs).then(function (d) {
      var body = $('#stu-body'); if (!body) return;
      if (!d.students.length) {
        body.innerHTML = '<div class="empty"><div class="ic">🔍</div><b>No records match</b>Adjust filters or search terms.</div>';
        return;
      }
      var pages = Math.max(1, Math.ceil(d.total / d.per));
      body.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        '<th>APaar ID</th><th>Name</th><th>Programme</th><th>Institution</th><th>Enrolment No.</th><th>Seat</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        d.students.map(function (s) {
          return '<tr>' +
            '<td class="mono" style="font-size:12.5px;letter-spacing:.05em"><b>' + esc(prettyApaar(s.apaar_id)) + '</b></td>' +
            '<td><b>' + esc(s.name) + '</b><div class="xsmall muted">' + esc(s.category) + ' · ' + esc(s.gender) + '</div></td>' +
            '<td>' + esc(shortProg(s.programme_name)) + '</td>' +
            '<td class="small">' + esc(shortName(s.institution_name || '')) + '</td>' +
            '<td class="mono small">' + esc(s.enrolment_no) + '</td>' +
            '<td>' + seatBadge(s.seat_type) + '</td>' +
            '<td>' + statusBadge(s.status) + '</td>' +
            '<td class="num"><button class="btn btn-ghost btn-sm" onclick="App.studentModal(\'' + s.id + '\')">View</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="pager"><span>' + d.total + ' records · page ' + d.page + ' / ' + pages + '</span>' +
        '<button' + (S.page <= 1 ? ' disabled' : '') + ' onclick="App.pageTo(' + (S.page - 1) + ')">← Prev</button>' +
        '<button' + (S.page >= pages ? ' disabled' : '') + ' onclick="App.pageTo(' + (S.page + 1) + ')">Next →</button></div>';
    }).catch(failContent);
  }
  function shortProg(p) { return String(p || '').replace('Computer Science and Engineering', 'CSE').replace('Electronics and Communication Engineering', 'ECE').replace('Information Technology', 'IT'); }
  function seatBadge(t) {
    var m = { Regular: 'neutral', Supernumerary: 'info', NRI: 'gold', OCI: 'ok', ForeignNational: 'err' };
    return '<span class="badge ' + (m[t] || 'neutral') + '">' + esc(t || 'Regular') + '</span>';
  }
  function statusBadge(s) {
    var m = { Active: 'ok', Graduated: 'info', Withdrawn: 'neutral' };
    return '<span class="badge ' + (m[s] || 'neutral') + '"><span class="dot"></span>' + esc(s) + '</span>';
  }

  window.App = window.App || {};
  App.pageTo = function (p) { S.page = p; loadStudents(); };

  App.studentModal = function (id) {
    api('/api/students?per=200&q=' + encodeURIComponent('')).then(function () {
      // fetch directly by widening search is wasteful; use issues + local list instead
    }).catch(function () {});
    // simplest: search by id through the list endpoint is unsupported → fetch all fields via verify-style detail
    api('/api/students?per=1000').then(function (d) {
      var s = d.students.find(function (x) { return x.id === id; });
      if (!s) { toast('Record not found', null, 'err'); return; }
      openStudent(s);
    });
  };

  function openStudent(s) {
    var cred;
    openModal(
      '<div class="modal-head"><div><h3>' + esc(s.name) + '</h3>' +
      '<div class="small muted mono">' + esc(prettyApaar(s.apaar_id)) + '</div></div>' +
      '<button class="modal-x" onclick="App.closeModal()">✕</button></div>' +
      '<div class="modal-body">' +
      '<div class="split">' +
      '<div>' +
      field('Programme', s.programme_name) +
      field('Institution', s.institution_name) +
      field('Enrolment No.', s.enrolment_no, true) +
      field('Institute SC No.', s.institute_sc_no, true) +
      field('Admission', s.admission_date + ' (' + s.admission_year + ')') +
      '</div><div>' +
      field('Date of Birth', s.dob) +
      field('Gender / Category', s.gender + ' · ' + s.category) +
      field('Nationality', s.nationality) +
      field('Seat Type', s.seat_type, false, seatBadge(s.seat_type)) +
      field('Status', s.status, false, statusBadge(s.status)) +
      (s.oci_card_no ? field('OCI Card', s.oci_card_no, true) : '') +
      (s.passport_no ? field('Passport', s.passport_no, true) : '') +
      field('Contact', [s.email, s.phone].filter(Boolean).join(' · ')) +
      '</div></div>' +

      '<div class="card" style="margin-top:18px;box-shadow:none"><div class="card-head"><h3>Consent & Data Subject Rights</h3>' +
      '<span class="badge ' + (s.consent && s.consent.granted ? 'ok' : 'err') + '">' +
      (s.consent && s.consent.granted ? 'Consent granted' : 'Consent missing') + '</span></div>' +
      '<div class="card-body small muted">' +
      'Scope: ' + esc((s.consent && s.consent.scope) || '—') + ' · Recorded: ' + esc((s.consent && s.consent.ts) || 'never') +
      '<div class="flex gap-8" style="margin-top:14px">' +
      '<button class="btn btn-sm ' + (s.consent && s.consent.granted ? 'btn-ghost' : 'btn-primary') + '" onclick="App.setConsent(\'' + s.id + '\',' +
      (!(s.consent && s.consent.granted)) + ')">' + (s.consent && s.consent.granted ? 'Revoke consent' : 'Grant consent') + '</button>' +
      '<button class="btn btn-sm btn-ghost" onclick="App.verifyJump(\'' + s.apaar_id + '\')">Verify & issue credential →</button>' +
      '</div></div></div>' +

      '<div class="flex gap-8" style="margin-top:16px">' +
      issueChipsFor(s) +
      '</div>' +
      '</div>'
    );
  }

  function field(lbl, val, mono, raw) {
    return '<div class="stat-line"><span class="muted">' + esc(lbl) + '</span>' +
      (raw ? '<span>' + raw + '</span>' : '<b class="' + (mono ? 'mono' : '') + '">' + esc(val == null || val === '' ? '—' : val) + '</b>') + '</div>';
  }

  function issueChipsFor(s) {
    var mine = S.issues.filter(function (i) { return i.apaar_id === s.apaar_id || i.student_id === s.id; });
    if (!mine.length) return '<span class="badge ok">✓ All validation checks pass for this record</span>';
    return mine.map(function (i) {
      return '<span class="badge ' + (i.severity === 'error' ? 'err' : 'warn') + '">' + i.code + ' — ' + esc(i.message.slice(0, 70)) + '</span>';
    }).join('');
  }

  App.setConsent = function (id, granted) {
    api('/api/consent', { method: 'POST', body: { student_id: id, granted: granted } }).then(function (d) {
      toast(granted ? 'Consent granted' : 'Consent revoked', 'Audit entry recorded', 'ok');
      App.closeModal();
      openStudent(d.student);
    }).catch(function (e) { toast('Consent update failed', e.message, 'err'); });
  };

  App.verifyJump = function (apaar) {
    App.closeModal();
    go('verify');
    setTimeout(function () {
      var inp = $('#verify-input');
      if (inp) { inp.value = apaar; doVerify(); }
    }, 240);
  };

  /* ================= upload =============================================== */
  function viewUpload() {
    var progP = S.programmes.length ? Promise.resolve(S.programmes) : api('/api/programmes').then(function (d) { S.programmes = d.programmes; return d.programmes; });
    progP.then(function () {
      var single =
        '<div class="card"><div class="card-head"><h3>Single Record</h3>' +
        '<span class="tag-repo">validated server-side before commit</span></div>' +
        '<div class="card-body">' +
        '<form id="up-form" class="form-grid">' +
        '<div class="field"><label>APaar ID (12 digits)</label><input class="input mono-input" name="apaar_id" placeholder="12 2024 10042 7" required maxlength="12"></div>' +
        '<div class="field"><label>Enrolment No.</label><input class="input mono-input" name="enrolment_no" placeholder="127/2024/001" required></div>' +
        '<div class="field"><label>Student Name</label><input class="input" name="name" required></div>' +
        '<div class="field"><label>Date of Birth</label><input class="input" type="date" name="dob" required></div>' +
        '<div class="field"><label>Gender</label><select class="input" name="gender"><option>M</option><option>F</option><option>Other</option></select></div>' +
        '<div class="field"><label>Category</label><select class="input" name="category"><option>General</option><option>OBC</option><option>SC</option><option>ST</option><option>EWS</option></select></div>' +
        '<div class="field"><label>Programme</label><select class="input" name="programme_id">' +
        S.programmes.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + ' — ' + esc(p.institution_id) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>Admission Date</label><input class="input" type="date" name="admission_date" value="2024-07-15" required></div>' +
        '<div class="field"><label>Seat Type</label><select class="input" name="seat_type" id="up-seat">' +
        ['Regular', 'Supernumerary', 'NRI', 'OCI', 'ForeignNational'].map(function (t) { return '<option>' + t + '</option>'; }).join('') + '</select></div>' +
        '<div class="field"><label>Nationality</label><input class="input" name="nationality" value="Indian"></div>' +
        '<div class="field"><label>Email</label><input class="input" type="email" name="email" placeholder="student@college.edu.in"></div>' +
        '<div class="field"><label>Mobile (10 digits)</label><input class="input mono-input" name="phone" maxlength="10"></div>' +
        '<div class="field full hide" id="oci-row"><label>OCI Card No. (required for OCI seats)</label><input class="input mono-input" name="oci_card_no"></div>' +
        '<div class="field full hide" id="pp-row"><label>Passport No. (required for Foreign National seats)</label><input class="input mono-input" name="passport_no"></div>' +
        '<div class="field full"><label class="center gap-8" style="font-weight:600"><input type="checkbox" name="consent" checked> Student consent obtained for AICTE repository + authorized verification</label></div>' +
        '<div class="full flex gap-8"><button type="button" class="btn btn-ghost" onclick="App.previewRecord()">Validate only</button>' +
        '<button type="submit" class="btn btn-primary">Submit record</button></div>' +
        '</form><div id="up-result" style="margin-top:16px"></div>' +
        '</div></div>';

      var bulk =
        '<div class="card"><div class="card-head"><h3>Bulk Batch Upload</h3>' +
        '<div class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="App.downloadTemplate()">⤓ Template CSV</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="App.fillSample()">Fill sample rows</button></div></div>' +
        '<div class="card-body">' +
        '<div class="dropzone" id="dz"><div class="ic">⬆</div><b>Drop a CSV file here or click to browse</b>' +
        '<span>Columns: apaar_id, name, dob, gender, category, programme_id, enrolment_no, admission_year, admission_date, seat_type, nationality</span></div>' +
        '<input type="file" id="dz-file" accept=".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values" class="hide">' +
        '<div id="file-summary"></div>' +
        '<div class="field" style="margin-top:14px"><label>…or paste rows (one JSON object per line, or CSV with header)</label>' +
        '<textarea class="input" id="bulk-text" placeholder=\'{"apaar_id":"122024100427","name":"Aditi Sharma","dob":"2004-04-12","gender":"F","category":"General","programme_id":"PRG-127-1","enrolment_no":"127/2024/401","admission_year":2024,"admission_date":"2024-07-15","seat_type":"Regular","nationality":"Indian"}\'></textarea></div>' +
        '<div class="flex gap-8" style="margin-top:12px"><button class="btn btn-primary" onclick="App.runBulk()">Run validation & upload</button>' +
        '<button class="btn btn-ghost" onclick="App.clearBulk()">Clear</button></div>' +
        '<div id="bulk-preview" style="margin-top:16px"></div>' +
        '<div id="bulk-result" style="margin-top:16px"></div>' +
        '</div></div>';

      $('#content').innerHTML = '<div class="upload-grid">' + single + bulk + '</div>';

      $('#up-seat').addEventListener('change', function () {
        $('#oci-row').classList.toggle('hide', this.value !== 'OCI');
        $('#pp-row').classList.toggle('hide', this.value !== 'ForeignNational');
      });
      // APAAR field: allow pasting pretty IDs from elsewhere in the app —
      // keep only digits (maxlength raised so paste is not truncated first).
      var apIn = $('#up-form [name=apaar_id]');
      apIn.setAttribute('maxlength', '24');
      apIn.addEventListener('input', function () {
        var d = apIn.value.replace(/\D/g, '').slice(0, 12);
        if (apIn.value !== d) apIn.value = d;
      });
      $('#up-form').addEventListener('submit', function (e) { e.preventDefault(); App.submitRecord(false); });

      // drag & drop
      var dz = $('#dz'), dzFile = $('#dz-file');
      dz.addEventListener('click', function () { dzFile.click(); });
      dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', function () { dz.classList.remove('over'); });
      dz.addEventListener('drop', function (e) {
        e.preventDefault(); dz.classList.remove('over');
        if (e.dataTransfer.files[0]) readBulkFile(e.dataTransfer.files[0]);
      });
      dzFile.addEventListener('change', function () { if (this.files[0]) readBulkFile(this.files[0]); });
      // Live preview: re-parse as rows are pasted or edited so column and
      // quoting problems surface *before* the batch is committed.
      var bulkT;
      $('#bulk-text').addEventListener('input', function () {
        clearTimeout(bulkT);
        bulkT = setTimeout(function () { renderBulkPreview(); }, 220);
      });
      renderBulkPreview();
    }).catch(failContent);
  }

  function formToObj(form) {
    var o = {};
    new FormData(form).forEach(function (v, k) { o[k] = v; });
    o.admission_year = parseInt((o.admission_date || '').slice(0, 4), 10) || undefined;
    o.consent = { granted: !!form.querySelector('[name=consent]').checked, ts: new Date().toISOString(), scope: 'AICTE+EmployerVerification' };
    if (!o.oci_card_no) delete o.oci_card_no;
    if (!o.passport_no) delete o.passport_no;
    return o;
  }

  App.previewRecord = function () {
    var rec = formToObj($('#up-form'));
    api('/api/validate', { method: 'POST', body: { record: rec } }).then(function (d) {
      var html = '<div class="badge ' + (d.ok ? 'ok' : 'err') + '" style="font-size:13px;padding:7px 14px">' +
        (d.ok ? '✓ Record passes all validation rules' : '✕ Validation failed — fix errors before submitting') + '</div>' +
        '<div class="small muted" style="margin:10px 0 4px">APAAR check: <b class="mono">' +
        (d.apaar.valid ? 'VALID' : d.apaar.errors.join('; ')) + '</b></div>' +
        findingsHtml(d.findings);
      $('#up-result').innerHTML = html;
    }).catch(function (e) { toast('Validation error', e.message, 'err'); });
  };

  App.submitRecord = function (force) {
    var rec = formToObj($('#up-form'));
    api('/api/students', { method: 'POST', body: { student: rec, force: !!force } }).then(function (d) {
      var errs = (d.findings || []).filter(function (f) { return f.severity === 'error'; });
      $('#up-result').innerHTML = '<div class="badge ok" style="font-size:13px;padding:7px 14px">✓ Saved to the AICTE central repository</div>' +
        findingsHtml(d.findings || []);
      toast('Record committed', prettyApaar(d.student.apaar_id) + ' · ' + (errs.length ? errs.length + ' advisory finding(s)' : 'all checks passed'), 'ok');
      refreshIssuesCache();
    }).catch(function (e) {
      if (e.status === 422 && e.data && e.data.findings) {
        $('#up-result').innerHTML = '<div class="badge err" style="font-size:13px;padding:7px 14px">✕ Blocked by validation — ' +
          e.data.findings.filter(function (f) { return f.severity === 'error'; }).length + ' error(s)</div>' + findingsHtml(e.data.findings) +
          '<div style="margin-top:10px"><button class="btn btn-dark btn-sm" onclick="App.submitRecord(true)">Override & commit anyway (audited)</button></div>';
        toast('Validation blocked commit', 'Review findings below', 'err');
      } else toast('Upload failed', e.message, 'err');
    });
  };

  function findingsHtml(findings) {
    if (!findings || !findings.length) return '<div class="small muted" style="margin-top:8px">No findings.</div>';
    return '<div style="margin-top:12px">' + findings.map(function (f) {
      return '<div class="issue ' + f.severity + '"><span class="code">' + f.code + '</span>' +
        '<div><div class="msg">' + esc(f.message) + '</div>' +
        (f.field ? '<div class="meta"><span>field: <b>' + esc(f.field) + '</b></span></div>' : '') + '</div></div>';
    }).join('') + '</div>';
  }

  var SAMPLE_ROWS = [
    { apaar_id: '122024204007', name: 'Test Bulk One', dob: '2004-02-10', gender: 'F', category: 'OBC', programme_id: 'PRG-127-1', enrolment_no: '127/2024/901', admission_year: 2024, admission_date: '2024-07-16', seat_type: 'Regular', nationality: 'Indian' },
    { apaar_id: '122024204007', name: 'Duplicate APAAR Row', dob: '2004-05-11', gender: 'M', category: 'General', programme_id: 'PRG-127-2', enrolment_no: '127/2024/902', admission_year: 2024, admission_date: '2024-07-16', seat_type: 'Regular', nationality: 'Indian' },
    { apaar_id: '99887766', name: 'Bad APAAR Row', dob: '2003-09-01', gender: 'F', category: 'SC', programme_id: 'PRG-127-4', enrolment_no: '127/2024/903', admission_year: 2024, admission_date: '2024-07-16', seat_type: 'Regular', nationality: 'Indian' },
    { apaar_id: '122024204025', name: 'OCI Missing Card', dob: '2003-12-22', gender: 'F', category: 'General', programme_id: 'PRG-127-1', enrolment_no: '127/2024/904', admission_year: 2024, admission_date: '2024-07-16', seat_type: 'OCI', nationality: 'Indian' }
  ];
  App.fillSample = function () {
    $('#bulk-text').value = SAMPLE_ROWS.map(function (r) { return JSON.stringify(r); }).join('\n');
    toast('Sample loaded', '2 valid rows + 3 crafted anomalies', 'ok');
  };
  App.clearBulk = function () {
    $('#bulk-text').value = '';
    $('#bulk-result').innerHTML = '';
    $('#bulk-preview').innerHTML = '';
    var fs = $('#file-summary'); if (fs) fs.innerHTML = '';
    var fi = $('#dz-file'); if (fi) fi.value = '';
  };

  App.downloadTemplate = function () {
    var head = ['apaar_id', 'name', 'dob', 'gender', 'category', 'programme_id', 'enrolment_no',
                'admission_year', 'admission_date', 'seat_type', 'nationality', 'email', 'phone', 'consent'];
    var sample = ['122024100427', 'Aditi Sharma', '2004-04-12', 'F', 'General', 'PRG-127-1', '127/2024/401',
                  '2024', '2024-07-15', 'Regular', 'Indian', 'aditi.sharma@college.edu.in', '9876543210', 'yes'];
    // BOM keeps Excel from mangling the 12-digit APAAR id as a number.
    var csv = '\uFEFF' + head.join(',') + '\n' + sample.join(',') + '\n';
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'apaar-student-upload-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Template downloaded', 'Fill it in, then drop it on the box above', 'ok');
  };

  function readBulkFile(file) {
    var rd = new FileReader();
    rd.onload = function () {
      $('#bulk-text').value = rd.result;
      var n = -1;
      try { n = recordsFromText(rd.result).length; } catch (e) { n = -1; }
      renderFileSummary(file, n);
      renderBulkPreview();
      toast('File loaded', file.name + (n > 0 ? ' · ' + n + ' row' + (n === 1 ? '' : 's') : ''), 'ok');
    };
    rd.readAsText(file);
  }

  /* RFC-4180 CSV reader: honours quoted fields, doubled quotes (""),
     embedded commas/newlines, CRLF, UTF-8 BOM and tab-delimited exports. */
  function readCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
    var delim = ',';
    var firstLine = (text.split(/\r?\n/)[0] || '');
    if (firstLine.indexOf('\t') > -1 && firstLine.indexOf(',') === -1) delim = '\t';
    var rows = [], row = [], cell = '', inQ = false, i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cell += ch; i++; continue;
      }
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === delim) { row.push(cell); cell = ''; i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += ch; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // drop fully-empty trailing rows (common in spreadsheet exports)
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  var KNOWN_COLS = ['apaar_id', 'name', 'dob', 'gender', 'category', 'programme_id', 'enrolment_no',
    'admission_year', 'admission_date', 'seat_type', 'nationality', 'email', 'phone',
    'oci_card_no', 'passport_no', 'institute_sc_no', 'status', 'consent', 'consent_granted'];
  var REQUIRED_COLS = ['apaar_id', 'name', 'dob', 'gender', 'category', 'programme_id', 'enrolment_no', 'seat_type'];
  var CONSENT_TRUE = /^(1|true|yes|y|granted)$/i;

  function recordsFromText(text) {
    var t = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!t) return [];
    if (t[0] === '[') {
      var j = JSON.parse(t);
      return Array.isArray(j) ? j : (j.records || [j]);
    }
    var lines = t.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    // JSON-lines: one JSON object per line
    if (lines[0] && lines[0].trim()[0] === '{') {
      return lines.map(function (ln) { return JSON.parse(ln); });
    }
    var table = readCsv(t);
    if (!table.length) return [];
    var head = table.shift().map(function (h) { return String(h).trim(); });
    return table.map(function (cells) {
      var o = {};
      head.forEach(function (h, i) {
        if (!h) return;
        o[h] = cells[i] == null ? '' : String(cells[i]).trim();
      });
      // numeric fields must reach the API as numbers, not strings
      ['admission_year', 'phone'].forEach(function (k) {
        if (o[k] !== undefined && o[k] !== '') o[k] = /^\d+$/.test(o[k]) ? Number(o[k]) : o[k];
      });
      // Consent (requirement 8): spreadsheets record it as yes/true/1. The bulk
      // endpoint reads consent_granted, so normalise either column name into it
      // — otherwise every CSV row trips CONSENT-001 on import.
      var consentRaw = o.consent_granted !== undefined && o.consent_granted !== '' ? o.consent_granted : o.consent;
      if (consentRaw !== undefined && consentRaw !== '') {
        o.consent_granted = CONSENT_TRUE.test(String(consentRaw).trim());
      }
      delete o.consent;
      if (o.admission_year === undefined || o.admission_year === '') {
        var y = parseInt((o.admission_date || '').slice(0, 4), 10);
        o.admission_year = isNaN(y) ? undefined : y;
      }
      return o;
    });
  }

  function parseBulk(text) { return recordsFromText(text); }

  // File chip: name, size, parsed row/column counts, and column health.
  function renderFileSummary(file, rowCount) {
    var host = $('#file-summary');
    if (!host) return;
    var kb = (file.size / 1024);
    var head = [], missing = [], unknown = [];
    try {
      var t = String($('#bulk-text').value || '').replace(/^\uFEFF/, '').trim();
      if (t && t[0] !== '[' && t[0] !== '{') {
        var table = readCsv(t);
        if (table.length) {
          head = table.shift().map(function (h) { return String(h).trim(); });
        }
      }
    } catch (e) { /* summary is best-effort */ }
    if (head.length) {
      missing = REQUIRED_COLS.filter(function (c) { return head.indexOf(c) < 0; });
      unknown = head.filter(function (c) { return KNOWN_COLS.indexOf(c) < 0; });
    }
    host.innerHTML =
      '<div class="card" style="margin-top:12px;box-shadow:none"><div class="card-body" style="padding:14px">' +
      '<div class="flex gap-8 wrap" style="align-items:center">' +
      '<span class="badge ok">⤒ ' + esc(file.name) + '</span>' +
      '<span class="badge neutral">' + kb.toFixed(1) + ' KB</span>' +
      (rowCount >= 0 ? '<span class="badge ok">' + rowCount + ' row' + (rowCount === 1 ? '' : 's') + ' parsed</span>' : '<span class="badge err">Could not parse file</span>') +
      (head.length ? '<span class="badge neutral">' + head.length + ' columns</span>' : '') +
      '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="App.clearBulk()">Remove</button>' +
      '</div>' +
      (missing.length ? '<div class="small" style="margin-top:8px;color:var(--red,#e5484d)"><b>Missing required columns:</b> ' + esc(missing.join(', ')) + '</div>' : '') +
      (unknown.length ? '<div class="small muted" style="margin-top:6px">Ignored unknown columns: ' + esc(unknown.join(', ')) + '</div>' : '') +
      '</div></div>';
  }

  // Parse-on-type preview: first rows + per-row APAAR check, pre-submit.
  function renderBulkPreview() {
    var host = $('#bulk-preview');
    if (!host) return;
    var raw = String($('#bulk-text').value || '');
    if (!raw.trim()) { host.innerHTML = ''; return; }
    var rows;
    try { rows = parseBulk(raw); }
    catch (e) {
      host.innerHTML = '<div class="issue error"><span class="code">PARSE</span><div><div class="msg">' +
        esc(e.message) + '</div><div class="meta"><span>Use CSV with a header row, one JSON object per line, or a JSON array.</span></div></div></div>';
      return;
    }
    if (!rows.length) { host.innerHTML = ''; return; }
    var cols = KNOWN_COLS.filter(function (c) { return rows[0][c] !== undefined; });
    var shown = rows.slice(0, 5);
    var html =
      '<div class="card" style="box-shadow:none"><div class="card-head"><h3>Preview — first ' + shown.length + ' of ' + rows.length + ' rows</h3>' +
      '<span class="badge neutral">not uploaded yet</span></div><div class="card-body" style="padding-top:6px">' +
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '<th>APAAR check</th></tr></thead><tbody>' +
      shown.map(function (r) {
        var id = String(r.apaar_id || '').replace(/\D/g, '');
        var okId = /^\d{12}$/.test(id);
        return '<tr>' + cols.map(function (c) {
          var v = r[c];
          if (c === 'apaar_id' && v) v = prettyApaar(String(v).replace(/\D/g, '').length === 12 ? String(v).replace(/\D/g, '') : v);
          return '<td class="small' + (c === 'apaar_id' || c === 'enrolment_no' ? ' mono' : '') + '">' + esc(v === undefined || v === '' ? '—' : v) + '</td>';
        }).join('') +
        '<td>' + (okId ? '<span class="badge ok">✓ format</span>' : '<span class="badge err">✕ 12 digits</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="small muted" style="margin-top:10px">Nothing is sent until you press <b>Run validation &amp; upload</b>. Rejected rows are reported per row with the rule code.</div>' +
      '</div></div>';
    host.innerHTML = html;
  }

  App.runBulk = function () {
    var rows;
    try { rows = parseBulk($('#bulk-text').value); }
    catch (e) { toast('Could not parse input', 'Use JSON lines, a JSON array, or CSV with header', 'err'); return; }
    if (!rows.length) { toast('Nothing to upload', 'Paste rows or load the sample first', 'warn'); return; }
    api('/api/students/bulk', { method: 'POST', body: { records: rows } }).then(function (d) {
      $('#bulk-result').innerHTML =
        '<div class="flex gap-8"><span class="badge ok">' + d.accepted + ' accepted</span>' +
        '<span class="badge ' + (d.rejected ? 'err' : 'neutral') + '">' + d.rejected + ' rejected</span></div>' +
        '<div class="table-wrap" style="margin-top:12px"><table class="tbl"><thead><tr><th>#</th><th>APaar</th><th>Name</th><th>Result</th><th>Findings</th></tr></thead><tbody>' +
        d.results.map(function (r) {
          return '<tr><td class="num">' + r.row + '</td><td class="mono small">' + esc(prettyApaar(r.apaar_id || '')) + '</td>' +
            '<td>' + esc(r.name || '—') + '</td>' +
            '<td>' + (r.status === 'accepted' ? '<span class="badge ok">accepted</span>' : '<span class="badge err">rejected</span>') + '</td>' +
            '<td class="small">' + (r.findings.length ? r.findings.map(function (f) {
              return '<span class="badge ' + (f.severity === 'error' ? 'err' : 'warn') + '" title="' + esc(f.message) + '">' + f.code + '</span>';
            }).join(' ') : '<span class="muted">—</span>') + '</td></tr>' +
            (r.findings.length ? '<tr><td></td><td colspan="4" class="small muted" style="padding-top:0">' +
              r.findings.map(function (f) { return esc(f.message); }).join(' · ') + '</td></tr>' : '');
        }).join('') + '</tbody></table></div>';
      toast('Batch processed', d.accepted + ' accepted, ' + d.rejected + ' rejected', d.rejected ? 'warn' : 'ok');
      refreshIssuesCache();
    }).catch(function (e) { toast('Bulk upload failed', e.message, 'err'); });
  };

  /* ================= validation center ==================================== */
  function viewValidation() {
    api('/api/issues').then(function (d) {
      S.issues = d.issues;
      renderShell(); // refresh badge counts
      $$('#sidebar [data-go]').forEach(function (el) { el.classList.toggle('active', el.dataset.go === 'validation'); });

      var errs = d.issues.filter(function (i) { return i.severity === 'error'; });
      var warns = d.issues.filter(function (i) { return i.severity === 'warning'; });
      var byCode = {};
      d.issues.forEach(function (i) { (byCode[i.code] = byCode[i.code] || []).push(i); });
      var codeMeta = {
        'DUP-001': ['Duplicate APAAR within institution', 'err'],
        'DUP-002': ['Cross-institution duplicate enrolment', 'err'],
        'APAAR-001': ['Invalid / missing APAAR ID', 'err'],
        'APAAR-002': ['APAAR year vs admission mismatch', 'err'],
        'INTAKE-001': ['Enrolment exceeds approved intake + SN', 'err'],
        'INTAKE-002': ['Above intake, within SN headroom', 'warn'],
        'INTAKE-003': ['Quota seat cap exceeded (SN/NRI/OCI/FN)', 'err'],
        'DATA-001': ['Missing mandatory fields', 'err'],
        'DATA-002': ['Inconsistent data (nationality, dates, contacts)', 'warn'],
        'ENR-001': ['Duplicate enrolment number', 'err'],
        'CONSENT-001': ['Student consent not on file (requirement 8)', 'warn']
      };

      var chips = Object.keys(byCode).sort().map(function (c) {
        return '<span class="chip active" data-code="' + c + '">' + c + ' · ' + byCode[c].length + '</span>';
      }).join(' ');

      $('#content').innerHTML =
        '<div class="kpis">' +
        kpi('Errors', fmt(errs.length), 'block repository commit', '⛔', 'red') +
        kpi('Warnings', fmt(warns.length), 'flagged for institution review', '⚠', 'gold') +
        kpi('Rule Coverage', Object.keys(byCode).length + '/11', 'detection rules firing', '⛨', 'green') +
        kpi('Cross-Institution Dupes', fmt((S.dash && S.dash.kpis && S.dash.kpis.cross_institution_dupes) || 0), 'same APAAR at 2+ institutions', '⇄', '') +
        '</div>' +

        '<div class="card"><div class="card-head"><h3>Rules Currently Firing</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="App.go(\'overview\')">← Back to overview</button></div>' +
        '<div class="card-body"><div class="flex gap-8 wrap">' + (chips || '<span class="badge ok">All 11 rules passing</span>') + '</div></div></div>' +

        cardHTML('Detailed Findings (' + d.issues.length + ')',
          '<div id="val-list">' + (d.issues.length ? d.issues.map(issueHtml).join('') :
            '<div class="empty"><div class="ic">✓</div><b>No anomalies</b>Every record passed all 11 validation rules.</div>') + '</div>');

      $$('#val-list .issue').forEach(function (el) { el.addEventListener('click', function () {
        var id = el.dataset.student; if (id) App.studentModal(id);
      }); el.style.cursor = el.dataset.student ? 'pointer' : 'default'; });
    }).catch(failContent);
  }

  function issueHtml(i) {
    var meta = [];
    if (i.apaar_id) meta.push('APAAR ' + prettyApaar(i.apaar_id));
    if (i.institution_id) meta.push(i.institution_id);
    if (i.programme_id) meta.push(i.programme_id);
    meta.push(i.kind === 'aggregate' ? 'programme aggregate' : 'record check');
    return '<div class="issue ' + i.severity + '" data-student="' + esc(i.student_id || '') + '">' +
      '<span class="code">' + i.code + '</span>' +
      '<div><div class="msg">' + esc(i.message) + '</div>' +
      '<div class="meta">' + meta.map(function (m) { return '<span>' + esc(m) + '</span>'; }).join('') + '</div></div></div>';
  }

  function refreshIssuesCache() {
    api('/api/issues').then(function (d) { S.issues = d.issues; renderShell(); }).catch(function () {});
  }

  /* ================= verify =============================================== */
  function viewVerify() {
    var isVerifier = S.user.role === 'VERIFIER';
    $('#content').innerHTML =
      '<div class="card"><div class="card-head"><h3>' + (isVerifier ? 'Credential Verification' : 'APAAR Lookup & Credential Issuance') + '</h3>' +
      '<span class="badge info live"><span class="dot"></span>HMAC-SHA256 signed</span></div>' +
      '<div class="card-body">' +
      '<div class="flex gap-8">' +
      '<div class="searchbox" style="flex:1;margin-left:0"><span>⌕</span>' +
      '<input id="verify-input" class="mono" placeholder="12 2024 10042 7 — spaces or raw digits both fine" maxlength="24" inputmode="numeric"></div>' +
      '<button class="btn btn-primary" onclick="App.verify()">Verify</button>' +
      '<button class="btn btn-ghost" onclick="App.pickRandom()">Try a record</button>' +
      '</div>' +
      '<div class="small muted" style="margin-top:10px">Public mode checks format + check digit only. Authorized roles retrieve the full signed record, credential and verification receipt.</div>' +
      '</div></div>' +
      '<div id="verify-result"></div>';

    // accept pretty IDs pasted from the students table ("12 2021 20201 4"):
    // maxlength is deliberately > 12 so the paste is not truncated, and we
    // strip every non-digit on input so only the 12 digits survive.
    var vin = $('#verify-input');
    vin.addEventListener('input', function () {
      var digits = vin.value.replace(/\D/g, '').slice(0, 12);
      if (vin.value !== digits) vin.value = digits;
    });
    vin.addEventListener('keydown', function (e) { if (e.key === 'Enter') doVerify(); });
    if (S.lastVerify) renderVerify(S.lastVerify);
  }

  App.verify = doVerify;
  App.verifyJump = App.verifyJump;
  App.pickRandom = function () {
    api('/api/students?per=1').then(function (d) {
      if (d.students && d.students[0]) { $('#verify-input').value = d.students[0].apaar_id; doVerify(); }
    }).catch(function () { toast('Server unreachable', null, 'err'); });
  };

  function doVerify() {
    var id = ($('#verify-input').value || '').replace(/\D/g, '');
    if (!/^\d{12}$/.test(id)) { toast('Enter a 12-digit APAAR ID', 'Format: 12 2024 10042 7', 'warn'); return; }
    var box = $('#verify-result');
    box.innerHTML = '<div class="sk" style="height:320px"></div>';
    api('/api/verify', { method: 'POST', body: { apaar_id: id } }).then(function (d) {
      S.lastVerify = d;
      renderVerify(d);
      refreshIssuesCache();
    }).catch(function (e) {
      box.innerHTML = '<div class="verify-hero invalid"><div class="bg-ic">✕</div><h2>Verification unavailable</h2>' +
        '<div class="sub">' + esc(e.message) + '</div></div>';
    });
  }

  function renderVerify(d) {
    var box = $('#verify-result'); if (!box) return;
    if (!d.found) {
      box.innerHTML = '<div class="verify-hero invalid"><div class="bg-ic">✕</div>' +
        '<h2>✗ ' + (d.error ? 'Invalid APAAR ID' : 'No record found') + '</h2>' +
        '<div class="apaar-no">' + esc(prettyApaar(d.apaar_id || '')) + '</div>' +
        '<div class="sub">' + esc(d.message || (d.errors || []).join(' · ')) + '</div></div>';
      toast('Verification failed', d.message || (d.errors || [])[0], 'err');
      return;
    }
    var s = d.student;
    var multi = (d.all_records || []).length > 1;
    box.innerHTML =
      '<div class="verify-hero verified"><div class="bg-ic">✓</div>' +
      '<h2>✓ Record Verified — Signature Valid</h2>' +
      '<div class="apaar-no">' + esc(prettyApaar(s.apaar_id)) + '</div>' +
      '<div class="sub">' + esc(s.name) + ' · verified by ' + esc(d.verified_by.name) + ' (' + esc(roleLabel(d.verified_by.role)) + ') · ' + esc(d.verified_at) + '</div>' +
      '<div class="cred-grid">' +
      cell('Programme', s.programme_name) +
      cell('Institution', s.institution_name) +
      cell('Enrolment No.', s.enrolment_no) +
      cell('Admission Year', s.admission_year) +
      cell('Category / Seat', (s.category || '') + ' · ' + (s.seat_type || '')) +
      cell('Record Status', s.status) +
      '</div></div>' +

      (multi ? '<div class="card" style="border-color:#f8c8d5"><div class="card-body center gap-12"><span style="font-size:22px">⚠</span>' +
        '<div class="small"><b>' + d.all_records.length + ' enrolment records share this APAAR ID.</b><br>' +
        d.all_records.map(function (r) { return esc(r.institution_name) + ' — ' + esc(r.programme_name) + ' (' + esc(r.enrolment_no) + ')'; }).join('<br>') +
        '</div></div></div>' : '') +

      '<div class="split">' +
      cardHTML('Signed Verifiable Credential (W3C-style VC)',
        '<div class="proof-box">' + esc(JSON.stringify(d.credential, null, 2).slice(0, 1400)) + (JSON.stringify(d.credential).length > 1400 ? '\n…' : '') + '</div>' +
        '<div class="flex gap-8" style="margin-top:12px"><span class="badge ' + (d.signature_valid ? 'ok' : 'err') + '">' +
        (d.signature_valid ? '✓ HMAC signature authentic' : '✕ signature mismatch') + '</span>' +
        '<span class="badge neutral">' + esc(d.credential.issuer) + '</span></div>',
        '<button class="btn btn-ghost btn-sm" onclick="App.copyCred()">Copy JSON</button>') +
      cardHTML('Certificate Preview — APAAR + Enrolment ID',
        certHtml(s, d),
        '<button class="btn btn-gold btn-sm" onclick="window.print()">⎙ Print certificate</button>') +
      '</div>';
    toast('Verified', s.name + ' — signature valid', 'ok');
  }
  function cell(l, v) { return '<div class="cred-cell"><div class="lbl">' + esc(l) + '</div><div class="val">' + esc(v == null ? '—' : v) + '</div></div>'; }

  /* Deterministic 21x21 module pattern (QR Model-2 style) derived from the
     APAAR id + signature. Not a scannable QR — a tamper-evident visual digest
     that changes whenever the underlying credential changes. */
  function certMatrix(seed, n) {
    var h = 2166136261; // FNV-1a
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    var rnd = function () { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
    var m = [], r, c;
    for (r = 0; r < n; r++) { m[r] = []; for (c = 0; c < n; c++) m[r][c] = rnd() > 0.5 ? 1 : 0; }
    var finder = function (or_, oc) { // 7x7 position marker with quiet ring
      for (r = 0; r < 7; r++) for (c = 0; c < 7; c++) {
        var edge = (r === 0 || r === 6 || c === 0 || c === 6);
        var core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[or_ + r][oc + c] = (edge || core) ? 1 : 0;
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (r = 8; r < n - 8; r++) { m[6][r] = r % 2 === 0 ? 1 : 0; m[r][6] = r % 2 === 0 ? 1 : 0; } // timing
    return m;
  }

  function certHtml(s, d) {
    var sig = (d.credential && d.credential.proof && d.credential.proof.proofValue) || d.verified_at || '';
    var verifyUrl = 'apaar.aicte.org.in/v/' + s.apaar_id;
    var n = 21, m = certMatrix(s.apaar_id + sig, n), cells = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
      if (m[r][c]) cells += '<i style="grid-area:' + (r + 1) + '/' + (c + 1) + '"></i>';
    return '' +
      '<div class="cert" id="cert-mini">' +
        '<div class="tricolor"></div>' +
        '<div class="cert-inner">' +
          '<div class="cert-emblem">\uD83C\uDDEE\uD83C\uDDF3</div>' + // 🇮🇳
          '<div class="cert-org">ALL COUNCIL FOR TECHNICAL EDUCATION</div>' +
          '<h3>Certificate of Enrolment</h3>' +
          '<div class="cert-rule"><span></span><b>\u2726</b><span></span></div>' +
          '<div class="cert-lead">This is to certify that</div>' +
          '<div class="who-name">' + esc(s.name) + '</div>' +
          '<div class="cert-lead">is enrolled in the</div>' +
          '<div class="cert-prog">' + esc(s.programme_name) + '</div>' +
          '<div class="cert-lead">programme at <b>' + esc(s.institution_name) + '</b>, an AICTE-approved institution,' +
            ' with effect from the academic year <b>' + esc(s.admission_year) + '</b>.</div>' +
          '<div class="ids">' +
            '<div class="id-box"><div class="lbl">APAAR ID</div><div class="num">' + esc(prettyApaar(s.apaar_id)) + '</div></div>' +
            '<div class="id-box"><div class="lbl">Enrolment No.</div><div class="num">' + esc(s.enrolment_no) + '</div></div>' +
          '</div>' +
          '<div class="cert-foot">' +
            '<div class="sign"><div class="line"></div><span>Registrar</span><em>' + esc(s.institution_name) + '</em></div>' +
            '<div class="cert-seal">' +
              '<div class="seal-ring"><span>AICTE</span><b>\u2726</b><span>VERIFIED</span></div>' +
            '</div>' +
            '<div class="sign"><div class="line"></div><span>Controller of Examinations</span><em>' + esc((d.verified_at || '').slice(0, 10)) + '</em></div>' +
          '</div>' +
          '<div class="cert-verify">' +
            '<div class="qr">' + cells + '</div>' +
            '<div class="cert-verify-txt"><b>Scan or visit</b>' +
              '<code>' + esc(verifyUrl) + '</code>' +
              '<span>Credential ' + ((d.signature_valid) ? 'carries a valid HMAC signature' : 'signature could not be validated') +
              ' · Issued ' + esc(d.verified_at || '') + '</span></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  App.copyCred = function () {
    if (!S.lastVerify || !S.lastVerify.credential) return;
    navigator.clipboard.writeText(JSON.stringify(S.lastVerify.credential, null, 2))
      .then(function () { toast('Credential copied', 'Paste into any VC wallet / verifier', 'ok'); })
      .catch(function () { toast('Copy failed', 'Select from the proof box manually', 'err'); });
  };

  /* ================= reports ============================================== */
  function viewReports() {
    var dash = S.dash;
    var p = dash ? Promise.resolve(dash) : api('/api/dashboard').then(function (d) { S.dash = d; return d; });
    p.then(function (d) {
      var k = d.kpis;
      $('#content').innerHTML =
        '<div class="split">' +
        cardHTML('Enrolment Monitoring Report',
          '<div class="stat-line"><span>Institutions covered</span><b>' + k.institutions + '</b></div>' +
          '<div class="stat-line"><span>Programmes</span><b>' + k.programmes + '</b></div>' +
          '<div class="stat-line"><span>Total student records</span><b>' + fmt(k.students_total) + '</b></div>' +
          '<div class="stat-line"><span>Approved intake (+ SN)</span><b>' + fmt(k.intake_with_sn) + '</b></div>' +
          '<div class="stat-line"><span>National utilisation</span><b>' + k.utilisation + '%</b></div>' +
          '<div class="stat-line"><span>APAAR validity</span><b>' + k.apaar_valid_pct + '%</b></div>' +
          '<div class="stat-line"><span>Consent coverage</span><b>' + k.consent_granted_pct + '%</b></div>' +
          '<div style="margin-top:16px" class="flex gap-8">' +
          '<a class="btn btn-primary btn-sm" href="/api/reports/enrolment.csv" target="_blank" onclick="App.auditPing()">⤓ Enrolment CSV</a>' +
          '<a class="btn btn-ghost btn-sm" href="/api/records.csv" target="_blank" onclick="App.auditPing()">⤓ Full records CSV</a>' +
          '</div>') +
        cardHTML('State-wise Enrolment',
          '<canvas class="chart" id="ch-state"></canvas>') +
        '</div>' +
        cardHTML('Governance Indicators (policy / accreditation use)',
          '<div class="split-3">' +
          ['Intake vs Enrolment', 'Data Completeness', 'Identity Integrity'].map(function (t, i) {
            var vals = [[k.utilisation, 'seats filled vs sanctioned'], [k.apaar_valid_pct, 'records with valid APAAR'], [k.consent_granted_pct, 'records with consent']];
            return '<div><div class="small muted bold" style="margin-bottom:8px">' + t + '</div>' +
              '<canvas class="chart gauge" data-v="' + vals[i][0] + '" data-l="' + vals[i][1] + '"></canvas></div>';
          }).join('') + '</div>');

      Charts.hbar($('#ch-state'), d.charts.by_state.slice(0, 8).map(function (x) {
        return { label: x.label, value: x.value, display: fmt(x.value) };
      }), { labelW: 110, rowH: 32 });

      $$('#content canvas.gauge').forEach(function (cv) {
        Charts.gauge(cv, parseFloat(cv.dataset.v), { label: cv.dataset.l, height: 140 });
      });
    }).catch(failContent);
  }
  App.auditPing = function () { toast('Export started', 'Audit entry recorded for this download', 'ok'); };

  /* ================= audit ================================================ */
  function viewAudit() {
    api('/api/audit').then(function (d) {
      var color = { LOGIN: 'info', VERIFY: 'ok', BULK_UPLOAD: 'warn', STUDENT_CREATE: 'ok', STUDENT_UPDATE: 'info', CONSENT_UPDATE: 'gold', REPORT_EXPORT: 'neutral', SEED: 'neutral' };
      $('#content').innerHTML = cardHTML('System Activity Log (' + d.audit.length + ' events)',
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>Time (UTC)</th><th>Actor</th><th>Role</th><th>Action</th><th>Detail</th></tr></thead><tbody>' +
        d.audit.map(function (a) {
          return '<tr><td class="mono small" style="white-space:nowrap">' + esc((a.ts || '').replace('T', ' ').slice(0, 19)) + '</td>' +
            '<td><b>' + esc(a.actor) + '</b></td>' +
            '<td><span class="badge neutral">' + esc((a.role || '').replace('_', ' ')) + '</span></td>' +
            '<td><span class="badge ' + (color[a.action] || 'neutral') + '">' + esc(a.action) + '</span></td>' +
            '<td class="small">' + esc(a.detail) + '</td></tr>';
        }).join('') + '</tbody></table></div>');
    }).catch(failContent);
  }

  /* ================= modal & misc ========================================= */
  App.closeModal = function () {
    var m = $('#modal-host');
    if (m) { m.innerHTML = ''; m.className = ''; }
  };
  function openModal(html) {
    var m = $('#modal-host');
    m.className = 'modal-bg';
    m.innerHTML = '<div class="modal">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) App.closeModal(); });
  }

  function failContent(e) {
    var c = $('#content');
    if (c) c.innerHTML = '<div class="empty"><div class="ic">⚠</div><b>Could not load data</b>' +
      esc(e && e.message ? e.message : 'Server unreachable') +
      '<div style="margin-top:14px"><button class="btn btn-ghost btn-sm" onclick="App.go(App.view)">Retry</button></div></div>';
  }

  App.go = go;
  App.logout = logout;
  App.view = null;
  Object.defineProperty(App, 'view', { get: function () { return S.view; } });

  /* ================= boot ================================================= */
  function boot() {
    // login screen wiring
    $$('.role-pill').forEach(function (p) {
      p.addEventListener('click', function () {
        $$('.role-pill').forEach(function (x) { x.classList.remove('active'); });
        p.classList.add('active');
        $('#f-user').value = ROLE_PRESET[p.dataset.role];
        $('#f-pass').value = 'demo123';
        $('#f-user').focus();
      });
    });
    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      login($('#f-user').value.trim(), $('#f-pass').value);
    });
    $('#menu-btn').addEventListener('click', function () {
      var open = $('#sidebar').classList.toggle('open');
      $('#sidebar-scrim').classList.toggle('on', open);
    });
    // Dismiss the slide-in nav by tapping the dimmed backdrop or pressing Escape.
    $('#sidebar-scrim').addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    if (S.token && S.user) {
      api('/api/me').then(function (d) { S.user = d.user; enterPortal(); refreshIssuesCache(); })
        .catch(function () { logout(true); });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
