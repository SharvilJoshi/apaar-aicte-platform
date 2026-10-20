# frozen_string_literal: true

require 'date'
require_relative 'apaar'

# Automated validation + anomaly detection over student records.
#
# Rules implemented (referenced by rule code in API responses and dashboards):
#   DUP-001  Duplicate APAAR within the same institution
#   DUP-002  Potential duplicate enrolment ACROSS institutions (national-level)
#   APAAR-001 Invalid or missing APAAR ID (format / Luhn / year)
#   APAAR-002 APAAR year inconsistent with recorded admission year
#   INTAKE-001 Programme enrolment exceeds approved intake + permitted supernumerary
#   INTAKE-002 Enrolment above approved intake but within supernumerary headroom (warning)
#   INTAKE-003 Supernumerary / NRI / OCI / FN seat counts exceed their permitted caps
#   DATA-001 Missing mandatory fields (name, DOB, gender, category, programme, enrolment no.)
#   DATA-002 Inconsistent data (DOB after admission, invalid category, bad contact fields,
#            NRI/OCI/FN status conflicting with declared nationality)
#   ENR-001 Duplicate enrolment number within an institution
module Validation
  CATEGORIES = %w[General OBC SC ST EWS].freeze
  GENDERS    = %w[M F Other].freeze
  SEAT_TYPES = %w[Regular Supernumerary NRI OCI ForeignNational].freeze
  EMAIL_RE   = /\A[^@\s]+@[^@\s]+\.[a-z]{2,}\z/i.freeze
  PHONE_RE   = /\A\d{10}\z/.freeze

  MANDATORY = %w[name dob gender category programme_id enrolment_no].freeze

  Result = Struct.new(:code, :severity, :message, :field, :apaar_id, :institution_id, :programme_id, keyword_init: true)

  module_function

  # ---- single-record checks (used on upload and on re-validation) -------------
  def check_record(rec, existing_students, all_programmes, institution_id)
    results = []

    # APAAR structural + checksum
    v = Apaar.validate(rec['apaar_id'], admission_year: rec['admission_year'])
    v[:errors].each_with_index do |msg, i|
      code = msg.include?('check digit') || msg.include?('12-digit') ? 'APAAR-001' : 'APAAR-002'
      results << res(code, :error, msg, 'apaar_id', rec, institution_id)
    end

    # Missing mandatory fields
    missing = MANDATORY.select { |f| rec[f].to_s.strip.empty? }
    if missing.any?
      results << res('DATA-001', :error,
                     "Missing mandatory field(s): #{missing.join(', ')}", missing.first, rec, institution_id)
    end

    # Category / gender / seat-type vocab
    if rec['category'] && !CATEGORIES.include?(rec['category'])
      results << res('DATA-002', :error, "Invalid category '#{rec['category']}' (allowed: #{CATEGORIES.join('/')})",
                     'category', rec, institution_id)
    end
    if rec['gender'] && !GENDERS.include?(rec['gender'])
      results << res('DATA-002', :error, "Invalid gender '#{rec['gender']}'", 'gender', rec, institution_id)
    end
    if rec['seat_type'] && !SEAT_TYPES.include?(rec['seat_type'])
      results << res('DATA-002', :error, "Invalid seat type '#{rec['seat_type']}'", 'seat_type', rec, institution_id)
    end

    # Contact fields
    results << res('DATA-002', :warning, 'Invalid email address', 'email', rec, institution_id) if
      rec['email'] && !rec['email'].to_s.empty? && !EMAIL_RE.match?(rec['email'])
    results << res('DATA-002', :warning, 'Mobile number must be 10 digits', 'phone', rec, institution_id) if
      rec['phone'] && !rec['phone'].to_s.empty? && !PHONE_RE.match?(rec['phone'])

    # DOB sanity
    dob = parse_date(rec['dob'])
    adm = parse_date(rec['admission_date'])
    if !rec['dob'].to_s.empty? && dob.nil?
      results << res('DATA-002', :error, 'Date of birth must be YYYY-MM-DD', 'dob', rec, institution_id)
    end
    if dob && adm && dob > adm
      results << res('DATA-002', :error, 'Date of birth is after the admission date', 'dob', rec, institution_id)
    end
    if dob && adm
      age = ((adm - dob) / 365.25).floor
      results << res('DATA-002', :warning, "Implausible age at admission (#{age} years)", 'dob', rec, institution_id) if
        age < 15 || age > 40
    end

    # OCI / FN consistency. NRI seats are legitimately held by Indian citizens
    # residing abroad, so only OCI/FN conflict with an 'Indian' nationality.
    if %w[OCI ForeignNational].include?(rec['seat_type']) && rec['nationality'].to_s == 'Indian'
      results << res('DATA-002', :error,
                     "Seat type #{rec['seat_type']} conflicts with declared nationality 'Indian'",
                     'nationality', rec, institution_id)
    end
    if rec['seat_type'] == 'NRI' && !rec['nationality'].to_s.empty? && rec['nationality'].to_s != 'Indian'
      results << res('DATA-002', :warning,
                     "NRI seat declared with non-Indian nationality '#{rec['nationality']}'",
                     'nationality', rec, institution_id)
    end
    if rec['seat_type'] == 'OCI' && rec['oci_card_no'].to_s.strip.empty?
      results << res('DATA-002', :error, 'OCI seat type requires an OCI card number', 'oci_card_no', rec, institution_id)
    end
    if rec['seat_type'] == 'ForeignNational' && rec['passport_no'].to_s.strip.empty?
      results << res('DATA-002', :error, 'Foreign National seat type requires a passport number',
                     'passport_no', rec, institution_id)
    end

    # Programme must exist AND belong to this institution
    # (accepts a pre-built {id => programme} hash so sweeps stay O(1) per record)
    pidx = all_programmes.is_a?(Hash) ? all_programmes
                                      : all_programmes.each_with_object({}) { |p, h| h[p['id'].to_s] = p }
    prog = pidx[rec['programme_id'].to_s]
    if rec['programme_id'] && prog.nil?
      results << res('DATA-001', :error, 'Programme does not belong to this institution', 'programme_id', rec,
                     institution_id)
    elsif prog && institution_id.to_s != '' && prog['institution_id'].to_s != institution_id.to_s
      results << res('DATA-001', :error,
                     "Programme #{prog['id']} (#{prog['name']}) is approved under #{prog['institution_id']}, " \
                     "not #{institution_id} — cross-institution admission blocked",
                     'programme_id', rec, institution_id)
    end

    # Duplicate APAAR within institution (hash-indexed — O(1) per lookup)
    index = existing_students.is_a?(Hash) ? existing_students : build_index(existing_students)
    same_apaar = index[:by_apaar][rec['apaar_id']] || []

    # (the enrolment guard keeps id-less dry-runs of an EXISTING record from
    # flagging that same record as its own duplicate)
    dup_in = same_apaar.find do |s|
      s['institution_id'] == institution_id && s['id'] != rec['id'] &&
        s['enrolment_no'].to_s != rec['enrolment_no'].to_s
    end
    if dup_in
      results << res('DUP-001', :error,
                     "Duplicate APAAR ID — already enrolled in this institution as #{dup_in['enrolment_no']} " \
                     "(#{dup_in['name']})", 'apaar_id', rec, institution_id)
    end

    # Cross-institution duplicate enrolment (the national-level catch)
    cross = same_apaar.select do |s|
      s['institution_id'] != institution_id && s['status'] != 'Withdrawn'
    end
    cross.each do |s|
      results << res('DUP-002', :error,
                     "APAAR ID already enrolled at another institution (#{s['institution_name'] || s['institution_id']}, " \
                     "#{s['programme_name'] || s['programme_id']})", 'apaar_id', rec, institution_id)
    end

    # Duplicate enrolment no. within institution
    dup_e = index[:by_enrol][[institution_id, rec['enrolment_no'].to_s]]
    # skip when it is this very record — or its own row seen in an id-less dry-run
    dup_e = nil if dup_e && (dup_e['id'] == rec['id'] ||
                             (dup_e['apaar_id'] == rec['apaar_id'] && dup_e['institution_id'] == institution_id))
    if dup_e && !rec['enrolment_no'].to_s.empty?
      results << res('ENR-001', :error, "Duplicate enrolment number (already used by APAAR #{Apaar.masked(dup_e['apaar_id'])})",
                     'enrolment_no', rec, institution_id)
    end

    # Consent (requirement 8): data-subject consent must be on file before the
    # record is exposed to authorized verifiers.
    consent = rec['consent']
    unless consent.is_a?(Hash) && consent['granted'] == true
      results << res('CONSENT-001', :warning,
                     'Student consent for AICTE repository + authorized verification is not recorded',
                     'consent', rec, institution_id)
    end

    results
  end

  # ---- prospective admission checks ------------------------------------------
  # Runs at UPLOAD time so excess admissions are caught BEFORE the commit,
  # not only by the repository-wide sweep afterwards. Existing records being
  # edited in place don't re-claim a seat they already hold; quota checks only
  # re-run when the seat type or programme actually changes.
  def check_admission(rec, students, programmes, institution_id)
    return [] if rec['status'].to_s == 'Withdrawn'
    pidx = programmes.is_a?(Hash) ? programmes
                                  : programmes.each_with_object({}) { |p, h| h[p['id'].to_s] = p }
    prog = pidx[rec['programme_id'].to_s]
    return [] unless prog

    # Intake and quota caps are sanctioned per academic year, so a student is
    # counted against the cohort they are admitted into. When the year is not
    # supplied, fall back to the latest cycle in the repository.
    cohort_year = (rec['admission_year'] || rec['admission_date'].to_s[0, 4]).to_i
    cohort_year = students.map { |s| s['admission_year'] }.compact.max.to_i if cohort_year < 1900

    existing = if rec['id']
                 students.find { |s| s['id'] == rec['id'] }
               elsif !rec['apaar_id'].to_s.empty?
                 # dry-run path (no internal id yet): resolve by APAAR + institution
                 students.find { |s| s['apaar_id'] == rec['apaar_id'] && s['institution_id'] == institution_id }
               end
    in_place_edit = existing && existing['programme_id'].to_s == prog['id'].to_s
    results = []

    if in_place_edit
      # same programme: only the seat-type cap could change
      return results if existing['seat_type'] == rec['seat_type']
    else
      others = students.count do |s|
        s['programme_id'].to_s == prog['id'].to_s && s['id'] != rec['id'] &&
          s['admission_year'] == cohort_year && s['status'] != 'Withdrawn'
      end
      would_be = others + 1
      approved = prog['approved_intake'].to_i
      sn_cap   = prog['supernumerary_cap'].to_i
      if would_be > approved + sn_cap
        results << res('INTAKE-001', :error,
                       "Admitting this student takes the #{cohort_year} cohort to #{would_be}, exceeding approved " \
                       "intake #{approved} + supernumerary #{sn_cap}", 'programme_id', rec, institution_id, prog['id'])
      elsif would_be > approved
        results << res('INTAKE-002', :warning,
                       "The #{cohort_year} cohort would reach #{would_be} — above approved intake #{approved} but " \
                       "within supernumerary headroom (#{approved + sn_cap})",
                       'programme_id', rec, institution_id, prog['id'])
      end
    end

    # seat-type quota for the seat being claimed
    seat = rec['seat_type'].to_s
    cap = case seat
          when 'Supernumerary' then prog['supernumerary_cap'].to_i
          when 'NRI'           then prog['nri_cap'].to_i
          when 'OCI', 'ForeignNational' then prog['fn_cap'].to_i
          end
    if cap
      used = students.count do |s|
        s['programme_id'].to_s == prog['id'].to_s && s['seat_type'] == seat && s['id'] != rec['id'] &&
          s['admission_year'] == cohort_year
      end
      if used + 1 > cap
        results << res('INTAKE-003', :error,
                       "#{seat} seats in this programme would reach #{used + 1}, exceeding the permitted cap #{cap}",
                       'seat_type', rec, institution_id, prog['id'])
      end
    end
    results
  end

  # Hash indexes so a full-repository sweep is O(n) instead of O(n²).
  # Returns { by_apaar: {apaar => [students]}, by_enrol: {[[inst, no]] => student} }.
  def build_index(students)
    by_apaar = Hash.new { |h, k| h[k] = [] }
    by_enrol = {}
    students.each do |s|
      by_apaar[s['apaar_id']] << s
      no = s['enrolment_no'].to_s
      by_enrol[[s['institution_id'], no]] = s unless no.empty?
    end
    { by_apaar: by_apaar, by_enrol: by_enrol }
  end

  # ---- aggregate intake checks (programme level) ------------------------------
  # students: all active students; programmes: with approved_intake etc.
  def check_intake(students, programmes)
    results = []
    by_prog = students.group_by { |s| s['programme_id'].to_s }
    programmes.each do |p|
      approved = p['approved_intake'].to_i
      sn_cap   = p['supernumerary_cap'].to_i          # absolute extra seats allowed
      nri_cap  = p['nri_cap'].to_i
      fn_cap   = p['fn_cap'].to_i

      # Approved intake is sanctioned per academic year: evaluate each year's
      # cohort against it, not the lifetime total of the programme.
      (by_prog[p['id'].to_s] || []).group_by { |s| s['admission_year'] }.each do |yr, list|
        enrolled = list.size
        tag = yr ? " (#{yr} cohort)" : ''

        if enrolled > approved + sn_cap
          results << res('INTAKE-001', :error,
                         "Enrolment #{enrolled}#{tag} exceeds approved intake #{approved} + supernumerary #{sn_cap} " \
                         "by #{enrolled - approved - sn_cap} seat(s)", nil,
                         { 'apaar_id' => nil }, p['institution_id'], p['id'])
        elsif enrolled > approved
          results << res('INTAKE-002', :warning,
                         "Enrolment #{enrolled}#{tag} is above approved intake #{approved} but within supernumerary headroom",
                         nil, { 'apaar_id' => nil }, p['institution_id'], p['id'])
        end

        sn = list.count { |s| s['seat_type'] == 'Supernumerary' }
        if sn > sn_cap
          results << res('INTAKE-003', :error,
                         "Supernumerary seats #{sn}#{tag} exceed permitted cap #{sn_cap}", nil, { 'apaar_id' => nil },
                         p['institution_id'], p['id'])
        end
        nri = list.count { |s| s['seat_type'] == 'NRI' }
        if nri > nri_cap
          results << res('INTAKE-003', :error, "NRI seats #{nri}#{tag} exceed permitted cap #{nri_cap}", nil,
                         { 'apaar_id' => nil }, p['institution_id'], p['id'])
        end
        fn = list.count { |s| %w[OCI ForeignNational].include?(s['seat_type']) }
        if fn > fn_cap
          results << res('INTAKE-003', :error, "OCI/FN seats #{fn}#{tag} exceed permitted cap #{fn_cap}", nil,
                         { 'apaar_id' => nil }, p['institution_id'], p['id'])
        end
      end
    end
    results
  end

  # ---- national duplicate sweep ------------------------------------------------
  def duplicate_apaars(students)
    active = students.select { |s| s['status'] != 'Withdrawn' }
    active.group_by { |s| s['apaar_id'] }
          .select { |k, v| !k.to_s.empty? && v.size > 1 }
          .map { |apaar, list| { apaar_id: apaar, students: list.map { |s| s.slice('id', 'name', 'institution_id', 'institution_name', 'programme_id', 'programme_name', 'enrolment_no', 'status') } } }
  end

  # ---- helpers -----------------------------------------------------------------
  def res(code, severity, message, field, rec, institution_id, programme_id = nil)
    Result.new(code: code, severity: severity, message: message, field: field,
               apaar_id: rec['apaar_id'], institution_id: institution_id,
               programme_id: programme_id || rec['programme_id'])
  end

  def parse_date(s)
    return nil if s.to_s.strip.empty?
    Date.iso8601(s.to_s)
  rescue StandardError
    nil
  end
end
