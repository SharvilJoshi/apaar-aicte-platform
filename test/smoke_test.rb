# frozen_string_literal: true

# AICTE × APAAR platform — API smoke test.
#
#   ruby lib/server.rb &          # start the server (port 8787)
#   ruby test/smoke_test.rb       # run this file (exit 0 = all green)
#
# Zero dependencies: uses only the Ruby standard library plus the platform's
# own APAAR generator to mint valid test identifiers. The test creates two
# student records (enrolment nos. prefixed SMOKE/) in the demo database.

require 'json'
require 'net/http'
require 'uri'
require_relative '../lib/apaar'

BASE = ENV['BASE_URL'] || 'http://127.0.0.1:8787'
$pass = 0
$fail = 0

def check(label, cond, detail = nil)
  if cond
    $pass += 1
    puts "  ok   #{label}"
  else
    $fail += 1
    puts "  FAIL #{label}#{detail ? " — #{detail}" : ''}"
  end
end

def req(method, path, body: nil, token: nil)
  uri = URI.join(BASE, path)
  http = Net::HTTP.new(uri.host, uri.port)
  request = (method == :post ? Net::HTTP::Post : Net::HTTP::Get).new(uri)
  request['auth_token'] = token if token
  if body
    request['Content-Type'] = 'application/json'
    request.body = JSON.generate(body)
  end
  res = http.request(request)
  parsed = begin
    res.body.to_s.empty? ? {} : JSON.parse(res.body)
  rescue StandardError
    { 'raw' => res.body.to_s }
  end
  [res.code.to_i, parsed]
end

def login(user)
  code, d = req(:post, '/api/auth/login', body: { 'username' => user, 'password' => 'demo123' })
  raise "login failed for #{user} (#{code})" unless code == 200
  d['token']
end

def group(id) # "12 2025 10042 7" style display form
  "#{id[0, 2]} #{id[2, 4]} #{id[6, 5]} #{id[11, 1]}"
end

puts "\n== AICTE x APAAR platform smoke test (#{BASE}) =="

admin = login('aicte.admin')
inst  = login('cope.pune')
ver   = login('employer.demo')
check 'login: admin, institution and verifier roles authenticate', !admin.nil? && !inst.nil? && !ver.nil?

_, d = req(:post, '/api/auth/login', body: { 'username' => 'aicte.admin', 'password' => 'wrong' })
check 'auth: bad password rejected', d['error'].to_s != ''

code, = req(:get, '/api/dashboard')
check 'auth: unauthenticated dashboard returns 401', code == 401

code, d = req(:get, '/api/dashboard', token: admin)
k = d['kpis'] || {}
check 'dashboard: repository holds thousands of records', (k['students_total'] || 0) >= 9000,
      "students_total=#{k['students_total']}"
check 'dashboard: three admission years on file', (d.dig('charts', 'by_year') || []).size >= 3
check 'dashboard: rule engine reports errors and warnings', k['issues_error'].to_i >= 1 && k['issues_warning'].to_i >= 1

# ---- a real APAAR from the repository: verify canonical + copy-pasted spaced --
_, s = req(:get, '/api/students?per=1', token: admin)
real = (s['students'] || []).first || {}
apaar = real['apaar_id'].to_s
check 'students: listing returns a record with a 12-digit APAAR', apaar.length == 12, "apaar=#{apaar.inspect}"

code, v = req(:post, '/api/verify', body: { 'apaar_id' => apaar }, token: ver)
check 'verify: canonical APAAR found with a valid HMAC credential',
      code == 200 && v['found'] == true && v['signature_valid'] == true,
      "code=#{code} found=#{v['found']} sig=#{v['signature_valid']}"

code, v2 = req(:post, '/api/verify', body: { 'apaar_id' => group(apaar) }, token: ver)
check 'verify: copy-pasted SPACED APAAR still found (normalisation)', code == 200 && v2['found'] == true,
      "queried #{group(apaar).inspect}"

_, unknown = req(:post, '/api/verify', body: { 'apaar_id' => Apaar.generate(institution_slot: 99, year: 2025, sequence: 999) }, token: ver)
check 'verify: unknown-but-valid APAAR reports not found', unknown['found'] == false

# ---- create / update (APAAR-keyed upsert, requirement 1) ---------------------
# resolve real programme ids from the master (ids embed the institute code)
_, pl = req(:get, '/api/programmes', token: admin)
progs = pl['programmes'] || []
coep_prog   = progs.find { |p| p['institution_id'] == 'INS-127' }
foreign_prog = progs.find { |p| p['institution_id'] != 'INS-127' }

test_apaar  = Apaar.generate(institution_slot: 99, year: 2025, sequence: 901)
test_apaar2 = Apaar.generate(institution_slot: 99, year: 2025, sequence: 902)
new_rec = {
  'apaar_id' => test_apaar, 'institution_id' => 'INS-127', 'programme_id' => coep_prog['id'],
  'name' => 'Smoke Test Student', 'dob' => '2005-05-05', 'gender' => 'F', 'category' => 'General',
  'nationality' => 'Indian', 'seat_type' => 'Regular', 'enrolment_no' => 'SMOKE/2025/901',
  'admission_year' => 2025, 'admission_date' => '2025-07-15',
  'email' => 'smoke@example.edu.in', 'phone' => '9876543210', 'consent' => { 'granted' => true }
}

# first post uses the SPACED display form: upload must normalise it too
code, d = req(:post, '/api/students', body: new_rec.merge('apaar_id' => group(test_apaar)), token: admin)
check 'upload: spaced APAAR accepted and stored canonically',
      code == 200 && d.dig('student', 'apaar_id') == test_apaar,
      "code=#{code} stored=#{d.dig('student', 'apaar_id').inspect}"

