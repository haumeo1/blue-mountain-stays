function escapeIcs(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function foldLine(line) {
  const parts = [];
  let remaining = line;
  while (Buffer.byteLength(remaining, "utf8") > 73) {
    let cut = 73;
    while (Buffer.byteLength(remaining.slice(0, cut), "utf8") > 73) cut -= 1;
    parts.push(remaining.slice(0, cut));
    remaining = ` ${remaining.slice(cut)}`;
  }
  parts.push(remaining);
  return parts.join("\r\n");
}

function compactDate(value) { return value.replaceAll("-", ""); }

export function bookingEvent(booking, domain = "blue-mountain-house") {
  const status = booking.status === "cancelled" ? "CANCELLED" : booking.status === "pending" ? "TENTATIVE" : "CONFIRMED";
  const name = booking.guest_name ? ` · ${booking.guest_name}` : "";
  return [
    "BEGIN:VEVENT",
    `UID:${escapeIcs(booking.id)}@${domain}`,
    `DTSTAMP:${new Date(booking.updated_at || booking.created_at || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTSTART;VALUE=DATE:${compactDate(booking.check_in)}`,
    `DTEND;VALUE=DATE:${compactDate(booking.check_out)}`,
    `SUMMARY:${escapeIcs(`Blue Mountain House${name}`)}`,
    `DESCRIPTION:${escapeIcs(`${booking.confirmation_code || "Reservation"} · ${booking.guest_count || ""} guests · ${booking.status || "confirmed"}`)}`,
    `LOCATION:${escapeIcs("The Blue Mountains, Ontario")}`,
    `STATUS:${status}`,
    "TRANSP:OPAQUE",
    "END:VEVENT"
  ];
}

export function blockEvent(block, domain = "blue-mountain-house") {
  return [
    "BEGIN:VEVENT",
    `UID:block-${escapeIcs(block.id)}@${domain}`,
    `DTSTAMP:${new Date(block.created_at || Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTSTART;VALUE=DATE:${compactDate(block.start_date)}`,
    `DTEND;VALUE=DATE:${compactDate(block.end_date)}`,
    `SUMMARY:${escapeIcs(`Blocked · ${block.reason || "Owner block"}`)}`,
    "TRANSP:OPAQUE",
    "END:VEVENT"
  ];
}

export function createCalendar(events, { name = "Blue Mountain House bookings" } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Blue Mountain House//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(name)}`,
    "X-PUBLISHED-TTL:PT15M",
    ...events.flat(),
    "END:VCALENDAR"
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
