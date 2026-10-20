# frozen_string_literal: true

require 'json'
require 'fileutils'
require 'time'
require 'securerandom'
require_relative 'apaar'

# Persistent JSON store with seed data. Thread-safe writes via a mutex.
# In production this module is swapped for PostgreSQL + S3 (see ARCHITECTURE.md);
# the interface here (read/insert/update, collection iteration) is intentionally thin.
class Store
  DATA_DIR = File.expand_path('../data', __dir__)
  DB_FILE  = File.join(DATA_DIR, 'db.json')

  def initialize
    @mutex = Mutex.new
    @db = load_or_seed
  end

  # ---- collection accessors -------------------------------------------------
  %i[institutions programmes students users audit issues].each do |name|
    define_method(name) { @db[name.to_s] }
  end

  def settings
    @db['settings']
  end

  def find_student(id)
    students.find { |s| s['id'] == id }
  end

  def find_programme(id)
    programmes.find { |p| p['id'] == id }
  end

  def find_institution(id)
    institutions.find { |i| i['id'] == id }
  end

  # autosave: pass false for bulk inserts and persist once at the end instead
  def upsert_student(rec, autosave = true)
    @mutex.synchronize do
      idx = students.index { |s| s['id'] == rec['id'] }
      if idx
        students[idx] = rec
      else
        rec['id'] ||= "STU-#{SecureRandom.hex(4).upcase}"
        students << rec
      end
      persist if autosave
    end
    rec
  end

  def replace_issues!(list)
    @mutex.synchronize do
      @db['issues'] = list
      persist
    end
  end

  def log_audit(actor, role, action, detail, institution_id = nil)
    @mutex.synchronize do
      audit.unshift({
        'id' => "AUD-#{SecureRandom.hex(4).upcase}",
        'ts' => Time.now.utc.iso8601,
        'actor' => actor, 'role' => role, 'action' => action,
        'detail' => detail, 'institution_id' => institution_id
      })
      @db['audit'] = audit[0, 500] # keep last 500 events
      persist
    end
  end

  # ==========================================================================
  # Seed: 16 AICTE-style institutions, programmes with approved intake, and
  # multi-year admission cohorts (2023-2025) — roughly 11,000 student records.
  # Deliberately injected anomalies (duplicate APAAR across institutions,
  # over-intake cohort, bad check digits, NRI quota overrun, OCI inconsistencies)
  # so the detection engine has something real to find.
  # ==========================================================================
  def load_or_seed
    if File.exist?(DB_FILE)
      begin
        return JSON.parse(File.read(DB_FILE))
      rescue StandardError
        # corrupt file -> reseed
      end
    end
    seed
  end

  def persist
    FileUtils.mkdir_p(DATA_DIR)
    # compact JSON: with 10k+ records the file stays a few MB, so every
    # persist (one per upload/audit event) stays fast
    File.write(DB_FILE, JSON.generate(@db))
  end

  private

  def seed
    rng = Random.new(20261019)

    inst_data = [
      # code, name, state, city, type, established
      [104, 'Indian Institute of Technology Delhi', 'Delhi', 'New Delhi', 'Technical', 1961],
      [127, 'College of Engineering Pune', 'Maharashtra', 'Pune', 'Technical', 1854],
      [233, 'PSG College of Technology', 'Tamil Nadu', 'Coimbatore', 'Technical', 1951],
      [318, 'Manipal Institute of Technology', 'Karnataka', 'Manipal', 'Technical', 1957],
      [412, 'Vishwakarma Institute of Technology', 'Maharashtra', 'Pune', 'Technical', 1983],
      [507, 'Thapar Institute of Engineering & Technology', 'Punjab', 'Patiala', 'Technical', 1956],
      [621, 'Birla Institute of Technology', 'Jharkhand', 'Ranchi', 'Technical', 1964],
      [733, 'Sardar Vallabhbhai National Institute of Technology', 'Gujarat', 'Surat', 'Technical', 1961],
      [801, 'National Institute of Technology Warangal', 'Telangana', 'Warangal', 'Technical', 1971],
      [815, 'Delhi Technological University', 'Delhi', 'New Delhi', 'Technical', 1941],
      [822, 'Amrita Vishwa Vidyapeetham', 'Tamil Nadu', 'Coimbatore', 'Deemed', 1994],
      [839, 'Jadavpur University', 'West Bengal', 'Kolkata', 'University', 1955],
      [846, 'College of Engineering Guindy, Anna University', 'Tamil Nadu', 'Chennai', 'Technical', 1921],
      [858, 'Thiagarajar College of Engineering', 'Tamil Nadu', 'Madurai', 'Technical', 1957],
      [884, 'Symbiosis Institute of Technology', 'Maharashtra', 'Pune', 'Technical', 2008],
      [897, 'Kalinga Institute of Industrial Technology', 'Odisha', 'Bhubaneswar', 'Deemed', 2005]
    ]

    institutions = inst_data.map.with_index do |(code, name, state, city, type, est), i|
      {
        'id' => "INS-#{code}",
        'code' => code,
        'name' => name,
        'state' => state,
        'city' => city,
        'type' => type,
        'established' => est,
        'status' => 'Approved',
        'api_key' => "apk_#{SecureRandom.hex(12)}"
      }
    end

    prog_catalog = [
      # name, level, duration
      ['B.E. Computer Science and Engineering', 'Undergraduate', 4],
      ['B.E. Electronics and Communication Engineering', 'Undergraduate', 4],
      ['B.Tech Information Technology', 'Undergraduate', 4],
      ['B.E. Mechanical Engineering', 'Undergraduate', 4],
      ['B.E. Civil Engineering', 'Undergraduate', 4],
      ['M.Tech Computer Science and Engineering', 'Postgraduate', 2],
      ['MBA', 'Postgraduate', 2]
    ]

    programmes = []
    institutions.each_with_index do |ins, ii|
      prog_catalog.each_with_index do |(pname, level, dur), pi|
        next if (ii + pi) % 4 == 3 # not every institute runs every program

        base = [60, 60, 40, 30, 60, 50, 45][(ii + pi) % 7]
        sn = (base * 0.10).round
        nri = [4, 6, 8][pi % 3]
        fn  = [2, 3, 4][pi % 3]
        programmes << {
          'id' => "PRG-#{ins['code']}-#{pi + 1}",
          'institution_id' => ins['id'],
          'name' => pname,
          'level' => level,
          'duration_years' => dur,
          'approved_intake' => base,
          'supernumerary_cap' => sn,
          'nri_cap' => nri,
          'fn_cap' => fn
        }
      end
    end

    # ---- students ----------------------------------------------------------
    first = %w[Aarav Aditi Rohan Sneha Karthik Ananya Vikram Priya Arjun Meera
               Siddharth Kavya Rahul Nisha Arun Divya Manoj Swathi Nikhil Pooja
               Rakesh Shreya Varun Anjali Imran Fatima Tarun Lakshmi Gaurav Ritika]
    last  = %w[Sharma Gupta Verma Singh Reddy Nair Iyer Patel Joshi Chatterjee
               Banerjee Desai Kulkarni Menon Pillai Rao Das Ghosh Mishra Kapoor]

    students = []
    seq_by_key = Hash.new(0)
    years = [2023, 2024, 2025]
    foreign_nats = %w[Nepali German Emirati American Nigerian]

    # Approved intake is sanctioned PER ACADEMIC YEAR, so students are seeded as
    # one cohort per programme per year -- the same unit validation counts in.
    cohorts = []
    programmes.each_with_index do |prog, pi|
      ins = institutions.find { |i| i['id'] == prog['institution_id'] }
      slot = institutions.index { |i| i['id'] == ins['id'] } + 1

      years.each_with_index do |yr, yi|
        overflow = (pi == 2 && yi == years.length - 1) # one cohort deliberately over intake
        fill   = rng.rand(0.62..1.02)
        target = overflow ? prog['approved_intake'] + prog['supernumerary_cap'] + 9
                          : [((prog['approved_intake'] * fill).round), 8].max

        # seat mix: quota seats stay within that year's sanctioned caps
        sn_seats  = [(target * 0.08).round, prog['supernumerary_cap']].min
        nri_seats = [(target * 0.04).round, prog['nri_cap']].min
        fn_seats  = [(target * 0.03).round, prog['fn_cap']].min
        seat_pool = Array.new(target - sn_seats - nri_seats - fn_seats, 'Regular') +
                    Array.new(sn_seats, 'Supernumerary') +
                    Array.new(nri_seats, 'NRI') +
                    Array.new(fn_seats, rng.rand > 0.5 ? 'OCI' : 'ForeignNational')
        seat_pool.shuffle!(random: rng)

        cohorts << { prog: prog, ins: ins, slot: slot, yr: yr, target: target,
                     seat_pool: seat_pool, overflow: overflow }
      end
    end

    cohorts.each do |c|
      prog, ins, slot, yr, target, seat_pool, overflow =
        [c[:prog], c[:ins], c[:slot], c[:yr], c[:target], c[:seat_pool], c[:overflow]]
      # earlier cohorts have had time to graduate; the newest one is mostly active
      status_mix = if yr == years.first
                     %w[Active Active Graduated Graduated Withdrawn]
                   elsif yr == years[1]
                     %w[Active Active Active Graduated Withdrawn]
                   else
                     %w[Active Active Active Active Active Withdrawn]
                   end

      target.times do |si|
        seq_by_key[[ins['id'], yr]] += 1
        seq = seq_by_key[[ins['id'], yr]]
        apaar = Apaar.generate(institution_slot: slot, year: yr, sequence: seq)
        mo, dy = rng.rand(1..12), rng.rand(1..28)
        seat = seat_pool[si]
        # NRI seats legitimately belong to Indian citizens abroad;
        # OCI/FN seats belong to foreign nationals (validation enforces this).
        nat  = %w[OCI ForeignNational].include?(seat) ? foreign_nats[rng.rand(foreign_nats.length)] : 'Indian'
        dob  = format('%04d-%02d-%02d', yr - rng.rand(17..21), rng.rand(1..12), rng.rand(1..28))
        st = {
          'id' => "STU-#{SecureRandom.hex(4).upcase}",
          'apaar_id' => apaar,
          'name' => "#{first[rng.rand(first.length)]} #{last[rng.rand(last.length)]}",
          'dob' => dob,
          'gender' => %w[M F].sample(random: rng),
          'category' => ['General', 'General', 'OBC', 'OBC', 'SC', 'ST', 'EWS'][rng.rand(7)],
          'nationality' => nat,
          'seat_type' => seat,
          'oci_card_no' => seat == 'OCI' ? "OCI#{rng.rand(100_000..999_999)}" : nil,
          'passport_no' => seat == 'ForeignNational' ? "P#{rng.rand(1000000..9999999)}" : nil,
          'institute_sc_no' => "ISC#{ins['code']}#{rng.rand(10000..99999)}",
          'programme_id' => prog['id'],
          'programme_name' => prog['name'],
          'institution_id' => ins['id'],
          'institution_name' => ins['name'],
          'enrolment_no' => "#{ins['code']}/#{yr}/#{format('%03d', seq)}",
          'admission_year' => yr,
          'admission_date' => format('%04d-%02d-%02d', yr, mo, dy),
          'email' => "#{first[rng.rand(first.length)].downcase}.#{rng.rand(100..999)}@example.edu.in",
          'phone' => rng.rand(60_000_000_00..99_999_999_99).to_s,
          'address' => "#{rng.rand(1..999)}, #{%w[Gandhi Nehru Patel Ambedkar Subhash].sample(random: rng)} Nagar, #{ins['city']}",
          'status' => status_mix[rng.rand(status_mix.length)],
          'consent' => { 'granted' => rng.rand > 0.04, 'ts' => Time.now.utc.iso8601, 'scope' => 'AICTE+EmployerVerification' },
          'created_at' => "#{yr}-#{format('%02d', mo)}-#{format('%02d', dy)}T10:00:00Z",
          'updated_at' => Time.now.utc.iso8601
        }
        st['status'] = 'Active' if overflow # keep the overflow counting
        students << st
      end
    end

    # ---- injected anomalies (so dashboards show real detections) -----------
    # 1) same APAAR enrolled at two institutions (classic cross-institution dupe)
    src = students.find { |s| s['programme_id'].include?('-1') }
    dup = src.dup
    other_ins = institutions.find { |i| i['id'] != src['institution_id'] }
    other_prog = programmes.find { |p| p['institution_id'] == other_ins['id'] && p['name'] == src['programme_name'] } ||
                 programmes.find { |p| p['institution_id'] == other_ins['id'] }
    dup['id'] = "STU-#{SecureRandom.hex(4).upcase}"
    dup['institution_id'] = other_ins['id']
    dup['institution_name'] = other_ins['name']
    dup['programme_id'] = other_prog['id']
    dup['programme_name'] = other_prog['name']
    dup['enrolment_no'] = "#{other_ins['code']}/2024/888"
    dup['name'] = src['name'] + ' (Dup)'
    dup['status'] = 'Active' # keep the cross-institution duplicate visible
    students << dup

    # 2) corrupt check digit
    bad = students[5].dup
    bad['id'] = "STU-#{SecureRandom.hex(4).upcase}"
    bad['apaar_id'] = students[5]['apaar_id'][0, 11] + ((students[5]['apaar_id'][11].to_i + 5) % 10).to_s
    students << bad

    # 3) garbage APAAR (too short) + missing fields
    students << {
      'id' => "STU-#{SecureRandom.hex(4).upcase}", 'apaar_id' => '1220231',
      'name' => 'Incomplete Record', 'dob' => '', 'gender' => 'M', 'category' => 'General',
      'nationality' => 'Indian', 'seat_type' => 'Regular', 'institute_sc_no' => 'ISC12799999',
      'programme_id' => programmes[3]['id'], 'programme_name' => programmes[3]['name'],
      'institution_id' => programmes[3]['institution_id'],
      'institution_name' => institutions.find { |i| i['id'] == programmes[3]['institution_id'] }['name'],
      'enrolment_no' => '127/2024/999', 'admission_year' => 2024, 'admission_date' => '2024-07-01',
      'email' => 'not-an-email', 'phone' => '123', 'address' => '',
      'status' => 'Active', 'consent' => { 'granted' => false, 'ts' => nil, 'scope' => nil },
      'created_at' => Time.now.utc.iso8601, 'updated_at' => Time.now.utc.iso8601
    }

    # 4) NRI seat with Indian nationality + missing OCI card, re-registered
    #    under a NEW enrolment number (so DUP-001/ENR-001 have a live demo)
    nri_bad = students[9].dup
    nri_bad['id'] = "STU-#{SecureRandom.hex(4).upcase}"
    nri_bad['seat_type'] = 'OCI'
    nri_bad['nationality'] = 'Indian'
    nri_bad['oci_card_no'] = nil
    nri_bad['enrolment_no'] = students[9]['enrolment_no'].sub(%r{/\d+$}, '/997')
    students << nri_bad

    users = [
      { 'id' => 'USR-1', 'username' => 'aicte.admin', 'password' => 'demo123', 'role' => 'AICTE_ADMIN',
        'name' => 'AICTE Central Repository Admin', 'institution_id' => nil, 'email' => 'admin@aicte.org.in' },
      { 'id' => 'USR-2', 'username' => 'cope.pune', 'password' => 'demo123', 'role' => 'INSTITUTION',
        'name' => 'Registrar, COEP Pune', 'institution_id' => 'INS-127', 'email' => 'registrar@coeptech.ac.in' },
      { 'id' => 'USR-3', 'username' => 'mit.manipal', 'password' => 'demo123', 'role' => 'INSTITUTION',
        'name' => 'MIT Manipal Data Cell', 'institution_id' => 'INS-318', 'email' => 'datacell@mit.edu' },
      { 'id' => 'USR-4', 'username' => 'employer.demo', 'password' => 'demo123', 'role' => 'VERIFIER',
        'name' => 'TCS Campus Hiring Verification', 'institution_id' => nil, 'email' => 'verify@tcs.com' }
    ]

    {
      'version' => 1,
      'settings' => {
        'hmac_secret' => SecureRandom.hex(32),
        'issuer' => 'AICTE-APAAR-PLATFORM',
        'issuer_did' => 'did:web:apaar.aicte.org.in',
        'schema_version' => '1.0'
      },
      'institutions' => institutions,
      'programmes' => programmes,
      'students' => students,
      'users' => users,
      'audit' => [{ 'id' => 'AUD-SYSTEM', 'ts' => Time.now.utc.iso8601, 'actor' => 'system', 'role' => 'system',
                    'action' => 'SEED', 'detail' => "Seeded #{students.length} student records across #{institutions.length} institutions",
                    'institution_id' => nil }],
      'issues' => []
    }.tap { |db| @db = db }
  end
end
