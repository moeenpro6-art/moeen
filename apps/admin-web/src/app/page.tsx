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
import RequestImagesGallery from './request-images-gallery';
import ProviderTrackingPanel from './provider-tracking-panel';
import { ProviderTrackingSlot } from './provider-tracking-slot';
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

/**
 * Distinguishes a legitimate empty list from a load failure so the
 * dashboard never presents API failures as successful empty data.
 */
type ListResult<T> = { ok: true; items: T[] } | { ok: false; items: never[] };

async function getServiceRequests(
  token: string,
): Promise<ListResult<DashboardRequest>> {
  try {
    const response = await dashboardApiFetch('/service-requests', token);
    if (!response.ok) return { ok: false, items: [] };
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return { ok: false, items: [] };
    return {
      ok: true,
      items: data.filter(isApiServiceRequest).map(toDashboardRequest).reverse(),
    };
  } catch {
    return { ok: false, items: [] };
  }
}

async function getServiceRequestEvents(
  token: string,
  requestId: string,
): Promise<ListResult<ApiServiceRequestEvent>> {
  try {
    const response = await dashboardApiFetch(
      `/service-requests/${requestId}/history`,
      token,
    );
    if (!response.ok) return { ok: false, items: [] };
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return { ok: false, items: [] };
    return { ok: true, items: data.filter(isApiServiceRequestEvent) };
  } catch {
    return { ok: false, items: [] };
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

async function getProviders(token: string): Promise<ListResult<Provider>> {
  try {
    const response = await dashboardApiFetch('/providers', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return { ok: false, items: [] };
    return {
      ok: true,
      items: data.filter((value): value is Provider =>
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
      ),
    };
  } catch {
    return { ok: false, items: [] };
  }
}

async function getSupportTickets(
  token: string,
): Promise<ListResult<DashboardSupportTicket>> {
  try {
    const response = await dashboardApiFetch('/support-tickets', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return { ok: false, items: [] };
    return {
      ok: true,
      items: data.filter(isApiSupportTicket).map(toDashboardSupportTicket),
    };
  } catch {
    return { ok: false, items: [] };
  }
}

async function getAuditEvents(token: string): Promise<ListResult<DashboardAuditEvent>> {
  try {
    const response = await dashboardApiFetch('/admin/audit-events', token);
    const data: unknown = await response.json();
    if (!response.ok || !Array.isArray(data)) return { ok: false, items: [] };
    return {
      ok: true,
      items: data.filter(isApiAuditEvent).map(toDashboardAuditEvent),
    };
  } catch {
    return { ok: false, items: [] };
  }
}

/** Arabic parts describing the marketplace opportunity state for one request. */
function marketplaceSummaryParts(
  opportunities: DashboardRequest['opportunities'],
): string[] {
  if (!opportunities) return [];
  const parts: string[] = [];
  if (opportunities.invited > 0) parts.push(`${opportunities.invited} مدعو`);
  if (opportunities.quoted > 0) parts.push(`${opportunities.quoted} عرض مقدم`);
  if (opportunities.withdrawn > 0) parts.push(`${opportunities.withdrawn} منسحب`);
  if (opportunities.closed > 0) parts.push(`${opportunities.closed} مغلق`);
  if (opportunities.rejected > 0) parts.push(`${opportunities.rejected} مرفوض`);
  return parts;
}

const roleLabels = {
  admin: 'مدير النظام',
  dispatcher: 'موظف التشغيل',
  support_agent: 'موظف الدعم',
};

function requestStatusTone(status: string): string {
  if (status === 'بانتظار التوزيع') return styles.statusWarning;
  if (['تم التعيين', 'الفني في الطريق', 'قيد التنفيذ'].includes(status)) {
    return styles.statusInfo;
  }
  if (status === 'مكتمل') return styles.statusSuccess;
  if (status === 'ملغي') return styles.statusDanger;
  return styles.statusNeutral;
}

function supportStatusTone(status: string): string {
  if (status === 'جديد') return styles.statusWarning;
  if (status === 'قيد المتابعة') return styles.statusInfo;
  if (status === 'تم الحل') return styles.statusSuccess;
  return styles.statusNeutral;
}

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
  const [jobsResult, providersResult, supportTicketsResult, auditEventsResult] =
    await Promise.all([
      canDispatch ? getServiceRequests(token) : Promise.resolve({ ok: true, items: [] }),
      canDispatch ? getProviders(token) : Promise.resolve({ ok: true, items: [] }),
      canSupport
        ? getSupportTickets(token)
        : Promise.resolve({ ok: true, items: [] }),
      canViewAudit
        ? getAuditEvents(token)
        : Promise.resolve({ ok: true, items: [] }),
    ]);
  const jobs = jobsResult.ok ? jobsResult.items : [];
  const providers = providersResult.ok ? providersResult.items : [];
  const supportTickets = supportTicketsResult.ok
    ? supportTicketsResult.items
    : [];
  const auditEvents = auditEventsResult.ok ? auditEventsResult.items : [];
  const requestEventLists = await Promise.all(
    jobs.map(async (job) => ({
      requestId: job.id,
      events: await getServiceRequestEvents(token, job.id),
    })),
  );
  const eventsResultByRequest = new Map(
    requestEventLists.map(({ requestId, events }) => [requestId, events]),
  );
  const pendingCount = jobsResult.ok
    ? jobs.filter((job) => job.status === 'بانتظار التوزيع').length
    : null;
  const openSupportCount = supportTicketsResult.ok
    ? supportTickets.filter((ticket) => ticket.status !== 'تم الحل').length
    : null;
  const ratedJobs = jobs.filter((job) => typeof job.rating === 'number');
  const averageRating =
    !jobsResult.ok || ratedJobs.length === 0
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
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="التنقل الرئيسي">
        <div className={styles.brandBlock}>
          <span className={styles.brandMark} aria-hidden="true">م</span>
          <div>
            <strong>معين</strong>
            <span>لوحة العمليات</span>
          </div>
        </div>

        <div className={styles.staffCard}>
          <span className={styles.avatar} aria-hidden="true">
            {staff.displayName.slice(0, 1)}
          </span>
          <div>
            <strong>{staff.displayName}</strong>
            <span>{roleLabels[staff.role]}</span>
          </div>
        </div>

        <nav className={styles.navigation} aria-label="أقسام لوحة العمليات">
          <a className={styles.activeNav} href="#overview">نظرة عامة</a>
          {isAdmin && <a href="#providers">مقدمو الخدمة</a>}
          {canDispatch && <a href="#requests">الطلبات</a>}
          {canSupport && <a href="#support">الدعم</a>}
          {canViewAudit && <a href="#audit">سجل التدقيق</a>}
        </nav>

        <div className={styles.sidebarFooter}>
          <span>مركز عمليات بريدة</span>
          <form action={logoutStaffAction}>
            <button className={styles.logoutButton} type="submit">
              تسجيل الخروج
            </button>
          </form>
        </div>
      </aside>

      <main className={styles.page}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>لوحة التشغيل · بريدة، القصيم</p>
            <h1>صباح الخير، {staff.displayName}</h1>
            <p className={styles.headerDescription}>
              تابع سير الطلبات، التوزيع، ودعم العملاء من مساحة عمل واحدة.
            </p>
          </div>
          <div className={styles.headerMeta}>
            <span className={styles.liveIndicator}>النظام متصل</span>
            <span className={styles.roleChip}>{roleLabels[staff.role]}</span>
          </div>
        </header>

        <section className={styles.hero} id="overview" aria-labelledby="overview-title">
          <div>
            <p className={styles.heroEyebrow}>ملخص اليوم</p>
            <h2 id="overview-title">كل التفاصيل التشغيلية، بوضوح وسرعة.</h2>
            <p>
              تظهر لك المهام المسموح بها وفق صلاحية حسابك، مع مؤشرات مباشرة تساعدك على ترتيب الأولويات.
            </p>
          </div>
          <div className={styles.heroAccent} aria-hidden="true">
            <span>تشغيل</span>
            <strong>مركّز</strong>
          </div>
          {error === 'forbidden' && (
            <p className={styles.accessError} role="alert">
              ليس لديك صلاحية لتنفيذ هذا الإجراء.
            </p>
          )}
          {error === 'rotation' && (
            <p className={styles.accessError} role="alert">
              تعذر حفظ/تدوير رمز الوصول. جرّب رمزًا جديدًا غير مستخدم، ثم أعد المحاولة.
            </p>
          )}
        </section>

        <section className={styles.metrics} aria-label="مؤشرات التشغيل">
        {canDispatch && <article><span>الطلبات المستلمة</span><strong>{jobsResult.ok ? jobs.length : '—'}</strong></article>}
        {canDispatch && <article><span>بانتظار التوزيع</span><strong>{pendingCount === null ? '—' : pendingCount}</strong></article>}
        {canSupport && <article><span>طلبات الدعم المفتوحة</span><strong>{openSupportCount === null ? '—' : openSupportCount}</strong></article>}
        {canDispatch && <article><span>متوسط التقييم</span><strong>{averageRating}</strong></article>}
      </section>

      {isAdmin && (
        <section className={styles.tableSection} id="providers">
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
            {!providersResult.ok && (
              <div className={styles.loadError} role="alert">
                تعذر تحميل قائمة مقدمي الخدمة؛ لا تظهر البيانات حاليًا. أعد المحاولة
                بعد قليل.
              </div>
            )}
            {providersResult.ok && providers.length === 0 ? (
              <div className={styles.empty}>أضف مقدم خدمة بعد إكمال التحقق خارج النظام؛ لا تحفظ وثائقه أو بياناته الشخصية هنا.</div>
            ) : providersResult.ok ? (
              providers.map((provider) => (
              <article className={styles.job} key={provider.id}>
                <div><span className={styles.jobId}>{provider.id}</span><strong>{provider.name}</strong></div>
                <span>{provider.serviceZone}</span>
                <span>{provider.specialties.join(' · ')}</span>
                <span
                  className={`${styles.status} ${
                    provider.verificationStatus === 'verified'
                      ? styles.statusSuccess
                      : provider.verificationStatus === 'pending'
                        ? styles.statusWarning
                        : styles.statusDanger
                  }`}
                >
                  {provider.verificationStatus === 'verified'
                    ? 'معتمد وجاهز للتعيين'
                    : provider.verificationStatus === 'pending'
                      ? 'بانتظار الاعتماد'
                      : 'موقوف'}
                </span>
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
              ))
            ) : null}
          </div>
        </section>
      )}

      {canDispatch && (
        <section className={styles.tableSection} id="requests">
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>التشغيل</p>
              <h2>أحدث الطلبات</h2>
            </div>
            <span className={styles.liveIndicator}>بيانات مباشرة من النظام</span>
          </div>
          <div className={`${styles.table} ${styles.operationsTable}`}>
            <div className={styles.tableHeader} aria-hidden="true">
              <span>الطلب</span>
              <span>الموقع</span>
              <span>مقدم الخدمة</span>
              <span>الحالة</span>
              <span>التقييم</span>
            </div>
            {!jobsResult.ok && (
              <div className={styles.loadError} role="alert">
                تعذر تحميل الطلبات؛ لا تظهر البيانات حاليًا. أعد المحاولة بعد
                قليل.
              </div>
            )}
            {jobsResult.ok && jobs.length === 0 ? (
              <div className={styles.empty}>لا توجد طلبات مستلمة بعد.</div>
            ) : jobsResult.ok ? (
              jobs.map((job) => {
                const marketplaceParts = marketplaceSummaryParts(
                  job.opportunities,
                );
                const openMarketplaceActivity =
                  (job.opportunities?.invited ?? 0) +
                    (job.opportunities?.quoted ?? 0) >
                  0;
                const eligibleProviders = providers.filter(
                  (provider) =>
                    provider.verificationStatus === 'verified' &&
                    provider.available &&
                    provider.specialties.includes(job.serviceId),
                );
                return (
                <article className={styles.requestRow} key={job.id}>
                  <div className={styles.requestSummary}>
                    <div className={`${styles.requestCell} ${styles.requestPrimary}`}>
                      <span className={styles.cellLabel}>الطلب</span>
                      <span className={styles.jobId}>{job.id}</span>
                      <strong>{job.service}</strong>
                    </div>
                    <div className={styles.requestCell}>
                      <span className={styles.cellLabel}>الموقع</span>
                      <span>{job.area}</span>
                    </div>
                    <div className={styles.requestCell}>
                      <span className={styles.cellLabel}>مقدم الخدمة</span>
                      <span>{job.provider}</span>
                    </div>
                    <div className={styles.requestCell}>
                      <span className={styles.cellLabel}>الحالة</span>
                      <span className={`${styles.status} ${requestStatusTone(job.status)}`}>
                        {job.status}
                      </span>
                    </div>
                    <div className={styles.requestActions}>
                      {job.rating !== undefined && (
                        <span className={styles.rating} title={job.ratingComment ?? 'بدون تعليق'}>
                          ★ {job.rating}/5
                        </span>
                      )}
                    </div>
                  </div>

                  <details className={styles.requestDetails}>
                    <summary>
                      <span>التفاصيل والإجراءات</span>
                      <span className={styles.detailsHint}>عرض السعر، الدفع، السوق والسجل</span>
                    </summary>
                    <div className={styles.requestDetailsPanel}>
                  {job.images && job.images.length > 0 && (
                    <RequestImagesGallery images={job.images} />
                  )}
                  <ProviderTrackingSlot
                    role={staff.role}
                    status={job.statusKey}
                    requestId={job.id}
                    serviceLocation={job.serviceLocation}
                    renderPanel={(requestId, serviceLocation) => (
                      <ProviderTrackingPanel
                        requestId={requestId}
                        serviceLocation={serviceLocation}
                      />
                    )}
                  />
                  {job.quote && (
                    <div className={styles.quote}>
                      <strong>
                        {job.quote.providerName
                          ? `عرض مقدم الخدمة (${job.quote.providerName}): ${(job.quote.amountHalalas / 100).toFixed(2)} ر.س`
                          : `عرض السعر: ${(job.quote.amountHalalas / 100).toFixed(2)} ر.س`}
                      </strong>
                      <span>{job.quote.scope}</span>
                      <span className={job.quote.status === 'approved' ? styles.quoteApproved : job.quote.status === 'rejected' ? styles.quoteRejected : job.quote.status === 'withdrawn' ? styles.quoteWithdrawn : styles.quotePending}>
                        {job.quote.status === 'approved'
                          ? 'وافق العميل على العرض'
                          : job.quote.status === 'rejected'
                            ? 'رفض العميل العرض'
                            : job.quote.status === 'withdrawn'
                              ? 'سحب مقدم الخدمة العرض'
                              : 'بانتظار موافقة العميل'}
                      </span>
                    </div>
                  )}
                  {job.opportunities && (
                    <div className={styles.marketplace}>
                      <strong>مسار السوق</strong>
                      <span>
                        {marketplaceParts.length > 0
                          ? marketplaceParts.join(' · ')
                          : 'لا توجد فرص نشطة'}
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
                    job.opportunities ? (
                      <p className={styles.marketplaceNote}>
                        هذا الطلب في مسار عروض السوق؛ لا يمكن إرسال عرض سعر يدوي.
                      </p>
                    ) : (
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
                    )
                  )}
                  {(() => {
                    const eventsResult =
                      eventsResultByRequest.get(job.id) ??
                      ({ ok: false, items: [] } as const);
                    if (!eventsResult.ok) {
                      return (
                        <p className={styles.marketplaceNote}>
                          تعذر تحميل سجل مراحل الطلب.
                        </p>
                      );
                    }
                    return eventsResult.items.length > 0 ? (
                      <details className={styles.history}>
                        <summary>سجل مراحل الطلب</summary>
                        <ol>
                          {eventsResult.items.map((event) => (
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
                    ) : null;
                  })()}
                  {job.status === 'بانتظار التوزيع' && (
                    <div className={styles.assignmentBlock}>
                      {openMarketplaceActivity && (
                        <p className={styles.marketplaceNote}>
                          التعيين اليدوي يغلق عروض السوق الجارية تلقائيًا.
                        </p>
                      )}
                      {eligibleProviders.length === 0 ? (
                        <p className={styles.marketplaceNote}>
                          لا يوجد فني معتمد ومتاح حاليًا لهذه الخدمة.
                        </p>
                      ) : (
                        <form action={assignProvider} className={styles.assignment}>
                          <input name="requestId" type="hidden" value={job.id} />
                          <select aria-label={`تعيين فني للطلب ${job.id}`} name="providerId" required>
                            <option value="">اختر فنيًا</option>
                            {eligibleProviders.map((provider) => (
                              <option key={provider.id} value={provider.id}>{provider.name}</option>
                            ))}
                          </select>
                          <button type="submit">تعيين فني</button>
                        </form>
                      )}
                    </div>
                  )}
                  {/* Operational transitions derive from the CURRENT request
                      status only. A historical marketplace quote (rejected,
                      withdrawn, or still proposed) must never hide the
                      completion path of an active assignment. */}
                  {['تم التعيين',
                    'الفني في الطريق',
                    'قيد التنفيذ'].includes(job.status) && (
                    <form action={updateStatus} className={styles.assignment}>
                      <input name="requestId" type="hidden" value={job.id} />
                      {job.status === 'تم التعيين' && <button name="status" value="on_the_way">في الطريق</button>}
                      {job.status === 'الفني في الطريق' && <button name="status" value="in_progress">بدء الخدمة</button>}
                      {job.status === 'قيد التنفيذ' && <button name="status" value="completed">إكمال الخدمة</button>}
                    </form>
                  )}
                    </div>
                  </details>
                </article>
                );
              })
            ) : null}
          </div>
        </section>
      )}

      {canSupport && (
        <section className={styles.tableSection} id="support">
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>دعم العملاء</p>
              <h2>طلبات المساعدة والشكاوى</h2>
            </div>
            <span className={styles.liveIndicator}>{openSupportCount === null ? '—' : openSupportCount} تحتاج متابعة</span>
          </div>
          <div className={styles.table}>
            {!supportTicketsResult.ok && (
              <div className={styles.loadError} role="alert">
                تعذر تحميل طلبات الدعم؛ لا تظهر البيانات حاليًا. أعد المحاولة بعد
                قليل.
              </div>
            )}
            {supportTicketsResult.ok && supportTickets.length === 0 ? (
              <div className={styles.empty}>لا توجد طلبات دعم حالياً.</div>
            ) : supportTicketsResult.ok ? (
              supportTickets.map((ticket) => (
              <article className={styles.job} key={ticket.id}>
                <div><span className={styles.jobId}>{ticket.id}</span><strong>{ticket.category}</strong></div>
                <span>الطلب: {ticket.requestId}</span>
                <span>{ticket.comment}</span>
                <span className={`${styles.status} ${supportStatusTone(ticket.status)}`}>
                  {ticket.status}
                </span>
                {ticket.status !== 'تم الحل' && (
                  <form action={updateSupportTicketStatus} className={styles.assignment}>
                    <input name="ticketId" type="hidden" value={ticket.id} />
                    {ticket.status === 'جديد' && <button name="status" value="in_progress">بدء المتابعة</button>}
                    {ticket.status === 'قيد المتابعة' && <button name="status" value="resolved">تم الحل</button>}
                  </form>
                )}
              </article>
              ))
            ) : null}
          </div>
        </section>
      )}

      {canViewAudit && (
        <section className={styles.tableSection} id="audit">
          <div className={styles.sectionTitle}>
            <div>
              <p className={styles.eyebrow}>الأمان والتدقيق</p>
              <h2>آخر الإجراءات التشغيلية</h2>
            </div>
            <span className={styles.liveIndicator}>للمدير فقط</span>
          </div>
          <div className={styles.table}>
            {!auditEventsResult.ok && (
              <div className={styles.loadError} role="alert">
                تعذر تحميل أحداث التدقيق؛ لا تظهر البيانات حاليًا. أعد المحاولة
                بعد قليل.
              </div>
            )}
            {auditEventsResult.ok && auditEvents.length === 0 ? (
              <div className={styles.empty}>لا توجد أحداث تدقيق بعد.</div>
            ) : auditEventsResult.ok ? (
              auditEvents.map((event) => (
              <article className={styles.job} key={event.id}>
                <div><span className={styles.jobId}>{event.subjectId}</span><strong>{event.action}</strong></div>
                <span>{event.actorName}</span>
                <span>{event.oldStatus ?? '—'} ← {event.newStatus ?? '—'}</span>
                <span>{new Intl.DateTimeFormat('ar-SA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.createdAt))}</span>
              </article>
              ))
            ) : null}
          </div>
        </section>
      )}
      </main>
    </div>
  );
}
