import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import styles from './page.module.css';
import {
  dashboardApiFetch,
  requireStaffSession,
  staffActionFailureRedirect,
} from './auth/api-client';
import { staffCapabilities } from './auth/roles';
import { logoutStaffAction } from './logout/action';
import {
  isApiServiceRequest,
  isApiServiceRequestEvent,
  requestEventLabel,
  toDashboardRequest,
  type ApiServiceRequestEvent,
  type DashboardRequest,
} from './requests';
import {
  isApiSupportTicket,
  toDashboardSupportTicket,
  type DashboardSupportTicket,
} from './support';
import {
  isApiAuditEvent,
  toDashboardAuditEvent,
  type DashboardAuditEvent,
} from './audit';

export const dynamic = 'force-dynamic';

async function getServiceRequests(token: string): Promise<DashboardRequest[]> {
  try {
    const response = await dashboardApiFetch('/service-requests', token);
    if (!response.ok) return [];
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isApiServiceRequest).map(toDashboardRequest).reverse();
  } catch {
    return [];
  }
}

async function getServiceRequestEvents(
  token: string,
  requestId: string,
): Promise<ApiServiceRequestEvent[]> {
  try {
    const response = await dashboardApiFetch(
      `/service-requests/${requestId}/history`,
      token,
    );
    if (!response.ok) return [];
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isApiServiceRequestEvent);
  } catch {
    return [];
  }
}

type Provider = {
  id: string;
  name: string;
  specialties: string[];
  serviceZone: string;
  verificationStatus: 'pending' | 'verified' | 'suspended';
  available: boolean;
};

async function getProviders(token: string): Promise<Provider[]> {
  try {
    const response = await dashboardApiFetch('/providers', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return [];
    return data.filter((value): value is Provider =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Record<string, unknown>).id === 'string' &&
      typeof (value as Record<string, unknown>).name === 'string' &&
      Array.isArray((value as Record<string, unknown>).specialties) &&
      typeof (value as Record<string, unknown>).serviceZone === 'string' &&
      ['pending', 'verified', 'suspended'].includes(
        String((value as Record<string, unknown>).verificationStatus),
      ) &&
      typeof (value as Record<string, unknown>).available === 'boolean',
    );
  } catch {
    return [];
  }
}

