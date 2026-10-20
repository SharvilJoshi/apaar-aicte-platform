# frozen_string_literal: true

# APAAR (Academic Permanent Account Number) — 12 digit national academic identity.
#
# Format used by this platform (aligned with the MoE/DigiLocker APAAR concept):
#   [ 1 digit entity ] [ 1 digit reserved/batch ] [ 4 digits admission year ]
#   [ 2 digits institution slot ] [ 3 digits sequence within slot+year ]
#   [ 1 check digit (Luhn) ]
#
# Example: 12 2021 07 042 7
#   1     -> entity type (1 = student)
#   2     -> batch / issuer generation
#   2021  -> year of first enrolment
#   07    -> institution registry slot (01-99, unique per institution)
#   042   -> running sequence within that institution + year
#   7     -> Luhn check digit over the first 11 digits
#
# The institution slot keeps the segment collision-free across institutions;
# the canonical institution code lives on the student record itself.
module Apaar
  ENTITY_STUDENT = '1'.freeze
  ENTITY_ORG     = '2'.freeze
  FORMAT_RE      = /\A[12]\d{11}\z/.freeze
  MIN_YEAR       = 2000
  MAX_YEAR       = 2035

  module_function

  # Luhn (mod-10) check digit for the given 11-digit body.
  def check_digit(body)
    sum = 0
    body.chars.each_with_index do |ch, i|
      d = ch.to_i
      # digits are doubled from the rightmost of the body (position 1 of 11)
      d *= 2 if i.odd?
      d -= 9 if d > 9
      sum += d
    end
    (10 - (sum % 10)) % 10
  end

  # institution_slot: registry index of the institution (01-99)
  # sequence:         running number within institution + year (000-999)
  def generate(institution_slot:, year:, sequence:)
    slot = institution_slot.to_i.clamp(0, 99)
    body = format('%s%s%04d%02d%03d', ENTITY_STUDENT, '2', year.to_i,
                  slot, sequence.to_i % 1000)
    body + check_digit(body).to_s
  end

  # Strips display formatting ("12 2021 20201 4" -> "122021202014"). Users copy
  # IDs from tables that render them grouped, so raw input is never trusted to
  # be bare digits.
  def normalize(id)
    id.to_s.gsub(/[\s-]/, '')
  end

  # Returns { valid:, errors: [...] } — structural + checksum + sane-year validation.
  def validate(id, admission_year: nil)
    errors = []
    raw = normalize(id)
    if raw.empty?
      return { valid: false, errors: ['APAAR ID is missing'] }
    end
    unless FORMAT_RE.match?(raw)
      errors << 'APAAR ID must be a 12-digit number starting with 1 or 2'
      return { valid: false, errors: errors }
    end
    errors << 'APAAR ID has an invalid check digit (failed Luhn verification)' if check_digit(raw[0, 11]) != raw[11].to_i
    year = raw[2, 4].to_i
    if year < MIN_YEAR || year > MAX_YEAR
      errors << "APAAR ID embeds an implausible enrolment year (#{year})"
    end
    if admission_year && year != admission_year.to_i
      errors << "APAAR enrolment year (#{year}) does not match admission year (#{admission_year})"
    end
    { valid: errors.empty?, errors: errors }
  end

  def masked(id)
    s = id.to_s
    s.length == 12 ? "#{s[0, 4]}••••#{s[10, 2]}" : s
  end

  def pretty(id)
    s = id.to_s
    s.length == 12 ? "#{s[0, 2]} #{s[2, 4]} #{s[6, 5]} #{s[11, 1]}" : s
  end
end
