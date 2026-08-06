export function readLoginFields(
  formData: FormData,
): { email: string; password: string } | undefined {
  const rawEmail = formData.get('email');
  const rawPassword = formData.get('password');
  if (typeof rawEmail !== 'string' || typeof rawPassword !== 'string') {
    return undefined;
  }
  const email = rawEmail.trim();
  if (!email || !rawPassword) return undefined;
  return { email, password: rawPassword };
}
