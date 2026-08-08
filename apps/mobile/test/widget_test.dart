import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/main.dart';

void main() {
  testWidgets('starts with Saudi mobile sign-in', (tester) async {
    await tester.pumpWidget(const MoeenApp());
    expect(find.text('تسجيل الدخول'), findsOneWidget);
    expect(find.text('رقم الجوال'), findsOneWidget);
  });

  test('uses Arabic labels for customer support categories', () {
    expect(supportCategoryLabel('quality'), 'الخدمة غير مرضية');
    expect(supportCategoryLabel('no_show'), 'الفني لم يصل');
  });

  test(
    'reconciles a rating response failure when the refresh shows it persisted',
    () async {
      final recovered = await ratingWasPersistedAfterAmbiguousFailure(
        requestId: 'MOE-1001',
        loadRequests: () async => [
          const CustomerRequest(
            id: 'MOE-1001',
            serviceId: 'ac-cleaning',
            status: 'completed',
            rating: 5,
          ),
        ],
      );

      expect(recovered, isTrue);
    },
  );

  test('shows a proposed customer quote with its Saudi Riyal amount', () {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-1042',
      'serviceId': 'plumbing',
      'status': 'on_the_way',
      'quote': {
        'id': 'QTE-7',
        'amountHalalas': 15000,
        'scope': 'إصلاح تسرب تحت المغسلة',
        'status': 'proposed',
      },
    });

    expect(request.quote?.id, 'QTE-7');
    expect(request.quote?.amountHalalas, 15000);
    expect(request.quote?.status, 'proposed');
  });

  test(
    'shows a cash-on-completion payment after a customer approves the quote',
    () {
      final request = CustomerRequest.fromJson({
        'id': 'MOE-1043',
        'serviceId': 'plumbing',
        'status': 'completed',
        'payment': {
          'id': 'PAY-7',
          'amountHalalas': 15000,
          'currency': 'SAR',
          'method': 'cash_on_completion',
          'status': 'cash_due',
          'createdAt': '2026-08-05T01:00:00.000Z',
        },
      });

      expect((request as dynamic).payment?.method, 'cash_on_completion');
      expect((request as dynamic).payment?.status, 'cash_due');
      expect((request as dynamic).payment?.amountHalalas, 15000);
    },
  );

  test(
    'reconciles a quote decision response failure when refresh shows it persisted',
    () async {
      final recovered = await quoteDecisionWasPersistedAfterAmbiguousFailure(
        requestId: 'MOE-1001',
        quoteId: 'QTE-7',
        decision: 'approved',
        loadRequests: () async => [
          const CustomerRequest(
            id: 'MOE-1001',
            serviceId: 'plumbing',
            status: 'on_the_way',
            quote: CustomerQuote(
              id: 'QTE-7',
              amountHalalas: 15000,
              scope: 'إصلاح تسرب تحت المغسلة',
              status: 'approved',
            ),
          ),
        ],
      );

      expect(recovered, isTrue);
    },
  );

  test(
    'reconciles the selected quote from quotes when the legacy quote is a competitor',
    () async {
      final recovered = await quoteDecisionWasPersistedAfterAmbiguousFailure(
        requestId: 'MOE-101',
        quoteId: 'QTE-101',
        decision: 'approved',
        loadRequests: () async => const [
          CustomerRequest(
            id: 'MOE-101',
            serviceId: 'ac-cleaning',
            status: 'assigned',
            quote: CustomerQuote(
              id: 'QTE-102',
              amountHalalas: 12000,
              scope: 'عرض المنافس الأحدث',
              status: 'rejected',
            ),
            quotes: [
              CustomerQuote(
                id: 'QTE-101',
                amountHalalas: 15000,
                scope: 'العرض المختار',
                status: 'approved',
              ),
              CustomerQuote(
                id: 'QTE-102',
                amountHalalas: 12000,
                scope: 'عرض المنافس الأحدث',
                status: 'rejected',
              ),
            ],
          ),
        ],
      );

      expect(recovered, isTrue);
    },
  );

  test(
    'reconciles a quote decision from the legacy singular quote when quotes are absent',
    () async {
      final recovered = await quoteDecisionWasPersistedAfterAmbiguousFailure(
        requestId: 'MOE-102',
        quoteId: 'QTE-103',
        decision: 'rejected',
        loadRequests: () async => const [
          CustomerRequest(
            id: 'MOE-102',
            serviceId: 'plumbing',
            status: 'pending_dispatch',
            quote: CustomerQuote(
              id: 'QTE-103',
              amountHalalas: 10000,
              scope: 'عرض قديم منفرد',
              status: 'rejected',
            ),
          ),
        ],
      );

      expect(recovered, isTrue);
    },
  );

  test('treats every 2xx quote decision response as successful', () {
    expect(isSuccessfulHttpStatus(200), isTrue);
    expect(isSuccessfulHttpStatus(201), isTrue);
    expect(isSuccessfulHttpStatus(299), isTrue);
    expect(isSuccessfulHttpStatus(199), isFalse);
    expect(isSuccessfulHttpStatus(300), isFalse);
    expect(isSuccessfulHttpStatus(409), isFalse);
    expect(isSuccessfulHttpStatus(500), isFalse);
  });

  testWidgets('shows every Moeen launch service in Arabic', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: MoeenHomePage(),
        ),
      ),
    );

    expect(find.text('معين'), findsOneWidget);
    expect(find.text('تنظيف المكيفات'), findsOneWidget);
    expect(find.text('غسيل الكنب والمجالس'), findsOneWidget);

    await tester.scrollUntilVisible(find.text('سباكة وتسربات'), 200);

    expect(find.text('تنظيف المنازل'), findsOneWidget);
    expect(find.text('تنظيف الخزانات'), findsOneWidget);
    expect(find.text('سباكة وتسربات'), findsOneWidget);
  });

  testWidgets(
    'renders a request with all available actions without a layout overflow',
    (tester) async {
      const request = CustomerRequest(
        id: 'MOE-1050',
        serviceId: 'plumbing',
        status: 'completed',
        quote: CustomerQuote(
          id: 'QTE-50',
          amountHalalas: 15000,
          scope: 'إصلاح تسرب تحت المغسلة',
          status: 'proposed',
        ),
        payment: CustomerPayment(
          id: 'PAY-50',
          amountHalalas: 15000,
          currency: 'SAR',
          method: 'cash_on_completion',
          status: 'cash_due',
        ),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Directionality(
            textDirection: TextDirection.rtl,
            child: CustomerRequestCard(
              request: request,
              statusLabel: 'مكتمل',
              onReviewQuote: () {},
              onRate: () {},
              onSupport: () {},
            ),
          ),
        ),
      );

      expect(find.text('مراجعة العرض'), findsOneWidget);
      expect(find.text('قيّم الخدمة'), findsOneWidget);
      expect(find.text('تحتاج مساعدة؟'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  test('CustomerRequest.fromJson parses the quotes array with mixed statuses', () {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-2001',
      'serviceId': 'ac-cleaning',
      'status': 'pending_dispatch',
      'quotes': [
        {
          'id': 'QTE-10',
          'amountHalalas': 15000,
          'scope': 'عرض أ',
          'status': 'proposed',
        },
        {
          'id': 'QTE-11',
          'amountHalalas': 12000,
          'scope': 'عرض ب',
          'status': 'rejected',
        },
      ],
    });

    expect(request.quotes, hasLength(2));
    expect(request.quotes[0].status, 'proposed');
    expect(request.quotes[1].status, 'rejected');
  });

  test(
      'CustomerRequest.fromJson falls back to empty quotes when array is absent',
      () {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-2002',
      'serviceId': 'plumbing',
      'status': 'pending_dispatch',
      'quote': {
        'id': 'QTE-9',
        'amountHalalas': 10000,
        'scope': 'عرض فردي',
        'status': 'proposed',
      },
    });

    expect(request.quotes, isEmpty);
    expect(request.quote, isNotNull);
    expect(request.quote!.status, 'proposed');
  });

  test('legacy singular quote field is preserved alongside quotes', () {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-2003',
      'serviceId': 'ac-cleaning',
      'status': 'pending_dispatch',
      'quote': {
        'id': 'QTE-5',
        'amountHalalas': 18000,
        'scope': 'تنظيف مكيفين',
        'status': 'proposed',
      },
      'quotes': [
        {
          'id': 'QTE-5',
          'amountHalalas': 18000,
          'scope': 'تنظيف مكيفين',
          'status': 'proposed',
        },
        {
          'id': 'QTE-6',
          'amountHalalas': 13000,
          'scope': 'تنظيف سريع',
          'status': 'proposed',
        },
      ],
    });

    expect(request.quote, isNotNull);
    expect(request.quotes, hasLength(2));
  });

  test('CustomerQuote.fromJson parses providerSummary defensively', () {
    final quote = CustomerQuote.fromJson({
      'id': 'QTE-30',
      'amountHalalas': 15000,
      'scope': 'تنظيف كامل',
      'status': 'proposed',
      'providerSummary': {
        'name': 'فريق التبريد السريع',
        'averageRating': 4.5,
        'ratingCount': 12,
      },
    });

    expect(quote.providerSummary?.name, 'فريق التبريد السريع');
    expect(quote.providerSummary?.averageRating, 4.5);
    expect(quote.providerSummary?.ratingCount, 12);
  });

  test('CustomerQuote.fromJson tolerates a missing providerSummary', () {
    final quote = CustomerQuote.fromJson({
      'id': 'QTE-31',
      'amountHalalas': 12000,
      'scope': 'تنظيف سريع',
      'status': 'proposed',
    });

    expect(quote.providerSummary, isNull);
    expect(quote.status, 'proposed');
  });

  testWidgets('renders provider name and rating summary per quote', (
    tester,
  ) async {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-3001',
      'serviceId': 'ac-cleaning',
      'status': 'pending_dispatch',
      'quotes': [
        {
          'id': 'QTE-32',
          'amountHalalas': 15000,
          'scope': 'تنظيف كامل',
          'status': 'proposed',
          'providerSummary': {
            'name': 'فريق التبريد السريع',
            'averageRating': 4.5,
            'ratingCount': 12,
          },
        },
      ],
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: CustomerRequestCard(
            request: request,
            statusLabel: 'بانتظار القبول',
            onReviewQuote: () {},
            onRate: () {},
            onSupport: () {},
          ),
        ),
      ),
    );

    expect(find.text('فريق التبريد السريع'), findsOneWidget);
    expect(find.text('4.5 ★ (12)'), findsOneWidget);
    expect(find.textContaining('150.00 ر.س'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('unrated provider renders name without a fake rating', (
    tester,
  ) async {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-3002',
      'serviceId': 'ac-cleaning',
      'status': 'pending_dispatch',
      'quotes': [
        {
          'id': 'QTE-33',
          'amountHalalas': 12000,
          'scope': 'تنظيف سريع',
          'status': 'proposed',
          'providerSummary': {'name': 'مقدم جديد', 'ratingCount': 0},
        },
      ],
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: CustomerRequestCard(
            request: request,
            statusLabel: 'بانتظار القبول',
            onReviewQuote: () {},
            onRate: () {},
            onSupport: () {},
          ),
        ),
      ),
    );

    expect(find.text('مقدم جديد'), findsOneWidget);
    expect(find.textContaining('★'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('legacy quote payload without providerSummary renders safely', (
    tester,
  ) async {
    final request = CustomerRequest.fromJson({
      'id': 'MOE-3003',
      'serviceId': 'ac-cleaning',
      'status': 'pending_dispatch',
      'quotes': [
        {
          'id': 'QTE-34',
          'amountHalalas': 10000,
          'scope': 'تنظيف أساسي',
          'status': 'proposed',
        },
      ],
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: CustomerRequestCard(
            request: request,
            statusLabel: 'بانتظار القبول',
            onReviewQuote: () {},
            onRate: () {},
            onSupport: () {},
          ),
        ),
      ),
    );

    expect(find.textContaining('تنظيف أساسي'), findsOneWidget);
    expect(find.textContaining('★'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
