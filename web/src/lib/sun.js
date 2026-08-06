// NOAA solar-position algorithm (the one behind the NOAA Solar Calculator
// spreadsheet). Angles in degrees unless a name says otherwise.
const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

export const KST = 9 // 대한민국 표준시 (UTC+9), 서머타임 없음

/** days since 1900-01-00 in the spreadsheet sense, then Julian day */
function julianDay(year, month, day, minutesUTC) {
  let y = year
  let m = month
  if (m <= 2) {
    y -= 1
    m += 12
  }
  const A = Math.floor(y / 100)
  const B = 2 - A + Math.floor(A / 4)
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    B -
    1524.5
  return jd + minutesUTC / 1440
}

/**
 * @param {{y:number,m:number,d:number}} date  local (KST) calendar date
 * @param {number} minutes  minutes past local midnight
 * @param {number} lat  degrees north
 * @param {number} lon  degrees east
 */
export function solarPosition(date, minutes, lat, lon) {
  const jd = julianDay(date.y, date.m, date.d, minutes - KST * 60)
  const T = (jd - 2451545) / 36525

  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
  const C =
    Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) +
    Math.sin(rad(3 * M)) * 0.000289
  const trueLong = L0 + C
  const omega = 125.04 - 1934.136 * T
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega))
  const meanObliq =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
  const obliq = meanObliq + 0.00256 * Math.cos(rad(omega))
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))))

  const varY = Math.tan(rad(obliq / 2)) ** 2
  const eqTime =
    4 *
    deg(
      varY * Math.sin(2 * rad(L0)) -
        2 * e * Math.sin(rad(M)) +
        4 * e * varY * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) -
        0.5 * varY * varY * Math.sin(4 * rad(L0)) -
        1.25 * e * e * Math.sin(2 * rad(M)),
    )

  const trueSolar = (minutes + eqTime + 4 * lon - 60 * KST + 1440) % 1440
  const ha = trueSolar / 4 < 0 ? trueSolar / 4 + 180 : trueSolar / 4 - 180

  const cosZen =
    Math.sin(rad(lat)) * Math.sin(rad(decl)) +
    Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha))
  const zenith = deg(Math.acos(Math.min(1, Math.max(-1, cosZen))))
  const altitude = 90 - zenith

  let azimuth
  const denom = Math.cos(rad(lat)) * Math.sin(rad(zenith))
  if (Math.abs(denom) < 1e-9) {
    azimuth = decl > lat ? 0 : 180
  } else {
    const t = (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(decl))) / denom
    const a = deg(Math.acos(Math.min(1, Math.max(-1, t))))
    azimuth = ha > 0 ? (a + 180) % 360 : (540 - a) % 360
  }
  return { altitude, azimuth, declination: decl, eqTime, hourAngle: ha }
}

/** unit vector towards the sun in scene axes: +x east, +y up, +z south */
export function sunVector(altitude, azimuth) {
  const alt = rad(altitude)
  const az = rad(azimuth)
  const h = Math.cos(alt)
  return { x: h * Math.sin(az), y: Math.sin(alt), z: -h * Math.cos(az) }
}

/** sunrise / solar noon / sunset in minutes past local midnight (KST) */
export function daylight(date, lat, lon) {
  const noonProbe = solarPosition(date, 720, lat, lon)
  const decl = noonProbe.declination
  const eqTime = noonProbe.eqTime
  const cosH =
    Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) -
    Math.tan(rad(lat)) * Math.tan(rad(decl))
  const noon = 720 - 4 * lon - eqTime + 60 * KST
  if (cosH > 1) return { sunrise: null, sunset: null, noon, polar: 'night' }
  if (cosH < -1) return { sunrise: null, sunset: null, noon, polar: 'day' }
  const ha = deg(Math.acos(cosH))
  return { sunrise: noon - ha * 4, sunset: noon + ha * 4, noon, polar: null }
}

export const fmtTime = (minutes) => {
  const m = Math.round(minutes)
  const h = Math.floor(((m % 1440) + 1440) % 1440 / 60)
  const mm = (((m % 60) + 60) % 60).toString().padStart(2, '0')
  return `${h.toString().padStart(2, '0')}:${mm}`
}

export const dayOfYear = ({ y, m, d }) =>
  Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1
