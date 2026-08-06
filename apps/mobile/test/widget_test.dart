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
}
