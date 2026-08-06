import styles from './login.module.css';
import { loginStaffAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

const errors: Record<string, string> = {
  credentials: 'تعذّر تسجيل الدخول. تحقق من بيانات الموظف.',
  session: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.',
  service: 'تعذّر الاتصال بخدمة التشغيل. أعد المحاولة بعد قليل.',
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;
  return (
    <main className={styles.page} dir="rtl">
      <section className={styles.card} aria-labelledby="login-title">
        <p className={styles.eyebrow}>لوحة التشغيل · بريدة، القصيم</p>
        <h1 id="login-title">معين</h1>
        <p className={styles.subtitle}>دخول موظفي التشغيل والدعم فقط.</p>
        {error && errors[error] && (
          <p className={styles.error} role="alert">{errors[error]}</p>
        )}
        <form action={loginStaffAction} className={styles.form}>
          <label>
            البريد الإلكتروني
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              dir="ltr"
            />
          </label>
          <label>
            كلمة المرور
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              dir="ltr"
            />
          </label>
          <button type="submit">تسجيل الدخول</button>
        </form>
      </section>
    </main>
  );
}