async function getSupportTickets(
  token: string,
): Promise<DashboardSupportTicket[]> {
  try {
    const response = await dashboardApiFetch('/support-tickets', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return [];
    return data.filter(isApiSupportTicket).map(toDashboardSupportTicket);
  } catch {
    return [];
  }
}

async function getAuditEvents(token: string): Promise<DashboardAuditEvent[]> {
  try {
    const response = await dashboardApiFetch('/admin/audit-events', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return [];
    return data.filter(isApiAuditEvent).map(toDashboardAuditEvent);
  } catch {
    return [];
  }
}

const roleLabels = {
  admin: 'مدير النظام',
  dispatcher: 'موظف التشغيل',
  support_agent: 'موظف الدعم',
};

function requireSuccessfulStaffAction(response: Response): void {
  const redirectPath = staffActionFailureRedirect(response.status);
  if (redirectPath) redirect(redirectPath);
  if (!response.ok) throw new Error('Staff operation failed');
}

type HomeProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function Home({ searchParams }: HomeProps) {
  const { error } = await searchParams;
  const { token, staff } = await requireStaffSession();
  const { canDispatch, canSupport, canViewAudit } = staffCapabilities(staff.role);
  const isAdmin = staff.role === 'admin';
  const [jobs, providers, supportTickets, auditEvents] = await Promise.all([
    canDispatch ? getServiceRequests(token) : Promise.resolve([]),
    canDispatch ? getProviders(token) : Promise.resolve([]),
    canSupport ? getSupportTickets(token) : Promise.resolve([]),
    canViewAudit ? getAuditEvents(token) : Promise.resolve([]),
  ]);
  const requestEventLists = await Promise.all(
    jobs.map(async (job) => ({
      requestId: job.id,
      events: await getServiceRequestEvents(token, job.id),
    })),
  );
  const eventsByRequest = new Map(
    requestEventLists.map(({ requestId, events }) => [requestId, events]),
  );
  const pendingCount = jobs.filter((job) => job.status === 'بانتظار التوزيع').length;
  const openSupportCount = supportTickets.filter(
    (ticket) => ticket.status !== 'تم الحل',
  ).length;
  const ratedJobs = jobs.filter((job) => typeof job.rating === 'number');
  const averageRating =
    ratedJobs.length === 0
      ? '—'
      : (
          ratedJobs.reduce((total, job) => total + (job.rating ?? 0), 0) /
          ratedJobs.length
        ).toFixed(1);

  async function assignProvider(formData: FormData) {
    'use server';
    const requestId = String(formData.get('requestId') ?? '');
    const providerId = String(formData.get('providerId') ?? '');
    if (requestId && providerId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/service-requests/${requestId}/assignment`,
        session.token,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId }),
        },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function proposeQuote(formData: FormData) {
    'use server';
    const requestId = String(formData.get('requestId') ?? '');
    const amountSar = Number(formData.get('amountSar'));
    const scope = String(formData.get('scope') ?? '').trim();
    const amountHalalas = Math.round(amountSar * 100);
    if (
      requestId &&
      Number.isFinite(amountSar) &&
      amountHalalas > 0 &&
      scope.length >= 3
    ) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/service-requests/${requestId}/quotes`,
        session.token,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountHalalas, scope }),
        },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function registerPilotProvider(formData: FormData) {
    'use server';
    const name = String(formData.get('name') ?? '');
    const serviceZone = String(formData.get('serviceZone') ?? '');
    const specialties = formData
      .getAll('specialties')
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (name && serviceZone && specialties.length > 0) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch('/providers', session.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, serviceZone, specialties }),
      });
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function verifyPilotProvider(formData: FormData) {
    'use server';
    const providerId = String(formData.get('providerId') ?? '');
    if (providerId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/providers/${providerId}/verification`,
        session.token,
        { method: 'PATCH' },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function suspendPilotProvider(formData: FormData) {
    'use server';
    const providerId = String(formData.get('providerId') ?? '');
    if (providerId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/providers/${providerId}/suspension`,
        session.token,
        { method: 'PATCH' },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function reactivatePilotProvider(formData: FormData) {
    'use server';
    const providerId = String(formData.get('providerId') ?? '');
    if (providerId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/providers/${providerId}/reactivation`,
        session.token,
        { method: 'PATCH' },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function setProviderAccessCode(formData: FormData) {
    'use server';
    const providerId = String(formData.get('providerId') ?? '');
    const accessCode = String(formData.get('accessCode') ?? '').trim();
    if (providerId && accessCode.length >= 16) {
      const session = await requireStaffSession();
      let response: Response;
      try {
        response = await dashboardApiFetch(
          `/providers/${providerId}/access-code`,
          session.token,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessCode }),
          },
        );
      } catch {
        redirect('/?error=rotation');
      }
      try {
        requireSuccessfulStaffAction(response);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Staff operation failed'
        ) {
          redirect('/?error=rotation');
        }
        throw error;
      }
    }
    revalidatePath('/');
  }

  async function updateStatus(formData: FormData) {
    'use server';
    const requestId = String(formData.get('requestId') ?? '');
    const status = String(formData.get('status') ?? '');
    if (requestId && status) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/service-requests/${requestId}/status`,
        session.token,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function collectCashPayment(formData: FormData) {
    'use server';
    const requestId = String(formData.get('requestId') ?? '');
    if (requestId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/service-requests/${requestId}/payments/cash/collect`,
        session.token,
        { method: 'POST' },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function refundCashPayment(formData: FormData) {
    'use server';
    const requestId = String(formData.get('requestId') ?? '');
    if (requestId) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/service-requests/${requestId}/payments/cash/refund`,
        session.token,
        { method: 'POST' },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  async function updateSupportTicketStatus(formData: FormData) {
    'use server';
    const ticketId = String(formData.get('ticketId') ?? '');
    const status = String(formData.get('status') ?? '');
    if (ticketId && status) {
      const session = await requireStaffSession();
      const response = await dashboardApiFetch(
        `/support-tickets/${ticketId}/status`,
        session.token,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        },
      );
      requireSuccessfulStaffAction(response);
    }
    revalidatePath('/');
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>لوحة التشغيل · بريدة، القصيم</p>
          <h1>معين</h1>
        </div>
        <div>
          <p>{staff.displayName} · {roleLabels[staff.role]}</p>
          <form action={logoutStaffAction}>
            <button type="submit">تسجيل الخروج</button>
          </form>
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>نظرة اليوم</p>
          <h2>شغّل كل طلب بثقة ووضوح.</h2>
        </div>
        <p>تظهر لك فقط المهام المسموح بها وفق صلاحية حسابك.</p>
        {error === 'forbidden' && (
          <p className={styles.accessError} role="alert">
            ليس لديك صلاحية لتنفيذ هذا الإجراء.
          </p>
        )}
        {error === 'rotation' && (
          <p className={styles.accessError} role="alert">
            تعذر حفظ/تدوير رمز الوصول. جرّب رمزًا جديدًا غير مستخدم، ثم أعد
            المحاولة.
          </p>
        )}
      </section>

      <section className={styles.metrics} aria-label="مؤشرات التشغيل">
        {canDispatch && <article><span>الطلبات المستلمة</span><strong>{jobs.length}</strong></article>}
        {canDispatch && <article><span>بانتظار التوزيع</span><strong>{pendingCount}</strong></article>}
        {canSupport && <article><span>طلبات الدعم المفتوحة</span><strong>{openSupportCount}</strong></article>}
        {canDispatch && <article><span>متوسط التقييم</span><strong>{averageRating}</strong></article>}
      </section>

      {isAdmin && (
        <section className={styles.tableSection}>
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>تجربة بريدة المضبوطة</p>
              <h2>اعتماد مقدمي الخدمة</h2>
            </div>
            <span className={styles.liveIndicator}>لا يتم التعيين قبل الاعتماد</span>
          </div>
          <div className={styles.table}>
            <form action={registerPilotProvider} className={styles.assignment}>
              <input name="name" aria-label="اسم مقدم الخدمة" placeholder="اسم مقدم الخدمة" required />
              <input name="serviceZone" aria-label="نطاق التغطية" placeholder="نطاق التغطية في بريدة" required />
              <label><input type="checkbox" name="specialties" value="ac-cleaning" /> تنظيف المكيفات</label>
              <label><input type="checkbox" name="specialties" value="upholstery" /> غسيل الكنب والمجالس</label>
              <label><input type="checkbox" name="specialties" value="home-cleaning" /> تنظيف المنازل</label>
              <label><input type="checkbox" name="specialties" value="tank-cleaning" /> تنظيف الخزانات</label>
              <label><input type="checkbox" name="specialties" value="plumbing" /> سباكة وتسربات</label>
              <button type="submit">إضافة للمراجعة</button>
            </form>
            {providers.length === 0 ? (
              <div className={styles.empty}>أضف مقدم خدمة بعد إكمال التحقق خارج النظام؛ لا تحفظ وثائقه أو بياناته الشخصية هنا.</div>
            ) : providers.map((provider) => (
              <article className={styles.job} key={provider.id}>
                <div><span className={styles.jobId}>{provider.id}</span><strong>{provider.name}</strong></div>
                <span>{provider.serviceZone}</span>
                <span>{provider.specialties.join(' · ')}</span>
                <span className={styles.status}>{provider.verificationStatus === 'verified' ? 'معتمد وجاهز للتعيين' : provider.verificationStatus === 'pending' ? 'بانتظار الاعتماد' : 'موقوف'}</span>
                {provider.verificationStatus === 'pending' && (
                  <form action={verifyPilotProvider} className={styles.assignment}>
                    <input name="providerId" type="hidden" value={provider.id} />
                    <button type="submit">اعتماد مقدم الخدمة</button>
                  </form>
                )}
                {provider.verificationStatus === 'verified' && (
                  <>
                    <form action={setProviderAccessCode} className={styles.assignment}>
                      <input name="providerId" type="hidden" value={provider.id} />
                      <input
                        name="accessCode"
                        type="password"
                        autoComplete="new-password"
                        minLength={16}
                        aria-label={`رمز وصول تطبيق مقدم الخدمة لـ ${provider.name}`}
                        placeholder="رمز وصول تطبيق مقدم الخدمة (16+ حرفًا)"
                        required
                      />
                      <button type="submit">حفظ/تدوير رمز التطبيق</button>
                    </form>
                    <p className={styles.accessCodeHint}>
                      أرسل الرمز لمقدم الخدمة عبر قناة آمنة. لا يظهر أو يُحفظ في لوحة التشغيل.
                    </p>
                    <form action={suspendPilotProvider} className={styles.assignment}>
                      <input name="providerId" type="hidden" value={provider.id} />
                      <button type="submit">إيقاف التعيين مؤقتًا</button>
                    </form>
                  </>
                )}
                {provider.verificationStatus === 'suspended' && (
                  <form action={reactivatePilotProvider} className={styles.assignment}>
                    <input name="providerId" type="hidden" value={provider.id} />
                    <button type="submit">إعادة التفعيل بعد المراجعة</button>
                  </form>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {canDispatch && (
        <section className={styles.tableSection}>
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>التشغيل</p>
              <h2>أحدث الطلبات</h2>
            </div>
            <span className={styles.liveIndicator}>بيانات مباشرة من النظام</span>
          </div>
          <div className={styles.table}>
            {jobs.length === 0 ? (
              <div className={styles.empty}>لا توجد طلبات مستلمة بعد.</div>
            ) : (
              jobs.map((job) => (
                <article className={styles.job} key={job.id}>
                  <div><span className={styles.jobId}>{job.id}</span><strong>{job.service}</strong></div>
                  <span>{job.area}</span>
                  <span>{job.provider}</span>
                  <span className={styles.status}>{job.status}</span>
                  {job.rating !== undefined && (
                    <span title={job.ratingComment ?? 'بدون تعليق'}>★ {job.rating}/5</span>
                  )}
                  {job.quote && (
                    <div className={styles.quote}>
                      <strong>عرض السعر: {(job.quote.amountHalalas / 100).toFixed(2)} ر.س</strong>
                      <span>{job.quote.scope}</span>
                      <span className={job.quote.status === 'approved' ? styles.quoteApproved : job.quote.status === 'rejected' ? styles.quoteRejected : styles.quotePending}>
                        {job.quote.status === 'approved'
                          ? 'وافق العميل على العرض'
                          : job.quote.status === 'rejected'
                            ? 'رفض العميل العرض'
                            : 'بانتظار موافقة العميل'}
                      </span>
                    </div>
                  )}
                  {job.payment && (
                    <div className={styles.payment}>
                      <strong>
                        تحصيل نقدي: {(job.payment.amountHalalas / 100).toFixed(2)} ر.س
                      </strong>
                      <span
                        className={
                          job.payment.status === 'cash_collected'
                            ? styles.paymentCollected
                            : job.payment.status === 'refunded'
                              ? styles.paymentRefunded
                              : styles.paymentDue
                        }
                      >
                        {job.payment.status === 'cash_collected'
                          ? 'تم استلام المبلغ'
                          : job.payment.status === 'refunded'
                            ? 'تمت إعادة كامل المبلغ نقدًا'
                            : 'مبلغ نقدي مستحق عند إتمام الخدمة'}
                      </span>
                      {job.status === 'مكتمل' &&
                        job.payment.status === 'cash_due' && (
                          <form action={collectCashPayment} className={styles.assignment}>
                            <input name="requestId" type="hidden" value={job.id} />
                            <button type="submit">تأكيد استلام النقد</button>
                          </form>
                        )}
                      {isAdmin && job.payment.status === 'cash_collected' && (
                        <>
                          <p className={styles.paymentHint}>
                            سجّل الإعادة فقط بعد تسليم كامل المبلغ للعميل فعليًا.
                          </p>
                          <form action={refundCashPayment} className={styles.assignment}>
                            <input name="requestId" type="hidden" value={job.id} />
                            <button type="submit">تأكيد إعادة النقد</button>
                          </form>
                        </>
                      )}
                    </div>
                  )}
                  {['تم التعيين', 'الفني في الطريق'].includes(job.status) &&
                    (!job.quote || job.quote.status === 'rejected') && (
                    <form action={proposeQuote} className={styles.quoteForm}>
                      <input name="requestId" type="hidden" value={job.id} />
                      <input
                        aria-label={`مبلغ عرض السعر للطلب ${job.id} بالريال السعودي`}
                        name="amountSar"
                        type="number"
                        inputMode="decimal"
                        min="1"
                        step="0.01"
                        placeholder="المبلغ بالريال"
                        required
                      />
                      <input
                        aria-label={`وصف عرض السعر للطلب ${job.id}`}
                        name="scope"
                        minLength={3}
                        placeholder="وصف العمل المشمول"
                        required
                      />
                      <button type="submit">
                        {job.quote?.status === 'rejected' ? 'إرسال عرض بديل' : 'إرسال عرض السعر'}
                      </button>
                    </form>
                  )}
                  {(eventsByRequest.get(job.id)?.length ?? 0) > 0 && (
                    <details className={styles.history}>
                      <summary>سجل مراحل الطلب</summary>
                      <ol>
                        {(eventsByRequest.get(job.id) ?? []).map((event) => (
                          <li key={`${event.type}-${event.createdAt}`}>
                            <span>{requestEventLabel(event)}</span>
                            <time dateTime={event.createdAt}>
                              {new Intl.DateTimeFormat('ar-SA', {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              }).format(new Date(event.createdAt))}
                            </time>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {job.status === 'بانتظار التوزيع' && (
                    <form action={assignProvider} className={styles.assignment}>
                      <input name="requestId" type="hidden" value={job.id} />
                      <select aria-label={`تعيين فني للطلب ${job.id}`} name="providerId" required>
                        <option value="">اختر فنيًا</option>
                        {providers
                          .filter(
                            (provider) =>
                              provider.available &&
                              provider.specialties.includes(job.serviceId),
                          )
                          .map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                      </select>
                      <button type="submit">تعيين فني</button>
                    </form>
                  )}
                  {(job.status === 'تم التعيين' ||
                    (job.status === 'الفني في الطريق' &&
                      !['proposed', 'rejected'].includes(job.quote?.status ?? '')) ||
                    job.status === 'قيد التنفيذ') && (
                    <form action={updateStatus} className={styles.assignment}>
                      <input name="requestId" type="hidden" value={job.id} />
                      {job.status === 'تم التعيين' && <button name="status" value="on_the_way">في الطريق</button>}
                      {job.status === 'الفني في الطريق' && <button name="status" value="in_progress">بدء الخدمة</button>}
                      {job.status === 'قيد التنفيذ' && <button name="status" value="completed">إكمال الخدمة</button>}
                    </form>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      )}

      {canSupport && (
        <section className={styles.tableSection}>
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>دعم العملاء</p>
              <h2>طلبات المساعدة والشكاوى</h2>
            </div>
            <span className={styles.liveIndicator}>{openSupportCount} تحتاج متابعة</span>
          </div>
          <div className={styles.table}>
            {supportTickets.length === 0 ? (
              <div className={styles.empty}>لا توجد طلبات دعم حالياً.</div>
            ) : supportTickets.map((ticket) => (
              <article className={styles.job} key={ticket.id}>
                <div><span className={styles.jobId}>{ticket.id}</span><strong>{ticket.category}</strong></div>
                <span>الطلب: {ticket.requestId}</span>
                <span>{ticket.comment}</span>
                <span className={styles.status}>{ticket.status}</span>
                {ticket.status !== 'تم الحل' && (
                  <form action={updateSupportTicketStatus} className={styles.assignment}>
                    <input name="ticketId" type="hidden" value={ticket.id} />
                    {ticket.status === 'جديد' && <button name="status" value="in_progress">بدء المتابعة</button>}
                    {ticket.status === 'قيد المتابعة' && <button name="status" value="resolved">تم الحل</button>}
                  </form>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {canViewAudit && (
        <section className={styles.tableSection}>
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>الأمان والتدقيق</p>
              <h2>آخر الإجراءات التشغيلية</h2>
            </div>
            <span className={styles.liveIndicator}>للمدير فقط</span>
          </div>
          <div className={styles.table}>
            {auditEvents.length === 0 ? (
              <div className={styles.empty}>لا توجد أحداث تدقيق بعد.</div>
            ) : auditEvents.map((event) => (
              <article className={styles.job} key={event.id}>
                <div><span className={styles.jobId}>{event.subjectId}</span><strong>{event.action}</strong></div>
                <span>{event.actorName}</span>
                <span>{event.oldStatus ?? '—'} ← {event.newStatus ?? '—'}</span>
                <span>{new Intl.DateTimeFormat('ar-SA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.createdAt))}</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