code, d = req(:post, '/api/students', body: new_rec, token: admin)
check 'upload: re-post of same APAAR UPDATES instead of duplicating', code == 200 && d['updated'] == true,
      "code=#{code} updated=#{d['updated']}"

_, s1 = req(:get, "/api/students?q=#{test_apaar}", token: admin)
check 'upload: exactly one row exists for the test APAAR', (s1['students'] || []).size == 1

# ---- validation rules --------------------------------------------------------
bad = new_rec.merge('apaar_id' => Apaar.generate(institution_slot: 99, year: 2025, sequence: 903),
                    'enrolment_no' => 'SMOKE/2025/903')
bad['apaar_id'] = bad['apaar_id'][0, 11] + ((bad['apaar_id'][11].to_i + 5) % 10).to_s # corrupt check digit
code, d = req(:post, '/api/students', body: bad, token: admin)
check 'rule APAAR-001: corrupt check digit rejected', code == 422 && (d['findings'] || []).any? { |f| f['code'] == 'APAAR-001' },
      "code=#{code}"

xinst = new_rec.merge('apaar_id' => Apaar.generate(institution_slot: 99, year: 2025, sequence: 904),
                      'enrolment_no' => 'SMOKE/2025/904', 'programme_id' => foreign_prog['id'])
code, d = req(:post, '/api/students', body: xinst, token: admin)
check 'rule DATA-001: programme of ANOTHER institution blocked',
      code == 422 && (d['findings'] || []).any? { |f| f['code'] == 'DATA-001' }, "code=#{code}"

# find the seeded overflow cohort, then try to add one more student to it
_, dash = req(:get, '/api/issues', token: admin)
full = (dash['issues'] || []).find { |i| i['code'] == 'INTAKE-001' }
if full
  prog_id = full['programme_id']
  yr = full['message'][/(\d{4}) cohort/, 1].to_i
  prog = progs.find { |p| p['id'] == prog_id }
  over = new_rec.merge('apaar_id' => Apaar.generate(institution_slot: 99, year: yr, sequence: 905),
                       'enrolment_no' => "SMOKE/#{yr}/905", 'programme_id' => prog_id,
                       'institution_id' => prog['institution_id'],
                       'admission_year' => yr, 'admission_date' => "#{yr}-07-15")
  code, d = req(:post, '/api/students', body: over, token: admin)
  check "rule INTAKE-001: admission into the full #{yr} cohort blocked",
        code == 422 && (d['findings'] || []).any? { |f| f['code'] == 'INTAKE-001' }, "code=#{code}"
else
  check 'rule INTAKE-001: seeded overflow cohort present', false, 'no INTAKE-001 issue in seed data'
end

code, d = req(:post, '/api/students', body: new_rec.merge('consent' => nil), token: admin)
warns = (d['findings'] || []).select { |f| f['code'] == 'CONSENT-001' }
check 'rule CONSENT-001: missing consent commits with a warning', code == 200 && warns.size == 1,
      "code=#{code} warns=#{warns.size}"

# dry-run (validate-only) of an existing record must not flag itself as a duplicate
code, v = req(:post, '/api/validate', body: new_rec, token: admin)
apaar_findings = (v['findings'] || []).select { |f| f['code'].start_with?('APAAR') || f['code'].start_with?('DUP') }
check 'dry-run: existing record validates clean (no self-duplicate)', code == 200 && v['ok'] == true && apaar_findings.empty?,
      "code=#{code} ok=#{v['ok']} findings=#{apaar_findings.map { |f| f['code'] }.join(',')}"

# ---- bulk upload --------------------------------------------------------------
batch = {
  'records' => [
    new_rec.merge('apaar_id' => test_apaar2, 'enrolment_no' => 'SMOKE/2025/902', 'name' => 'Bulk Accepted'),
    new_rec.merge('apaar_id' => test_apaar2, 'enrolment_no' => 'SMOKE/2025/902B', 'name' => 'Bulk Dupe In Batch')
  ]
}
code, d = req(:post, '/api/students/bulk', body: batch, token: admin)
check 'bulk: 1 accepted + in-batch duplicate rejected', code == 200 && d['accepted'] == 1 && d['rejected'] == 1,
      "code=#{code} accepted=#{d['accepted']} rejected=#{d['rejected']}"

# ---- RBAC ---------------------------------------------------------------------
code, = req(:post, '/api/students', body: new_rec, token: ver)
check 'RBAC: verifier cannot upload student records', code == 403, "code=#{code}"

_, vl = req(:get, '/api/students?per=5', token: ver)
vrec = (vl['students'] || []).first || {}
check 'RBAC: verifier listing is PII-redacted (no email/phone/address)',
      vrec.any? && !vrec.key?('email') && !vrec.key?('phone') && !vrec.key?('address')

code, = req(:get, '/api/students', token: 'bogus-token')
check 'RBAC: forged token rejected', code == 401, "code=#{code}"

# ---- exports / audit -----------------------------------------------------------
code, d = req(:get, '/api/records.csv', token: admin)
csv = d['raw'].to_s
check 'export: CSV streams header + one row per record', code == 200 && csv.lines.size > 9000 && csv.start_with?('APAAR,'),
      "code=#{code} lines=#{csv.lines.size}"

code, d = req(:get, '/api/audit', token: admin)
check 'audit: uploads, verifications and exports recorded', code == 200 && (d['audit'] || []).size > 3

puts "\n#{$pass} passed, #{$fail} failed"
exit($fail.zero? ? 0 : 1)
