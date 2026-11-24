// Vercel Serverless Function: /api/concerts
// Reads your private CONCERTS_SHEET_URL environment variable (published Google Sheet CSV)
// and returns clean JSON. Clearing an Attendance cell in Google Sheets returns null -> "None" live.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseCsvRfc4180(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function formatIsoDateLabel(rawDate) {
  const str = String(rawDate || '').trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return str;
  const year = m[1];
  const monthIdx = Math.max(0, Math.min(11, parseInt(m[2], 10) - 1));
  const day = parseInt(m[3], 10);
  return `${MONTHS_SHORT[monthIdx]} ${day}, ${year}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const sheetUrl = process.env.CONCERTS_SHEET_URL;
  if (!sheetUrl) {
    return res.status(500).json({
      error: 'CONCERTS_SHEET_URL is not configured in Vercel Environment Variables.',
    });
  }

  try {
    const sep = sheetUrl.includes('?') ? '&' : '?';
    const bustUrl = `${sheetUrl}${sep}_cb=${Math.floor(Date.now() / 5000)}`;

    const upstream = await fetch(bustUrl, {
      headers: { Accept: 'text/csv,text/plain,*/*' },
      cache: 'no-store',
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Google Sheets CSV returned HTTP ${upstream.status}.`,
      });
    }

    const csvText = await upstream.text();
    const rows = parseCsvRfc4180(csvText);

    if (!rows || rows.length < 2) {
      return res.status(200).json({
        updatedAt: new Date().toISOString(),
        summary: { totalAttendance: 0, reportedStops: 0, totalStops: 0, totalShows: 0 },
        tours: [],
        stops: [],
      });
    }

    const headers = rows[0].map((h) => String(h || '').trim().toLowerCase());
    const colIdx = (name) => headers.indexOf(name.toLowerCase());

    const iTour = colIdx('tour');
    const iTourKey = colIdx('tour_key');
    const iRegion = colIdx('region');
    const iStartDate = colIdx('start_date');
    const iDates = colIdx('dates');
    const iCity = colIdx('city');
    const iCountry = colIdx('country');
    const iVenue = colIdx('venue');
    const iNights = colIdx('nights');
    const iAttendance = colIdx('attendance');
    const iStatus = colIdx('status');
    const iNotes = colIdx('notes');

    const stops = [];
    const toursMap = new Map();

    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r];
      if (!cols || cols.every((c) => !String(c || '').trim())) continue;

      const tour = iTour >= 0 ? String(cols[iTour] || '').trim() : '';
      const venue = iVenue >= 0 ? String(cols[iVenue] || '').trim() : '';
      if (!tour && !venue) continue;

      const rawKey = iTourKey >= 0 ? String(cols[iTourKey] || '').trim() : '';
      const tourKey = rawKey || tour.toLowerCase().replace(/[^a-z0-9]+/g, '_');

      const region = iRegion >= 0 ? String(cols[iRegion] || '').trim() : '';
      const startDate = iStartDate >= 0 ? String(cols[iStartDate] || '').trim() : '';
      const rawDates = iDates >= 0 ? String(cols[iDates] || '').trim() : '';
      const dates = formatIsoDateLabel(rawDates || startDate);
      const city = iCity >= 0 ? String(cols[iCity] || '').trim() : '';
      const country = iCountry >= 0 ? String(cols[iCountry] || '').trim() : '';
      const rawNights = iNights >= 0 ? parseInt(String(cols[iNights] || '').replace(/[^0-9]/g, ''), 10) : 1;
      const nights = Number.isFinite(rawNights) && rawNights > 0 ? rawNights : 1;
      const status = iStatus >= 0 ? String(cols[iStatus] || '').trim() : '';
      const notes = iNotes >= 0 ? String(cols[iNotes] || '').trim() : '';

      // Parse Attendance: empty/cleared cell -> null (displays as "None" on site)
      const rawAttStr = iAttendance >= 0 ? String(cols[iAttendance] || '').trim() : '';
      let attendance = null;
      let hasTildePrefix = false;

      if (rawAttStr !== '') {
        hasTildePrefix = /^[~≈]/.test(rawAttStr);
        const cleanedNum = Number(rawAttStr.replace(/[~≈+,\s]/g, ''));
        if (Number.isFinite(cleanedNum) && cleanedNum >= 0) {
          attendance = Math.round(cleanedNum);
        }
      }

      const isApprox = hasTildePrefix || /approx|estimate|\best\b/i.test(notes);

      if (!toursMap.has(tourKey)) {
        toursMap.set(tourKey, { key: tourKey, label: tour || tourKey.toUpperCase() });
      }

      stops.push({
        tour,
        tourKey,
        region,
        startDate,
        dates,
        city,
        country,
        venue,
        nights,
        attendance,
        isApprox,
        status,
        notes,
      });
    }

    let totalAttendance = 0;
    let reportedStops = 0;
    let totalShows = 0;

    for (const s of stops) {
      totalShows += s.nights;
      if (typeof s.attendance === 'number' && !Number.isNaN(s.attendance)) {
        totalAttendance += s.attendance;
        reportedStops += 1;
      }
    }

    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      summary: {
        totalAttendance,
        reportedStops,
        totalStops: stops.length,
        totalShows,
      },
      tours: Array.from(toursMap.values()),
      stops,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Failed to load concert attendance from Google Sheets.',
    });
  }
                                              }
