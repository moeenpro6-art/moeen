import 'package:flutter_test/flutter_test.dart';
import 'package:moeen_mobile/customer_notifications.dart';

void main() {
  test('customer notification parsing ignores location data', () {
    final intent = parseCustomerNotificationIntent({
      'type': 'request_created',
      'requestId': 'MOE-1001',
      'navigate': 'customer_request_detail',
      'eventId': 'evt-1',
      'v': '1',
      'location': '{"point":{"latitude":26.359123,"longitude":43.981988}}',
      'displayAddress': 'حي الصفراء، بريدة',
    });

    expect(intent, isNotNull);
    expect(intent!.requestId, 'MOE-1001');
    expect(intent.type, CustomerNotificationType.requestCreated);
    // CustomerNotificationIntent has no location/address member. The parser
    // reads only the approved FCM fields above and drops this extra data.
    expect(customerNotificationSummary(intent), isNot(contains('الصفراء')));
    expect(customerNotificationSummary(intent), isNot(contains('26.359123')));
  });
}
