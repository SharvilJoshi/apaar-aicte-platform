# frozen_string_literal: true

require 'webrick'
require 'time'
require 'json'
require 'digest'
require 'openssl'
require 'securerandom'
require 'cgi'
require_relative 'store'
require_relative 'apaar'
require_relative 'validation'

module AparServer
  # Port resolution order: CLI argument (local habit: `ruby server.rb 8788`),
  # then PORT from the environment (PaaS platforms such as Render inject it),
  # then the local default.
  PORT = (ARGV[0] || ENV['PORT'] || 8787).to_i
  # PaaS routers reach the app over the container network, so production must
  # bind 0.0.0.0 (BIND_ADDR=0.0.0.0). Default stays loopback-only for local use.
  BIND_ADDR = (ENV['BIND_ADDR'] || '127.0.0.1')
  PUBLIC = File.expand_path('../public', __dir__)
  SESSION_TTL = 8 * 3600

  store = Store.new
  sessions = {} # token => { 'user' => {...minus password}, 'exp' => Time }
  sessions_mutex = Mutex.new

  # ---- helpers ---------------------------------------------------------------
  json_body = lambda do |req|
    raw = req.body
    raw = raw.read if raw.respond_to?(:read) # IO-like adapters
    JSON.parse(raw.to_s)
  rescue StandardError
    {}
  end

  # token may arrive as X-Auth-Token header, auth_token header, or ?auth_token=
  # query param (query param is required for browser <a href> CSV downloads,
  # which cannot set request headers). The query string is read straight off the
  # request URI rather than req.query, because WEBrick's req.query parses the
  # body for POST requests and drops the URL params when content-type is JSON.
  token_from = lambda do |req|
    header = req['auth_token'] || req['X-Auth-Token']
    return header if header
    qs = req.request_uri&.query.to_s
    return nil if qs.empty?
    pair = qs.split('&').find { |kv| kv.split('=').first == 'auth_token' }
    pair && !pair.split('=')[1].to_s.empty? ? CGI.unescape(pair.split('=', 2).last) : nil
  end

  current_user = lambda do |req|
    tok = token_from.call(req)
    sessions_mutex.synchronize do
      s = tok && sessions[tok]
      return nil unless s
      if s['exp'] < Time.now
        sessions.delete(tok)
        return nil
      end
      s['user']
    end
  end

  require_role = lambda do |req, *roles|
    u = current_user.call(req)
    return [401, { 'error' => 'Authentication required' }] unless u
    return [403, { 'error' => 'Forbidden for role' }] unless roles.empty? || roles.include?(u['role'])
    u
  end

  send_json = lambda do |res, code, payload|
    res.status = code
    res['Content-Type'] = 'application/json'
    res['Cache-Control'] = 'no-store'
    res.body = JSON.generate(payload)
  end

  # scope a student list by the caller's role
  scope_students = lambda do |u, list|
    if u['role'] == 'INSTITUTION'
      list.select { |s| s['institution_id'] == u['institution_id'] }
    else
      list
    end
  end

  # VERIFIER (employer / regulator) sees academic identity only — no contact or
  # document extras. Same field set that POST /api/verify returns, so the two
  # paths agree. AICTE_ADMIN and INSTITUTION keep the full record.
  VERIFIER_HIDDEN = %w[email phone address oci_card_no passport_no].freeze
  redact_for_verifier = lambda do |u, rec|
    return rec unless u['role'] == 'VERIFIER'
    rec.reject { |k, _| VERIFIER_HIDDEN.include?(k) }
  end

  # Build the full issue list (single-record + aggregate intake rules)
  recompute_issues = lambda do
    all = store.students
    progs = store.programmes
    prog_idx = progs.each_with_object({}) { |p, h| h[p['id'].to_s] = p }
    index = Validation.build_index(all)
    issues = []
    all.each do |st|
      Validation.check_record(st, index, prog_idx, st['institution_id']).each do |r|
        issues << { 'code' => r.code, 'severity' => r.severity.to_s, 'message' => r.message,
                    'field' => r.field, 'apaar_id' => r.apaar_id,
                    'institution_id' => r.institution_id, 'programme_id' => r.programme_id,
                    'student_id' => st['id'], 'kind' => 'record' }
      end
    end
    Validation.check_intake(all.select { |s| s['status'] != 'Withdrawn' }, progs).each do |r|
      issues << { 'code' => r.code, 'severity' => r.severity.to_s, 'message' => r.message,
                  'field' => r.field, 'apaar_id' => nil,
                  'institution_id' => r.institution_id, 'programme_id' => r.programme_id,
                  'student_id' => nil, 'kind' => 'aggregate' }
    end
    store.replace_issues!(issues)
    issues
  end

  # ---- analytics -------------------------------------------------------------
  analytics = lambda do |u|
    students = scope_students.call(u, store.students)
    progs    = store.programmes.select { |p| u['role'] != 'INSTITUTION' || p['institution_id'] == u['institution_id'] }
    insts    = u['role'] == 'INSTITUTION' ? store.institutions.select { |i| i['id'] == u['institution_id'] } : store.institutions

    active = students.select { |s| s['status'] == 'Active' }
    issues = store.issues.select { |i| u['role'] != 'INSTITUTION' || i['institution_id'] == u['institution_id'] }

    by_year = Hash.new(0)
    students.each { |s| by_year[s['admission_year']] += 1 }

    by_cat = Hash.new(0)
    active.each { |s| by_cat[s['category'] || 'Unknown'] += 1 }

    by_seat = Hash.new(0)
    active.each { |s| by_seat[s['seat_type'] || 'Regular'] += 1 }

    by_state = Hash.new(0)
    insts.each do |i|
      n = students.count { |s| s['institution_id'] == i['id'] }
      by_state[i['state']] += n
    end

    total_intake = progs.sum { |p| p['approved_intake'].to_i }
    total_sn     = progs.sum { |p| p['supernumerary_cap'].to_i }
    enrolled     = active.size
    # Approved intake is sanctioned per academic year, so utilisation compares
    # the CURRENT admission cycle's active cohort against one year's capacity
    # (students_total / students_active stay repository-wide figures).
    latest_year  = students.map { |s| s['admission_year'] }.compact.max
    cohort_now   = active.select { |s| s['admission_year'] == latest_year }.size

    inst_rows = insts.map do |i|
      st = students.select { |s| s['institution_id'] == i['id'] && s['status'] == 'Active' }
      st_now = st.select { |s| s['admission_year'] == latest_year }
      iprogs = progs.select { |p| p['institution_id'] == i['id'] }
      intake = iprogs.sum { |p| p['approved_intake'].to_i + p['supernumerary_cap'].to_i }
      iss = issues.count { |x| x['institution_id'] == i['id'] }
      {
        'id' => i['id'], 'name' => i['name'], 'state' => i['state'], 'city' => i['city'],
        'approved' => iprogs.size, 'intake' => intake, 'enrolled' => st_now.size,
        'utilisation' => intake.zero? ? 0 : ((st_now.size.to_f / intake) * 100).round(1),
        'issues' => iss,
        'apaar_coverage' => st.empty? ? 100 : ((st.count { |x| Apaar.validate(x['apaar_id'])[:valid] }.to_f / st.size) * 100).round(1)
      }
    end.sort_by { |r| -r['issues'] }

    top_issues = issues.group_by { |i| i['code'] }
                       .map { |c, l| { 'code' => c, 'count' => l.size,
                                       'severity' => l.first['severity'],
                                       'sample' => l.first['message'] } }
                       .sort_by { |h| -h['count'] }

    dupes = Validation.duplicate_apaars(students)

    {
      'kpis' => {
        'institutions' => insts.size,
        'programmes' => progs.size,
        'students_total' => students.size,
        'students_active' => enrolled,
        'intake_approved' => total_intake,
        'intake_with_sn' => total_intake + total_sn,
        'utilisation' => (total_intake + total_sn).zero? ? 0 : ((cohort_now.to_f / (total_intake + total_sn)) * 100).round(1),
        'apaar_valid_pct' => students.empty? ? 0 : ((students.count { |s| Apaar.validate(s['apaar_id'])[:valid] }.to_f / students.size) * 100).round(1),
        'issues_error' => issues.count { |i| i['severity'] == 'error' },
        'issues_warning' => issues.count { |i| i['severity'] == 'warning' },
        'cross_institution_dupes' => dupes.size,
        'consent_granted_pct' => students.empty? ? 0 : ((students.count { |s| s.dig('consent', 'granted') }.to_f / students.size) * 100).round(1)
      },
      'charts' => {
        'by_year' => by_year.sort.map { |k, v| { 'label' => k.to_s, 'value' => v } },
        'by_category' => by_cat.map { |k, v| { 'label' => k, 'value' => v } },
        'by_seat' => by_seat.map { |k, v| { 'label' => k, 'value' => v } },
        'by_state' => by_state.sort_by { |_, v| -v }.map { |k, v| { 'label' => k, 'value' => v } }
      },
      'institutions_table' => inst_rows,
      'top_issues' => top_issues,
      'dupes' => dupes
    }
  end

  # ---- verifiable credential -------------------------------------------------
  build_credential = lambda do |student, opts = {}|
    inst = store.find_institution(student['institution_id'])
    prog = store.find_programme(student['programme_id'])
    core = {
      'id' => "urn:uuid:#{SecureRandom.uuid}",
      'type' => ['VerifiableCredential', 'AICTEStudentRecordCredential'],
      'issuer' => store.settings['issuer_did'],
      'issuanceDate' => Time.now.utc.iso8601,
      'credentialSubject' => {
        'id' => "urn:apaar:#{student['apaar_id']}",
        'apaarId' => student['apaar_id'],
        'apaarPretty' => Apaar.pretty(student['apaar_id']),
        'name' => student['name'],
        'dateOfBirth' => student['dob'],
        'gender' => student['gender'],
        'category' => student['category'],
        'nationality' => student['nationality'],
        'seatType' => student['seat_type'],
        'instituteSCNo' => student['institute_sc_no'],
        'enrolmentNo' => student['enrolment_no'],
        'institution' => { 'id' => student['institution_id'], 'name' => inst && inst['name'] },
        'programme' => { 'id' => student['programme_id'], 'name' => prog && prog['name'] },
        'admissionYear' => student['admission_year'],
        'status' => student['status']
      }
    }
    canonical = JSON.generate(core)
    sig = OpenSSL::HMAC.hexdigest('SHA256', store.settings['hmac_secret'], canonical)
    core.merge('proof' => {
                 'type' => 'HmacSHA256',
                 'created' => Time.now.utc.iso8601,
                 'verificationMethod' => "#{store.settings['issuer_did']}#hmac-key",
                 'proofPurpose' => 'assertionMethod',
                 'proofValue' => sig
               }, 'signature_input' => canonical)
  end

  # ==========================================================================
  # HTTP server
  # ==========================================================================
  server = WEBrick::HTTPServer.new(
    Port: PORT,
    BindAddress: BIND_ADDR,
    AccessLog: [],
    Logger: WEBrick::Log.new($stderr, WEBrick::Log::WARN)
  )

  json_route = lambda do |req, res, &blk|
    res['Cache-Control'] = 'no-store'
    blk.call(req, res)
  end

  # ---- POST /api/auth/login --------------------------------------------------
  server.mount_proc '/api/auth/login' do |req, res|
    body = json_body.call(req)
    user = store.users.find { |u| u['username'] == body['username'] && u['password'] == body['password'] }
    unless user
      send_json.call(res, 401, { 'error' => 'Invalid username or password' })
      next
    end
    token = SecureRandom.hex(24)
    pub = user.reject { |k, _| k == 'password' }
    sessions_mutex.synchronize { sessions[token] = { 'user' => pub, 'exp' => Time.now + SESSION_TTL } }
    store.log_audit(user['username'], user['role'], 'LOGIN', "User #{user['name']} signed in")
    send_json.call(res, 200, { 'token' => token, 'user' => pub })
  end

  server.mount_proc '/api/auth/logout' do |req, res|
    tok = token_from.call(req)
    sessions_mutex.synchronize { sessions.delete(tok) }
    send_json.call(res, 200, { 'ok' => true })
  end

  server.mount_proc '/api/me' do |req, res|
    u = current_user.call(req)
    u ? send_json.call(res, 200, { 'user' => u }) : send_json.call(res, 401, { 'error' => 'Not signed in' })
  end

  # ---- dashboard -------------------------------------------------------------
  server.mount_proc '/api/dashboard' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    next send_json.call(res, u.is_a?(Array) ? u.first : 401, u.is_a?(Array) ? u.last : {}) unless u.is_a?(Hash)
    recompute_issues.call if store.issues.empty?
    send_json.call(res, 200, analytics.call(u))
  end

  server.mount_proc '/api/issues' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    recompute_issues.call if store.issues.empty?
    scope = store.issues.select { |i| u['role'] != 'INSTITUTION' || i['institution_id'] == u['institution_id'] }
    send_json.call(res, 200, { 'issues' => scope })
  end

  # ---- institutions ----------------------------------------------------------
  server.mount_proc '/api/institutions' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    list = u['role'] == 'INSTITUTION' ? store.institutions.select { |i| i['id'] == u['institution_id'] } : store.institutions
    send_json.call(res, 200, { 'institutions' => list.map { |i| i.reject { |k, _| k == 'api_key' } } })
  end

  server.mount_proc '/api/programmes' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    list = store.programmes
    list = list.select { |p| p['institution_id'] == u['institution_id'] } if u['role'] == 'INSTITUTION'
    send_json.call(res, 200, { 'programmes' => list })
  end

  # ---- students --------------------------------------------------------------
  server.mount_proc '/api/students' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION', 'VERIFIER')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    if req.request_method == 'GET'
      q = (req.query['q'] || '').downcase
      # Users paste grouped IDs ("12 2021 20201 4") copied from the table;
      # also keep a digits-only form so APAAR matching ignores grouping.
      q_digits = q.gsub(/\D/, '')
      inst_f = req.query['institution_id']
      prog_f = req.query['programme_id']
      status_f = req.query['status']
      list = scope_students.call(u, store.students)
      list = list.select { |s| s['institution_id'] == inst_f } if !inst_f.to_s.empty? && u['role'] == 'AICTE_ADMIN'
      list = list.select { |s| s['programme_id'] == prog_f } unless prog_f.to_s.empty?
      list = list.select { |s| s['status'] == status_f } unless status_f.to_s.empty?
      unless q.empty?
        list = list.select do |s|
          [s['name'], s['apaar_id'], s['enrolment_no'], s['institute_sc_no']].compact.any? { |v| v.downcase.include?(q) } ||
            (!q_digits.empty? && s['apaar_id'].to_s.include?(q_digits))
        end
      end
      list = list.sort_by { |s| s['name'].to_s }
      page = (req.query['page'] || 1).to_i
      per  = (req.query['per'] || 12).to_i
      total = list.size
      slice = list[((page - 1) * per), per] || []
      slice = slice.map { |s| redact_for_verifier.call(u, s) } if u['role'] == 'VERIFIER'
      send_json.call(res, 200, { 'students' => slice, 'total' => total, 'page' => page, 'per' => per })
    elsif req.request_method == 'POST'
      # create / update a single student (institution or admin)
      unless %w[AICTE_ADMIN INSTITUTION].include?(u['role'])
        send_json.call(res, 403, { 'error' => 'Forbidden for role' })
        next
      end
      body = json_body.call(req)
      rec = body['student'] || body
      rec['apaar_id'] = Apaar.normalize(rec['apaar_id'])
      rec['institution_id'] = u['institution_id'] if u['role'] == 'INSTITUTION'
      # resolve programme name
      prog = store.find_programme(rec['programme_id'])
      rec['programme_name'] = prog['name'] if prog
      ins = store.find_institution(rec['institution_id'])
      rec['institution_name'] = ins['name'] if ins

      # APAAR is the unique student identifier (requirement 1): a re-post for the
      # same APAAR + institution is an UPDATE of the existing row, not a new
      # record — otherwise the row would trip DUP-001 against itself.
      existing = store.students.find do |s|
        s['apaar_id'] == rec['apaar_id'] && s['institution_id'] == rec['institution_id']
      end
      is_update = !existing.nil?
      if is_update
        rec['id'] = existing['id']
        rec['created_at'] = existing['created_at']
      else
        rec['id'] ||= "STU-#{SecureRandom.hex(4).upcase}"
        rec['created_at'] ||= Time.now.utc.iso8601
      end
      rec['status'] ||= 'Active'
      rec['consent'] ||= { 'granted' => false, 'ts' => nil, 'scope' => nil }
      rec['updated_at'] = Time.now.utc.iso8601

      before = store.students.dup
      findings = Validation.check_record(rec, before, store.programmes, rec['institution_id'])
      findings += Validation.check_admission(rec, before, store.programmes, rec['institution_id'])
      hard_errors = findings.select { |f| f.severity == :error }
      force = body['force'] == true || req['force'] == 'true'
      if hard_errors.any? && !force
        send_json.call(res, 422, {
                         'error' => 'Validation failed',
                         'findings' => findings.map { |f| { 'code' => f.code, 'severity' => f.severity.to_s, 'message' => f.message, 'field' => f.field } }
                       })
        next
      end
      store.upsert_student(rec)
      store.log_audit(u['username'], u['role'],
                      is_update ? 'STUDENT_UPDATE' : 'STUDENT_CREATE',
                      "APAAR #{Apaar.masked(rec['apaar_id'])} #{rec['name']} (#{rec['enrolment_no']}) — #{findings.size} finding(s)",
                      rec['institution_id'])
      recompute_issues.call
      send_json.call(res, 200, { 'student' => rec, 'updated' => is_update,
                                 'findings' => findings.map { |f| { 'code' => f.code, 'severity' => f.severity.to_s, 'message' => f.message } } })
    elsif req.request_method == 'PUT'
      send_json.call(res, 405, { 'error' => 'Use POST for upsert' })
    end
  end

  # ---- bulk upload -----------------------------------------------------------
  server.mount_proc '/api/students/bulk' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    body = json_body.call(req)
    rows = body['records'] || []
    if rows.empty?
      send_json.call(res, 400, { 'error' => 'No records provided' })
      next
    end
    default_inst = u['role'] == 'INSTITUTION' ? u['institution_id'] : nil
    seen_apaar = {} # first row in this batch owns the APAAR; later rows are dupes
    results = rows.map.with_index do |row, i|
      rec = row.transform_keys(&:to_s)
      rec['apaar_id'] = Apaar.normalize(rec['apaar_id'])
      rec['institution_id'] ||= default_inst
      next { 'row' => i + 1, 'status' => 'rejected', 'findings' => [{ 'code' => 'DATA-001', 'severity' => 'error', 'message' => 'institution_id is required for AICTE-admin uploads' }] } if rec['institution_id'].to_s.empty?

      if seen_apaar.key?(rec['apaar_id'])
        next { 'row' => i + 1, 'apaar_id' => rec['apaar_id'], 'name' => rec['name'], 'status' => 'rejected',
               'findings' => [{ 'code' => 'DUP-001', 'severity' => 'error',
                               'message' => "Duplicate APAAR ID — already used by row #{seen_apaar[rec['apaar_id']]} of this batch" }] }
      end
      seen_apaar[rec['apaar_id']] = i + 1

      prog = store.find_programme(rec['programme_id'])
      rec['programme_name'] = prog['name'] if prog
      ins = store.find_institution(rec['institution_id'])
      rec['institution_name'] = ins && ins['name']
      # APAAR-keyed upsert: a row re-posted for a student already on file at this
      # institution updates that row (requirement 1) instead of tripping DUP-001.
      existing = store.students.find do |s|
        s['apaar_id'] == rec['apaar_id'] && s['institution_id'] == rec['institution_id']
      end
      if existing
        rec['id'] = existing['id']
        rec['created_at'] = existing['created_at']
      else
        rec['id'] ||= "STU-#{SecureRandom.hex(4).upcase}"
        rec['created_at'] ||= Time.now.utc.iso8601
      end
      rec['status'] ||= 'Active'
      rec['consent'] ||= { 'granted' => rec['consent_granted'] == true, 'ts' => Time.now.utc.iso8601, 'scope' => 'AICTE' }
      rec['updated_at'] = Time.now.utc.iso8601

      findings = Validation.check_record(rec, store.students, store.programmes, rec['institution_id']) +
                 Validation.check_admission(rec, store.students, store.programmes, rec['institution_id'])
      errors = findings.select { |f| f.severity == :error }
      if errors.any?
        { 'row' => i + 1, 'apaar_id' => rec['apaar_id'], 'name' => rec['name'], 'status' => 'rejected',
          'findings' => findings.map { |f| { 'code' => f.code, 'severity' => f.severity.to_s, 'message' => f.message } } }
      else
        store.upsert_student(rec, false) # persist once at the end (recompute)
        { 'row' => i + 1, 'apaar_id' => rec['apaar_id'], 'name' => rec['name'], 'status' => 'accepted',
          'findings' => findings.map { |f| { 'code' => f.code, 'severity' => f.severity.to_s, 'message' => f.message } } }
      end
    end
    accepted = results.count { |r| r['status'] == 'accepted' }
    store.log_audit(u['username'], u['role'], 'BULK_UPLOAD',
                    "#{accepted}/#{rows.size} records accepted", u['institution_id'])
    recompute_issues.call
    send_json.call(res, 200, { 'results' => results, 'accepted' => accepted, 'rejected' => results.size - accepted })
  end

  # ---- validate-only (dry run) ----------------------------------------------
  server.mount_proc '/api/validate' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    body = json_body.call(req)
    rec = (body['record'] || body).transform_keys(&:to_s)
    rec['apaar_id'] = Apaar.normalize(rec['apaar_id'])
    rec['institution_id'] ||= u['institution_id']
    apaar_check = Apaar.validate(rec['apaar_id'], admission_year: rec['admission_year'])
    findings = Validation.check_record(rec, store.students, store.programmes, rec['institution_id']) +
               Validation.check_admission(rec, store.students, store.programmes, rec['institution_id'])
    send_json.call(res, 200, {
                     'apaar' => apaar_check,
                     'findings' => findings.map { |f| { 'code' => f.code, 'severity' => f.severity.to_s, 'message' => f.message, 'field' => f.field } },
                     'ok' => findings.none? { |f| f.severity == :error }
                   })
  end

  # ---- national APAAR verification (stakeholders) ----------------------------
  server.mount_proc '/api/verify' do |req, res|
    if req.request_method == 'GET'
      # public quick-check: format + checksum only, no PII
      id = Apaar.normalize(req.query['apaar_id'])
      v = Apaar.validate(id)
      send_json.call(res, 200, {
                       'apaar_id' => id,
                       'format_valid' => v[:valid],
                       'errors' => v[:errors],
                       'hint' => 'Sign in as an authorized stakeholder for record details.'
                     })
      next
    end

    # POST: authorized verification — returns the signed record + credential
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION', 'VERIFIER')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    body = json_body.call(req)
    id = Apaar.normalize(body['apaar_id'])
    v = Apaar.validate(id)
    unless v[:valid]
      send_json.call(res, 200, { 'found' => false, 'apaar' => v, 'error' => 'Invalid APAAR ID' })
      next
    end
    matches = store.students.select { |s| s['apaar_id'] == id }
    if matches.empty?
      store.log_audit(u['username'], u['role'], 'VERIFY', "APAAR #{Apaar.masked(id)} — no record found", nil)
      send_json.call(res, 200, { 'found' => false, 'apaar' => v, 'message' => 'No student record exists for this APAAR ID' })
      next
    end
    # verifier role sees only its own institution-scoped records? No — verifiers
    # (employers/regulators) verify nationally, but PII beyond education is hidden.
    student = matches.max_by { |s| s['updated_at'] }
    credential = build_credential.call(student)
    canonical = credential['signature_input']
    sig = credential['proof']['proofValue']
    signature_valid = OpenSSL::HMAC.hexdigest('SHA256', store.settings['hmac_secret'], canonical) == sig
    credential.delete('signature_input')

    # education-employment visibility policy: VERIFIER sees academic fields only
    visible = if u['role'] == 'VERIFIER'
                student.slice('apaar_id', 'name', 'dob', 'gender', 'programme_name', 'institution_name',
                              'enrolment_no', 'institute_sc_no', 'admission_year', 'status', 'category', 'seat_type')
              else
                student
              end

    store.log_audit(u['username'], u['role'], 'VERIFY',
                    "APAAR #{Apaar.masked(id)} (#{student['name']}) verified — #{matches.size} record(s), signature #{signature_valid ? 'VALID' : 'INVALID'}",
                    student['institution_id'])
    send_json.call(res, 200, {
                     'found' => true,
                     'apaar' => v,
                     'student' => visible,
                     'all_records' => matches.map { |m| m.slice('institution_id', 'institution_name', 'programme_name', 'enrolment_no', 'status') },
                     'credential' => credential,
                     'signature_valid' => signature_valid,
                     'verified_by' => { 'name' => u['name'], 'role' => u['role'] },
                     'verified_at' => Time.now.utc.iso8601
                   })
  end

  # ---- consent ----------------------------------------------------------------
  server.mount_proc '/api/consent' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    body = json_body.call(req)
    st = store.find_student(body['student_id'])
    unless st
      send_json.call(res, 404, { 'error' => 'Student not found' })
      next
    end
    if u['role'] == 'INSTITUTION' && st['institution_id'] != u['institution_id']
      send_json.call(res, 403, { 'error' => 'Record belongs to another institution' })
      next
    end
    st['consent'] = {
      'granted' => body['granted'] == true,
      'ts' => Time.now.utc.iso8601,
      'scope' => body['scope'] || 'AICTE+EmployerVerification'
    }
    st['updated_at'] = Time.now.utc.iso8601
    store.upsert_student(st)
    store.log_audit(u['username'], u['role'], 'CONSENT_UPDATE',
                    "Consent #{st['consent']['granted'] ? 'GRANTED' : 'REVOKED'} for APAAR #{Apaar.masked(st['apaar_id'])}",
                    st['institution_id'])
    send_json.call(res, 200, { 'student' => st })
  end

  # ---- audit trail -------------------------------------------------------------
  server.mount_proc '/api/audit' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    list = store.audit
    list = list.select { |a| a['institution_id'] == u['institution_id'] } if u['role'] == 'INSTITUTION'
    send_json.call(res, 200, { 'audit' => list[0, 200] })
  end

  # ---- reports ------------------------------------------------------------------
  server.mount_proc '/api/reports/enrolment.csv' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    data = analytics.call(u)
    rows = [%w[Institution State City Programmes ApprovedIntake Enrolled UtilisationPct Issues ApaarCoveragePct]]
    data['institutions_table'].each do |r|
      rows << [r['name'], r['state'], r['city'], r['approved'], r['intake'], r['enrolled'],
               r['utilisation'], r['issues'], r['apaar_coverage']]
    end
    csv = rows.map { |r| r.map { |c| c.to_s.include?(',') ? "\"#{c}\"" : c }.join(',') }.join("\n")
    store.log_audit(u['username'], u['role'], 'REPORT_EXPORT', 'Enrolment monitoring CSV exported', nil)
    res.status = 200
    res['Content-Type'] = 'text/csv'
    res['Content-Disposition'] = 'attachment; filename="apaar_enrolment_report.csv"'
    res.body = csv
  end

  server.mount_proc '/api/records.csv' do |req, res|
    u = require_role.call(req, 'AICTE_ADMIN', 'INSTITUTION')
    unless u.is_a?(Hash)
      send_json.call(res, u[0], u[1])
      next
    end
    list = scope_students.call(u, store.students)
    rows = [%w[APAAR Name DOB Gender Category Nationality SeatType Institution Programme EnrolmentNo AdmissionYear Status]]
    list.each do |s|
      rows << [s['apaar_id'], s['name'], s['dob'], s['gender'], s['category'], s['nationality'],
               s['seat_type'], s['institution_name'], s['programme_name'], s['enrolment_no'],
               s['admission_year'], s['status']]
    end
    csv = rows.map { |r| r.map { |c| c.to_s.include?(',') ? "\"#{c}\"" : c }.join(',') }.join("\n")
    store.log_audit(u['username'], u['role'], 'REPORT_EXPORT', "Student records CSV (#{list.size} rows) exported", nil)
    res.status = 200
    res['Content-Type'] = 'text/csv'
    res['Content-Disposition'] = 'attachment; filename="apaar_student_records.csv"'
    res.body = csv
  end

  # ---- static files -----------------------------------------------------------
  server.mount_proc '/' do |req, res|
    path = req.path
    path = '/index.html' if path == '/'
    file = File.expand_path(File.join(PUBLIC, path))
    unless file.start_with?(File.expand_path(PUBLIC)) && File.file?(file)
      # SPA fallback: unknown non-API paths get the portal shell
      shell = File.join(PUBLIC, 'portal.html')
      if File.file?(shell) && !path.start_with?('/api/')
        res.status = 200
        res['Content-Type'] = 'text/html; charset=utf-8'
        res.body = File.read(shell)
        next
      end
      res.status = 404
      res['Content-Type'] = 'application/json'
      res.body = JSON.generate({ 'error' => "Not found: #{path}" })
      next
    end
    res.status = 200
    ext = File.extname(file).downcase
    res['Content-Type'] = case ext
                          when '.html' then 'text/html; charset=utf-8'
                          when '.css' then 'text/css; charset=utf-8'
                          when '.js' then 'application/javascript; charset=utf-8'
                          when '.svg' then 'image/svg+xml'
                          when '.png' then 'image/png'
                          when '.json' then 'application/json'
                          else 'application/octet-stream'
                          end
    res.body = File.binread(file)
  end

  trap('INT') { server.shutdown }
  puts "APAAR Student Data Platform API → http://127.0.0.1:#{PORT}"
  server.start
end
