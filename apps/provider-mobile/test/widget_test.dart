import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_provider/main.dart';

void main() {
  test('provider job parsing preserves a customer-approved quote', () {
    final job = ProviderJob.fromJson({
      'id': 'MOE-1001',
      'serviceId': 'ac-cleaning',
      'address': 'حي الصفراء، بريدة',
      'timing': 'as-soon-as-possible',
      'status': 'on_the_way',
      'quote': {
        'id': 'QTE-1',
        'amountHalalas': 15000,
        'scope': 'تنظيف كامل للمكيف',
        'status': 'approved',
      },
    });

    expect(job.quote?.amountHalalas, 15000);
    expect(job.quote?.status, 'approved');
    expect(nextProviderStatus(job), 'in_progress');
  });

  test(
    'provider cannot start a job while the customer quote is unresolved',
    () {
      final job = ProviderJob.fromJson({
        'id': 'MOE-1002',
        'serviceId': 'plumbing',
        'address': 'حي النهضة، بريدة',
        'timing': 'as-soon-as-possible',
        'status': 'on_the_way',
        'quote': {
          'id': 'QTE-2',
          'amountHalalas': 12000,
          'scope': 'إصلاح تسرب',
          'status': 'proposed',
        },
      });

      expect(nextProviderStatus(job), isNull);
      expect(providerActionLabel(job), 'بانتظار قرار العميل على عرض السعر');
    },
  );
}
