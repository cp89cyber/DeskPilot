export const GMAIL_URL = "https://mail.google.com/mail/u/0/#inbox";
export const CALENDAR_URL = "https://calendar.google.com/calendar/u/0/r";

export function browserAuthTargets(): { gmailUrl: string; calendarUrl: string } {
  return {
    gmailUrl: GMAIL_URL,
    calendarUrl: CALENDAR_URL,
  };
}
