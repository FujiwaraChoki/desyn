/** Rough password strength (0-4) for the meter: length first, then variety and obvious patterns. */
export function passwordScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length < 8) return 0;
  let score = 1;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(password),
  ).length;
  if (classes >= 3) score++;
  if (/^(.)\1+$/.test(password) || /^(?:0123|1234|abcd|qwer|pass)/i.test(password)) score = 1;
  return Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}
